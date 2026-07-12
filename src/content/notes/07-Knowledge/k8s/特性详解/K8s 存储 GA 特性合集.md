---
date: 2026-06-29
tags:
  - k8s
  - 存储
  - PV
  - PVC
  - CSI
type: 学习笔记
category: 云原生/Kubernetes/存储
difficulty: 进阶
title: "K8s 存储 GA 特性合集"
---

# K8s 存储 GA 特性合集（v1.28-1.36）

本文覆盖 K8s 1.28→1.36 期间达到 GA 的存储相关特性，按影响力排序。每个特性含背景、字段、YAML 示例。

## 特性总览

| # | 特性 | GA 版本 | 核心价值 |
|---|------|---------|----------|
| 1 | ReadWriteOncePod | v1.29 | 单 Pod 独占卷，防脑裂写入 |
| 2 | StatefulSet PVC 自动清理 | v1.32 | 删 StatefulSet 时自动回收 PVC |
| 3 | 卷组快照 | v1.36 | 多 PVC 一致性快照 |
| 4 | VolumeAttributesClass | v1.34 | 在线修改卷 IO/吞吐参数 |
| 5 | OCI 卷源 | v1.36 | OCI 镜像直接挂载为卷 |
| 6 | SELinux 卷标签加速 | v1.36 | `mount -o context` 替代递归重标记 |
| 7 | 可变卷挂载限制 | v1.36 | CSI 驱动动态更新节点最大卷数 |

---

## 1. ReadWriteOncePod（v1.29 GA）

**解决的问题**：`ReadWriteOnce` 允许**同一节点的多个 Pod** 同时挂载同一个卷，可能导致并行写入数据损坏。

**ReadWriteOncePod** 严格限制**一个卷同一时刻只能被一个 Pod 使用**。

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: exclusive-data
spec:
  accessModes:
    - ReadWriteOncePod         # ← 单 Pod 独占
  resources:
    requests:
      storage: 10Gi
  storageClassName: fast-ssd
```

| accessMode | 单节点独占？ | 单 Pod 独占？ | 典型场景 |
|-----------|:---:|:---:|------|
| `ReadWriteOnce` | ✅ | ❌ | 普通应用 |
| `ReadWriteOncePod` | ✅ | ✅ | 数据库、单写者 |
| `ReadOnlyMany` | — | — | 共享配置 |
| `ReadWriteMany` | — | — | 共享存储 |

**运维影响**：StatefulSet 中每个 Pod 有独立 PVC，天然满足 ReadWriteOncePod 约束。Deployment 多副本需独立 PVC 或改用 RWO。

---

## 2. StatefulSet PVC 自动清理（v1.32 GA）

**解决的问题**：删除 StatefulSet 后 PVC 仍残留，需手动清理，容易造成存储泄漏。

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-cluster
spec:
  persistentVolumeClaimRetentionPolicy:    # v1.32 GA
    whenDeleted: Delete                    # 删 StatefulSet → 删 PVC
    whenScaled: Retain                     # 缩容 → 保留 PVC（可后续恢复数据）
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 100Gi
```

| 字段 | 选项 | 含义 |
|------|------|------|
| `whenDeleted` | `Delete` / `Retain` | 删除 StatefulSet 时 PVC 的行为 |
| `whenScaled` | `Delete` / `Retain` | 缩容时多余 PVC 的行为 |

**运维建议**：
- 测试环境：`whenDeleted: Delete, whenScaled: Delete`（自动清理）
- 生产数据库：`whenDeleted: Retain, whenScaled: Retain`（防误删）

---

## 3. 卷组快照 VolumeGroupSnapshot（v1.36 GA）

**解决的问题**：数据库往往跨多个 PVC（数据 + 日志 + 配置），单独快照会导致恢复时不一致。

```yaml
# 创建一个卷组快照
apiVersion: groupsnapshot.storage.k8s.io/v1
kind: VolumeGroupSnapshot
metadata:
  name: db-snapshot-20260629
spec:
  source:
    selector:
      matchLabels:
        app: postgres                # 匹配所有含此标签的 PVC
  volumeGroupSnapshotClassName: csi-group-snap
```

```yaml
# 从卷组快照恢复
apiVersion: groupsnapshot.storage.k8s.io/v1
kind: VolumeGroupSnapshotContent
# ...（通常由 CSI 驱动自动创建）

# 恢复：逐个 PVC 从对应 VolumeSnapshot 恢复
# 所有 PVC 的恢复时间点一致（崩溃一致性）
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
spec:
  dataSource:
    name: db-snapshot-20260629-data   # 从组快照的 data 卷恢复
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 100Gi
```

**与单卷快照对比**：

| 维度 | VolumeSnapshot | VolumeGroupSnapshot |
|------|:---:|:---:|
| 原子性 | 单卷 | 多卷崩溃一致 |
| 典型场景 | 单 PVC 应用 | 数据库（data + WAL + config） |
| CSI 驱动要求 | 所有主流驱动 | 仅部分驱动支持（需查 CSI 能力） |

---

## 4. VolumeAttributesClass（v1.34 GA）

**解决的问题**：修改存储性能参数（IOPS、吞吐、介质类型）需要重建 PVC。

```yaml
# 定义两种卷属性类
apiVersion: storage.k8s.io/v1
kind: VolumeAttributesClass
metadata:
  name: standard-io
driverName: ebs.csi.aws.com
parameters:
  iops: "3000"
  throughput: "125"
---
apiVersion: storage.k8s.io/v1
kind: VolumeAttributesClass
metadata:
  name: high-io
driverName: ebs.csi.aws.com
parameters:
  iops: "10000"
  throughput: "500"
```

```yaml
# PVC 引用属性类
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: db-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 500Gi
  volumeAttributesClassName: standard-io   # 初始为标准 IO
---
# 在线升级为高性能 IO（不改 PVC spec，通过修改 volumeAttributesClassName）
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: db-data
spec:
  volumeAttributesClassName: high-io       # 在线切换！
```

**运维价值**：数据库高峰期切高 IO、低峰期切回节省成本，无需停机。

---

## 5. OCI 卷源（v1.36 GA）

**解决的问题**：大量静态文件（ML 模型、前端资源、配置包）需要用 init 容器或 ConfigMap/Secret 方式挂载，管理繁琐且体积受限。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: ml-inference
spec:
  containers:
    - name: server
      image: triton-server:24.08
      volumeMounts:
        - name: model
          mountPath: /models
        - name: config
          mountPath: /etc/config
  volumes:
    # OCI 卷：直接从镜像注册表拉取
    - name: model
      image:
        reference: registry.example.com/ml-models/bert-large:v3
        pullPolicy: IfNotPresent
    # 传统方式对比：ConfigMap 有 1MB 限制
    - name: config
      image:
        reference: registry.example.com/app-configs/prod:v2
```

**优势**：
- 复用镜像注册表（版本管理、认证、缓存）
- 无大小限制（不受 ConfigMap/Secret 1MB 限制）
- OCI 镜像本身有层缓存和内容寻址
- 适用于 ML 模型（GB 级）、静态前端资源、证书包

---

## 6. SELinux 卷标签加速（v1.36 GA）

**解决的问题**：每次挂载启用 SELinux 的卷，kubelet 递归重标记整个卷（`chcon -R`），大卷耗时数十分钟。

**优化**：用 `mount -o context=system_u:object_r:container_file_t:s0:c123,c456` 替代递归重标记。

**无 YAML 配置**——v1.36 起默认适用于所有卷类型。开发者只需确保：
- Pod 的 `securityContext.seLinuxOptions` 设置正确
- 卷的 `seLinuxChangePolicy` 未显式设为不兼容值

**运维影响**：Pod 启动时间从数十分钟（大卷）降至数秒。**注意**：未来版本可能在同节点特权/非特权 Pod 共享卷时产生破坏性变更，v1.36 是审计集群的最佳版本。

---

## 7. 可变卷挂载限制（v1.36 GA）

**解决的问题**：CSI 驱动的每节点最大卷数在驱动注册时固定，无法动态调整。

**优化**：CSI 驱动可动态更新 `NodeGetInfo` 返回的最大卷数，无需重启 kubelet 或重新注册驱动。

```go
// CSI 驱动实现（伪代码）
func (d *Driver) NodeGetInfo(ctx context.Context, req *csi.NodeGetInfoRequest) (*csi.NodeGetInfoResponse, error) {
    return &csi.NodeGetInfoResponse{
        MaxVolumesPerNode: d.getDynamicMaxVolumes(),  // 动态计算
    }, nil
}
```

**运维影响**：无用户配置。节点扩容存储或新驱动上线后，自动更新卷数限制，避免之前需重启 kubelet 的问题。

---

## 关联知识

- [[../versions/K8s 1.29 Mandala 详解]]（ReadWriteOncePod GA）
- [[../versions/K8s 1.32 Penelope 详解]]（StatefulSet PVC 清理 GA）
- [[../versions/K8s 1.36 Haru 详解]]（卷组快照 / OCI 卷源 / SELinux / 可变挂载限制 GA）
- [[../versions/K8s 1.34 Of Wind and Will 详解]]（VolumeAttributesClass GA）
- [[../K8s 1.28-1.36 版本更新总结#主线 5：存储现代化]]

## 参考资源

- VolumeGroupSnapshot：https://kubernetes.io/docs/concepts/storage/volume-group-snapshots/
- VolumeAttributesClass：https://kubernetes.io/docs/concepts/storage/volume-attributes-classes/
- ReadWriteOncePod KEP-2485：https://kep.k8s.io/2485
- OCI Volume KEP-4639：https://kep.k8s.io/4639

---

**状态**: 📖 已掌握

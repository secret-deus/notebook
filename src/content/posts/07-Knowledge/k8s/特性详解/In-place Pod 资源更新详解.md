---
date: 2026-06-29
tags:
  - k8s
  - pod
  - 资源管理
  - VPA
type: 学习笔记
category: 云原生/Kubernetes/工作负载
source: https://kubernetes.io/blog/2025/12/17/kubernetes-v1-35-release/
difficulty: 进阶
title: "In-place Pod 资源更新详解"
---

# In-place Pod 资源更新详解

## 概述

In-place Pod 资源更新（原地更新）是 Kubernetes **v1.27 Alpha → v1.33 Beta（默认开启）→ v1.35 GA** 的特性，允许**在不重启 Pod 的情况下**修改容器的 CPU/内存资源 request 和 limit，从根本上改变了「改资源必须重建 Pod」的局面。

> KEP-1287，从 2017 年首次提出到 GA 历时 8 年，是 Kubernetes 最受期待的特性之一。

## 为什么需要原地更新

### 痛点：修改资源 = 重建 Pod

```bash
# 旧方式：改 Deployment resources 需要滚动更新
kubectl patch deployment my-app --patch '
spec:
  template:
    spec:
      containers:
      - name: app
        resources:
          requests:
            cpu: "500m"    # 之前是 100m
' 
# 结果：整个 Pod 重建，Pod IP 变更，短暂服务中断，重新调度可能到不同节点
```

| 场景 | 重建 Pod 的影响 |
|------|----------------|
| CPU 从 100m → 500m | Pod 重建，IP 变化，连接池刷新，可能触发 PDB |
| 内存从 256Mi → 512Mi | 同上 + 可能被调度到其他节点 |
| VPA 自动调资源 | 每次调整都重建 Pod，无法高频操作 |
| GPU 弹性伸缩 | GPU 从 0 → 1 需重建（In-place Resize 尚不支持 GPU） |

## 核心概念

### resizePolicy

每个容器可以单独声明哪些资源的变更是「无重启」还是「需重启」：

```yaml
spec:
  containers:
    - name: app
      resources:
        requests:
          cpu: "500m"
          memory: "512Mi"
        limits:
          cpu: "1000m"
          memory: "1Gi"
      resizePolicy:                     # v1.35 GA
        - resourceName: cpu
          restartPolicy: NotRequired    # CPU 变更不需要重启
        - resourceName: memory
          restartPolicy: NotRequired    # 内存变更也不需要重启
```

| restartPolicy | 含义 |
|---------------|------|
| `NotRequired` | 该资源变更时 Pod 不需要重启（直接生效） |
| `RestartContainer` | 该资源变更时需要重启容器（默认行为，同旧方式） |

### 生效条件

原地更新**只在满足以下条件时**生效：
1. 节点的 cgroup 仍有余量（CPU/内存池需满足新值）
2. 容器设置了 `resizePolicy` 为 `NotRequired`
3. 新的 request/limit 在节点容量范围内
4. 主机内核支持（cgroup v2；v1.35 起 cgroup v1 已移除）

**不生效时**：kubelet 会拒绝（返回错误），Pod 保持在 Running 状态，资源不变。

### 资源调整行为

```
Pod Running 中
  │
  ├─ kubectl patch / VPA 修改 resources.requests.cpu
  │
  ├─ kubelet 验证：
  │   ├─ cgroup 有余量？ → ❌ 拒绝，Pod 保持原资源
  │   └─ ✅ 通过
  │
  ├─ kubelet 更新 cgroup 配置（不重启容器）
  │   ├─ cpu.shares 更新（CPU 权重）
  │   └─ memory.limit_in_bytes 更新（内存限制）
  │
  └─ Pod Status 反映新资源
      └─ status.resize: "InProgress" → "Infeasible" 或成功
```

## 实战示例

### 示例 1：手动原地调整 CPU

```bash
# 当前状态
kubectl get pod my-pod -o jsonpath='{.spec.containers[0].resources}'
# {"limits":{"cpu":"1000m","memory":"1Gi"},"requests":{"cpu":"100m","memory":"256Mi"}}

# 原地升级 CPU 到 500m
kubectl patch pod my-pod --type=strategic --patch '
spec:
  containers:
    - name: app
      resources:
        requests:
          cpu: "500m"
        limits:
          cpu: "1000m"
'

# 验证——Pod 没有重启
kubectl get pod my-pod -o jsonpath='{.status.containerStatuses[0].restartCount}'
# 0  ← 没有变化！
kubectl get pod my-pod -o jsonpath='{.spec.containers[0].resources.requests.cpu}'
# 500m  ← 新值生效
```

### 示例 2：Deployment 配合 In-place Resize

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    spec:
      containers:
        - name: api
          image: my-api:v2
          resources:
            requests:
              cpu: "200m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          resizePolicy:
            - resourceName: cpu
              restartPolicy: NotRequired
            - resourceName: memory
              restartPolicy: NotRequired
```

```bash
# 修改 Deployment resources（不会触发滚动更新！）
kubectl patch deployment api-server --patch '
spec:
  template:
    spec:
      containers:
        - name: api
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
'

# 观察：现有的 3 个 Pod 原地更新，不创建新 Pod
kubectl get pods -l app=api-server -w
# 所有 Pod AGE 不变化，重启次数不增加
```

### 示例 3：VPA + In-place Resize（最强大组合）

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: Auto
    minReplicas: 2
  resourcePolicy:
    containerPolicies:
      - containerName: api
        controlledResources: ["cpu", "memory"]
        minAllowed:
          cpu: "100m"
          memory: "128Mi"
        maxAllowed:
          cpu: "2000m"
          memory: "4Gi"
```

启用 In-place Resize 后，VPA 可以**高频微调**而不重建 Pod：

```
时间线：
10:00 → VPA 推荐 cpu=200m → 原地调，无重启
10:05 → VPA 推荐 cpu=300m → 原地调，无重启
10:12 → VPA 推荐 cpu=500m → 原地调，无重启
10:30 → VPA 推荐 cpu=200m → 原地调，无重启
```

> 没有 In-place Resize 之前，每次 VPA 调整都重建 Pod，实际生产中很少用 `Mode: Auto`。

## Pod Status 变化

```bash
kubectl describe pod my-pod
```

```
Status:
  Container Statuses:
    Container ID:   containerd://abc123...
    Restart Count:  0
    Resources:
      Requests:
        Cpu:      500m (之前 100m)     ← 动态更新
        Memory:   256Mi
      Limits:
        Cpu:      1000m
        Memory:   512Mi
  Conditions:
    Type                 Status
    PodReadyToStartContainers  True
    Initialized          True
    Ready                True
```

## 限制与不适用场景

| 限制 | 说明 |
|------|------|
| **不支持 GPU/扩展资源** | 仅对 `cpu` 和 `memory` 有效。GPU、`nvidia.com/gpu`、`example.com/foo` 等**必须重建** |
| **不支持修改 Limit > Node Capacity** | 新 limit 不能超过节点容量，否则拒绝 |
| **不支持 Memory Limit 下调（如果低于当前使用）** | 内存 limit 低于当前 usage 时会 OOM Kill 容器（行为同不调整时超 limit） |
| **仅支持 Linux** | Windows 容器尚未支持（正在开发中） |
| **不支持 init 容器（含 sidecar）资源任意调整** | Sidecar 容器需额外考虑（v1.36+ 部分支持） |
| **不支持 QoS 变更** | 原地更新不改变 QoS 等级 |

## 与 Sidecar 容器的配合

```yaml
spec:
  initContainers:
    - name: envoy-sidecar
      restartPolicy: Always
      resources:
        requests:
          cpu: "100m"
          memory: "128Mi"
      resizePolicy:          # sidecar 也支持原地调整（v1.35+）
        - resourceName: cpu
          restartPolicy: NotRequired
  containers:
    - name: app
      resizePolicy:
        - resourceName: cpu
          restartPolicy: NotRequired
        - resourceName: memory
          restartPolicy: NotRequired
      resources:
        requests:
          cpu: "500m"
          memory: "512Mi"
```

## 常见问题 / 坑点

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `kubectl patch` 资源后 Pod 重建了 | 容器没有设置 `resizePolicy` 或设为 `RestartContainer` | 在 Pod spec 中设置 `resizePolicy: NotRequired` |
| 原地更新被拒绝（Infeasible） | 节点 cgroup 余量不足 | 检查节点资源；重建 Pod 到其他节点 |
| VPA 仍然重建 Pod | VPA 默认使用 `Recreate` 模式，且老版本 VPA 不感知 In-place Resize | 确认 VPA ≥ 1.0，Pod 有 `resizePolicy` |
| 内存原地更新后容器被 OOM Kill | 新 limit 低于当前内存 usage | 逐步下调，或临时扩容到更高的 limit 再下降 |
| Deployment 仍触发滚动更新 | `containers` 数组的索引或名称变化 | 只修改 resources，不改变容器顺序/名称 |

## 关联知识

- [[Sidecar 容器详解]]（配合资源原地调整）
- [[../versions/K8s 1.35 Timbernetes 详解]]（In-place Resize GA 版本）
- [[../versions/K8s 1.33 Octarine 详解]]（In-place Resize Beta 版本）
- [[../K8s 1.28-1.36 版本更新总结]]

## 参考资源

- KEP-1287（In-place Pod Resize）：https://kep.k8s.io/1287
- 官方文档：https://kubernetes.io/docs/tasks/configure-pod-container/resize-container-resources/
- VPA + In-place Resize：https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler
- v1.35 发布公告：https://kubernetes.io/blog/2025/12/19/kubernetes-v1-35-in-place-pod-resize-ga/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 初次学习 | 2026-06-29 | 核心概念 + 手动原地调整验证 |
| 深入理解 | | VPA + In-place Resize 实战 |
| 实战应用 | | 生产环境 Deployment 启用 resizePolicy |

---

**状态**: 📖 已掌握

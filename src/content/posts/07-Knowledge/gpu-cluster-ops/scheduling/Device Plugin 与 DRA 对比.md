---
date: 2026-06-30
tags:
  - gpu
  - kubernetes
  - scheduling
  - device-plugin
  - dra
type: 学习笔记
category: GPU集群运维/调度
source: K8s 官方文档 + NVIDIA DRA Driver + 个人整理
difficulty: 进阶
title: "Device Plugin 与 DRA 对比"
---

# Device Plugin 与 DRA 对比

> GPU 集群中两种核心资源分配机制的深度对比：传统 Device Plugin vs 新一代 Dynamic Resource Allocation。理解两者的差异，是 K8s GPU 调度体系升级的关键。

---

## 一、架构对比：一图看懂

```
┌─────────────── Device Plugin 模型 ───────────────┐
│                                                    │
│  Pod                  Scheduler          Kubelet   │
│  ┌──────────┐       ┌──────────┐      ┌─────────┐ │
│  │resources:│       │只看节点    │      │Allocate │ │
│  │  nvidia. │──────>│有 2 个    │─────>│GPU 0,1  │ │
│  │  com/gpu │       │GPU 就行   │      │给 Pod   │ │
│  │  : 2     │       │          │      │         │ │
│  └──────────┘       └──────────┘      └─────────┘ │
│                       ↑  不知道 GPU 在哪个         │
│                       │  NUMA / PCIe switch!       │
│  nvidia-device-plugin: "节点有 8 个 GPU"           │
│  (只报告数量，不报告属性和拓扑)                     │
└────────────────────────────────────────────────────┘

┌─────────────── DRA 模型 ─────────────────────────────┐
│                                                       │
│  ResourceClaim        Scheduler          Kubelet      │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────┐  │
│  │ selectable:  │   │匹配属性+拓扑  │   │分配 GPU  │  │
│  │  model: A100 │──>│+ NUMA亲和性  │──>│0,1 并挂载│  │
│  │  memory: 80  │   │              │   │到容器    │  │
│  │  count: 2    │   └──────────────┘   └──────────┘  │
│  └──────────────┘                                     │
│                                                       │
│  ResourceSlice: "GPU-0: A100/80GB, NUMA0;             │
│                  GPU-1: A100/80GB, NUMA0; ..."        │
│  (调度器感知每个设备的属性和拓扑位置)                   │
└───────────────────────────────────────────────────────┘
```

---

## 二、维度对比：逐项拆解

### 2.1 核心能力

| 维度 | Device Plugin | DRA | 谁更优 |
|------|:---:|:---:|:---:|
| **调度感知** | ❌ 只报告节点 GPU 数量 | ✅ 感知每个设备属性 + 拓扑位置 | DRA |
| **属性筛选** | ❌ 所有 GPU 同质 | ✅ `selectableAttributes` 按型号/显存/代数筛选 | DRA |
| **NUMA 亲和** | ⚠️ 需额外 Topology Manager，且不支持跨 Pod 协调 | ✅ 调度器原生感知 NUMA，跨 Pod 协调 | DRA |
| **NVLink 拓扑感知** | ❌ 不知道哪些 GPU 通过 NVLink 互联 | ✅ 可通过设备属性标注 NVLink group | DRA |
| **子资源分配** | ⚠️ MIG 通过独立资源名暴露 (`nvidia.com/mig-1g.10gb`)，笨重 | ✅ 原生支持 Partition / TimeSlicing | DRA |
| **多 Pod 共享** | ❌ 同一 GPU 只能给一个 Pod（TimeSlicing 是 workaround） | ✅ 通过 sharing strategy 原生支持 | DRA |
| **生命周期管理** | 绑定到 Pod：Pod 删 → GPU 释放 | 独立于 Pod：ResourceClaim 可保留 | DRA |
| **RDMA / NIC 管理** | ❌ 无法管理 | ✅ 统一框架管理 GPU + NIC | DRA |
| **Cluster Autoscaler** | ❌ 不支持模拟调度 | ✅ 结构化参数可模拟 | DRA |

### 2.2 运维维度

| 维度 | Device Plugin | DRA |
|------|:---:|:---:|
| **部署复杂度** | ✅ 简单：部署 nvidia-device-plugin DaemonSet | ⚠️ 中：需 DRA driver + DeviceClass + ResourceSlice 管理 |
| **成熟度** | ✅ 10 年生产验证 | ⚠️ K8s v1.26 Alpha → v1.34 GA，生产案例仍在积累 |
| **驱动支持** | ✅ 所有 GPU 厂商 | ⚠️ NVIDIA 已支持，AMD/Intel 进行中 |
| **社区生态** | ✅ Helm chart、GPU Operator 一键部署 | ⚠️ Operator 正在适配 |
| **故障排查** | ✅ 文档丰富，问题可搜索 | ⚠️ 报错信息较新，社区方案少 |
| **与 Volcano 集成** | ✅ Volcano 原生支持 `nvidia.com/gpu` | ⚠️ 需额外适配 |
| **多版本 K8s 兼容** | ✅ 全版本 | ⚠️ 核心 API 需 v1.34+，旧版本 API 已废弃 |

### 2.3 性能维度

| 维度 | Device Plugin | DRA |
|------|:---:|:---:|
| **调度延迟** | ✅ 毫秒级（简单计数） | ⚠️ 毫秒级+（属性匹配 + 拓扑约束） |
| **分配延迟** | ✅ 毫秒级（kubelet 直接调 Allocate） | ⚠️ 毫秒级（多一层 ResourceClaim 状态机） |
| **GPU 利用率优化** | ⚠️ 调度器不感知拓扑，可能分配效率低 | ✅ 调度器全域优化，提升整体利用率 |
| **碎片化控制** | ❌ MIG 配置后固定，动态调整需重启 | ✅ 可通过 ResourceSlice 动态调整 |

---

## 三、典型场景决策

### 3.1 训练场景

```
场景：大模型训练，需要 8 卡 TP（张量并行）
需求：8 个 A100 80GB，同节点，NVSwitch 全互联

Device Plugin：
  resources:
    nvidia.com/gpu: 8
  → 可能分配到 [GPU0,GPU1,GPU2,GPU3,GPU4,GPU5,GPU6,GPU7]
  → 无法保证 8 卡都有 NVLink 全互联（部分可能是 PCIe）

DRA：
  selectableAttributes:
    - attribute: model      → "A100"
    - attribute: memoryGB   → "80"
    - attribute: nvlink-group → "nvswitch-0"  ← 精确指定 NVSwitch 组
  count: 8
  allocationMode: All
  → 保证 8 卡在同一 NVSwitch domain，TP 性能最优

结论：训练场景 DRA 更强，能精确控制拓扑。
```

### 3.2 推理场景（多租户）

```
场景：推理集群，需要 4 个实例，每个 1 个 MIG 切片（1g.10gb）

Device Plugin：
  暴露资源: nvidia.com/mig-1g.10gb
  Pod 请求: nvidia.com/mig-1g.10gb: 1
  → 4 个 Pod 各拿 1 个 MIG slice
  → 但如果某个节点只剩 2 个 slice，调度器不知道

DRA：
  ResourceClaimTemplate（每个 Pod 自动创建）
  sharing:
    strategy: Partition
  → 调度器知道每个节点剩余多少个 slice
  → 可以跨节点优化放置

结论：推理多租户 DRA 更优雅，但 Device Plugin + MIG 也能用。
```

### 3.3 混合 GPU 集群

```
场景：集群同时有 A100 和 H100，训练任务要 H100，推理要 A100

Device Plugin：
  → 需要 nodeSelector + 节点打标签区分
  → 或通过不同 resource name 暴露

DRA：
  selectableAttributes:
    - attribute: model
      value: "H100"
  → 原生属性筛选，不需要维护节点标签

结论：异构 GPU 集群 DRA 能大幅简化管理。
```

---

## 四、实战 YAML 对比

### 4.1 最简场景：请求 1 个 GPU

**Device Plugin：**
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: simple-job
spec:
  containers:
  - name: app
    image: nvidia/cuda:12.4-runtime-ubuntu22.04
    resources:
      limits:
        nvidia.com/gpu: 1
```

**DRA：**
```yaml
# 1. 先创建 ResourceClaim
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: simple-gpu
spec:
  devices:
    requests:
      - name: gpu
        deviceClassName: nvidia-gpu
        count: 1
---
# 2. Pod 引用
apiVersion: v1
kind: Pod
metadata:
  name: simple-job
spec:
  containers:
  - name: app
    image: nvidia/cuda:12.4-runtime-ubuntu22.04
    resources:
      claims:
        - name: gpu
  resourceClaims:
    - name: gpu
      source:
        resourceClaimName: simple-gpu
```

> Device Plugin 方案更简洁，DRA 多了 ResourceClaim 这个抽象层——简单场景下这是额外开销。

### 4.2 复杂场景：指定 A100 80GB × 2，同 NUMA node

**Device Plugin：**（难以精确实现）
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: pinned-job
spec:
  containers:
  - name: trainer
    image: pytorch/pytorch:2.4
    resources:
      limits:
        nvidia.com/gpu: 2
        cpu: 32
        memory: 128Gi
  # 需要额外配置 Topology Manager + CPU Manager Policy
  # + nodeSelector 限定 A100 节点
  nodeSelector:
    gpu-type: a100          # 手动打标签
    gpu-memory: "80"        # 手动打标签
  # ⚠️ 无法保证 2 个 GPU 在同一 NUMA node！
```

**DRA：**
```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: pinned-gpu
spec:
  devices:
    requests:
      - name: gpu
        deviceClassName: nvidia-gpu
        count: 2
        allocationMode: All             # 必须同时分配
        selectableAttributes:
          - attribute: model
            value: "A100"               # 原生属性筛选
          - attribute: memoryGB
            value: "80"
      - name: gpu-numa
        deviceClassName: nvidia-gpu-numa
        constraints:
          - sameNUMANode: true          # 同 NUMA node（需驱动支持）
```

### 4.3 共享场景：多 Pod 分时复用同一个 GPU

**Device Plugin (Time-Slicing workaround)：**
```yaml
# nvidia-device-plugin ConfigMap
data:
  config.yaml: |
    version: v1
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 4    # 1 个 GPU 暴露为 4 个虚拟 GPU
```
```yaml
# Pod 请求「虚拟 GPU」
apiVersion: v1
kind: Pod
spec:
  containers:
  - resources:
      limits:
        nvidia.com/gpu: 1  # ← 实际是 1/4 时间片
```
> ⚠️ 问题：kubelet 和调度器看到的都是 4× GPU，不知道它们共享同一物理 GPU。显存不隔离，OOM 风险。

**DRA：**
```yaml
apiVersion: resource.k8s.io/v1
kind: DeviceClass
metadata:
  name: nvidia-gpu-shared
spec:
  config:
    - opaque:
        driver: nvidia.com
        parameters:
          apiVersion: gpu.resource.k8s.io/v1alpha1
          kind: GPUConfig
          sharing:
            strategy: TimeSlicing          # 原生共享策略
            timeSliceInterval: 100ms
---
apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: shared-gpu
spec:
  spec:
    devices:
      requests:
        - name: gpu
          deviceClassName: nvidia-gpu-shared
          count: 1
          sharing:
            strategy: TimeSlicing
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inference-pool
spec:
  replicas: 4
  template:
    spec:
      containers:
      - name: server
        resources:
          claims:
            - name: gpu
      resourceClaims:
        - name: gpu
          source:
            resourceClaimTemplateName: shared-gpu
```
> ✅ 优势：调度器知晓共享关系，可精确控制每个物理 GPU 上最多多少共享 Pod，避免过载。

---

## 五、版本演进与兼容性

```
K8s v1.25 及以前:
  └── 只能用 Device Plugin

K8s v1.26-v1.30:
  └── DRA Alpha（旧 API，已废弃）
  └── Device Plugin 仍然主力

K8s v1.31-v1.33:
  └── DRA 结构化参数（新 API）Alpha → Beta
  └── Device Plugin 共存

K8s v1.34+ (2025.08):
  └── DRA 核心 API GA: resource.k8s.io/v1
  └── ★ 生产可用的分水岭 ★
  └── Device Plugin 继续可用，不受影响

K8s v1.35+ (2025.12):
  └── DRA 扩展：可分区设备、设备污点
  └── GPU 场景全面可用

K8s v1.36+ (2026.04):
  └── AdminAccess GA、优先替代 GA
  └── 原生 ResourceClaim（Pod 内嵌声明）Alpha
```

---

## 六、迁移指南

### 6.1 渐进式迁移策略

```
阶段 1：双轨运行（v1.34+）
  ├── 保留 nvidia-device-plugin（现有工作负载不受影响）
  └── 部署 NVIDIA DRA Driver（新工作负载试用）

阶段 2：新负载切 DRA
  ├── 新训练 Job → 用 DRA 的拓扑感知
  ├── 推理 Pool → 用 DRA 的共享策略
  └── 旧 Job 继续用 Device Plugin

阶段 3：全量迁移
  ├── 验证所有场景覆盖
  ├── 逐步下掉 MIG 资源名暴露
  └── 移除 nvidia-device-plugin（仅保留 DRA driver）
```

### 6.2 NVIDIA DRA Driver 部署

```bash
# 1. 安装 NVIDIA DRA Driver（Helm）
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm install nvidia-dra-driver nvidia/k8s-dra-driver \
  --namespace nvidia-dra \
  --create-namespace \
  --set driver.version=0.8.0

# 2. 创建 GPU DeviceClass
kubectl apply -f - <<EOF
apiVersion: resource.k8s.io/v1
kind: DeviceClass
metadata:
  name: nvidia-gpu
spec:
  selectableAttributes:
    - name: model
    - name: memoryGB
    - name: architecture
  config:
    - opaque:
        driver: nvidia.com
        parameters:
          apiVersion: gpu.resource.k8s.io/v1alpha1
          kind: GPUConfig
EOF

# 3. 验证 ResourceSlice 自动创建
kubectl get resourceslices
# NAME          NODE     DRIVER      DEVICES
# node1-gpu     node1    nvidia.com   8
# node2-gpu     node2    nvidia.com   8
```

### 6.3 迁移注意事项

| 注意事项 | 说明 |
|----------|------|
| **Volcano 兼容性** | Volcano 对 DRA 支持有限，当前建议训练任务仍用 Device Plugin + Volcano |
| **GPU Operator** | GPU Operator 以 Device Plugin 为核心，DRA driver 需独立部署 |
| **MIG 迁移** | MIG 配置仍通过 nvidia-mig-manager 管理，DRA 通过 ResourceSlice 暴露 slice |
| **监控不变** | DCGM + dcgm-exporter 不受影响，GPU 监控链路不变 |
| **资源名变化** | `nvidia.com/gpu` → `ResourceClaim` 引用，K8s Dashboard 需要适配 |

---

## 七、什么时候用哪个？

```
用 Device Plugin 如果你：
  ✅ K8s < v1.34
  ✅ 简单场景（固定 GPU 数量，不需要拓扑控制）
  ✅ 使用 Volcano 等第三方调度器
  ✅ 团队对 Device Plugin 已经很熟悉

用 DRA 如果你：
  ✅ K8s ≥ v1.34
  ✅ 异构 GPU 集群（A100 + H100 + B200 混合）
  ✅ 需要拓扑感知（同一 NVSwitch/NUMA 节点）
  ✅ 推理多租户需要精确的共享策略
  ✅ 需要 GPU + RDMA NIC 协同分配
  ✅ 新集群，从零开始

当前（2026 年中）推荐：
  训练集群：Device Plugin 为主（成熟），DRA 作为 POC 试点
  推理集群：DRA 试点（共享策略优势明显）
  异构集群：尽快评估 DRA（属性筛选是刚需）
```

---

## 关联知识

- [[K8s GPU 调度机制详解]] — GPU 调度全面概述
- [[GPU 资源分配与隔离策略]] — MIG、Time-Slicing、MPS 详解
- [[Volcano 调度器实战]] — 批量调度器与 GPU 配合
- [[../hardware/NVLink 与 NVSwitch 拓扑详解]] — 为什么拓扑感知很重要
- [[../../../k8s/特性详解/DRA 动态资源分配详解]] — K8s 原生 DRA 机制深入
- [[../../../k8s/K8s 1.28-1.36 版本更新总结]] — DRA 版本演进主线
- [[../GPU 集群运维知识总览]] — 返回总览

## 参考资源

- [K8s DRA 官方文档](https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/)
- [NVIDIA k8s-dra-driver](https://github.com/NVIDIA/k8s-dra-driver)
- [KEP-3063: DRA Structured Parameters](https://kep.k8s.io/3063)
- [NVIDIA Device Plugin](https://github.com/NVIDIA/k8s-device-plugin)

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 内容创建 | 2026-06-30 | 完整 Device Plugin vs DRA 对比 |

## 状态标记

📖 已掌握 — 架构差异、能力对比、场景决策、迁移策略
📝 待补充 — AMD/Intel GPU 的 DRA 驱动支持进展、实际生产迁移案例

---
date: 2026-06-29
tags:
  - k8s
  - DRA
  - GPU
  - 设备管理
type: 学习笔记
category: 云原生/Kubernetes/资源管理
source: https://kubernetes.io/blog/2025/08/27/kubernetes-v1-34-release/
difficulty: 高级
title: "DRA 动态资源分配详解"
---

# DRA（动态资源分配）详解

## 概述

动态资源分配（Dynamic Resource Allocation, DRA）是 Kubernetes 从 **v1.26 Alpha → v1.31 新 API → v1.34 GA** 的新一代硬件资源管理框架，替代传统的 Device Plugin 机制，更好地支持 **GPU、TPU、FPGA、NIC、RDMA** 等加速器资源的声明式分配与共享。

> v1.34 核心 API `resource.k8s.io/v1` 达到 GA，标志着 DRA 从实验走向生产。

## 为什么需要 DRA

### Device Plugin 的局限性

| 问题 | 说明 |
|------|------|
| **调度不感知资源拓扑** | Device Plugin 只报告节点上有几个 GPU，不知道 GPU 拓扑（同一 PCIe switch / NUMA 节点） |
| **不支持资源子分配** | 一个 GPU 不能分给多个容器（MIG/MPS 模式不支持） |
| **不支持复杂约束** | 不能表达「我需要 2 个 GPU，且它们必须在同一 NUMA 节点」 |
| **不支持网络附加设备** | 不能声明「Pod A 和 Pod B 共享同一 RDMA NIC」 |
| **声明式不足** | 请求在 Pod spec 里直接写 `nvidia.com/gpu: 2`，无生命周期管理 |

### DRA 解决的核心问题

```
Device Plugin 模型：
  Pod → 调度器 → 绑到节点 → kubelet 调 Device Plugin → 分配设备
  问题：调度器不感知哪个设备被分配，拓扑和亲和性无从优化

DRA 模型：
  ResourceClaim（声明所需的设备）→ 调度器找满足条件的节点
  → Pod 绑到节点 → kubelet 调 DRA 驱动 → 分配设备 → 挂载
  优势：调度器全流程感知设备拓扑，可按亲和性/反亲和性优化
```

## 核心概念

### 四类资源

```
ResourceClaimTemplate (模板)
       │
       ▼
  ResourceClaim (声明：我需要 X)
       │
       ▼
  ResourceSlice (池：节点 Y 有资源 A/B/C)
       │
       ▼
  DeviceClass (类型定义：这是什么设备，驱动是谁)
```

### ResourceClaim（资源声明）

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: my-gpu
spec:
  devices:
    requests:
      - name: gpu
        deviceClassName: nvidia-gpu       # 引用 DeviceClass
        allocationMode: All
        count: 2                          # 请求 2 个 GPU
        adminAccess: false                # 不需要管理员访问
```

**字段说明**：

| 字段 | 说明 |
|------|------|
| `deviceClassName` | 引用 DeviceClass，决定用什么驱动 |
| `count` | 请求的设备数量 |
| `allocationMode` | `All`（全部分配）或 `ExactCount`（精确数量） |
| `adminAccess` | 管理员访问模式（v1.36 GA），允许集群管理员安全访问 |
| `selectableAttributes` | 选择条件（如型号、显存大小） |

### DeviceClass（设备类型定义）

```yaml
apiVersion: resource.k8s.io/v1
kind: DeviceClass
metadata:
  name: nvidia-gpu
spec:
  selectableAttributes:
    - name: model
      description: "GPU 型号"
    - name: memoryGB
      description: "显存大小 (GB)"
  config:
    - opaque:
        driver: nvidia.com
        parameters:
          apiVersion: gpu.resource.k8s.io/v1alpha1
          kind: GPUConfig
          sharing:
            strategy: TimeSlicing
```

### ResourceSlice（资源池）

由 DRA 驱动自动创建，表示某个节点的可用资源：

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceSlice
metadata:
  name: node1-gpu
  ownerReferences:
    - apiVersion: v1
      kind: Node
      name: node1
spec:
  driver: nvidia.com
  pool:
    name: gpu-pool
    devices:
      - name: gpu-0
        attributes:
          - name: model
            value: "A100"
          - name: memoryGB
            value: "80"
        capacity: 1            # 1 个完整 GPU
      - name: gpu-1
        attributes:
          - name: model
            value: "A100" 
          - name: memoryGB
            value: "80"  
        capacity: 1
```

### Pod 中使用 ResourceClaim

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: training-job
spec:
  containers:
    - name: trainer
      image: pytorch/pytorch:2.4
      resources:
        claims:
          - name: gpu                    # 引用 pod.spec.resourceClaims
  resourceClaims:
    - name: gpu
      source:
        resourceClaimName: my-gpu        # 绑定到 ResourceClaim
```

## 实战示例

### 示例 1：简单 GPU 分配

```yaml
# 1. DeviceClass
apiVersion: resource.k8s.io/v1
kind: DeviceClass
metadata:
  name: nvidia-gpu
spec:
  selectableAttributes:
    - name: model
---
# 2. ResourceClaim（声明 2 个 GPU）
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: training-gpu
spec:
  devices:
    requests:
      - name: gpu
        deviceClassName: nvidia-gpu
        count: 2
---
# 3. Pod
apiVersion: v1
kind: Pod
metadata:
  name: pytorch-trainer
spec:
  containers:
    - name: trainer
      image: pytorch/pytorch:2.4
      command: ["python", "train.py"]
      resources:
        claims:
          - name: gpu
  resourceClaims:
    - name: gpu
      source:
        resourceClaimName: training-gpu
```

### 示例 2：带属性的 GPU 选择（只要 A100, ≥ 40GB）

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: premium-gpu
spec:
  devices:
    requests:
      - name: gpu
        deviceClassName: nvidia-gpu
        count: 4
        selectableAttributes:
          - attribute: model
            value: "A100"
          - attribute: memoryGB
            value: "80"
```

### 示例 3：多 Pod 共享 GPU（MIG / TimeSlicing）

```yaml
# ResourceClaimTemplate — 每个 Pod 动态创建独立 ResourceClaim
apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: gpu-share
spec:
  spec:
    devices:
      requests:
        - name: gpu
          deviceClassName: nvidia-mig
          count: 1
          sharing:
            strategy: Partition          # 物理分区（MIG）或时间片
---
# Deployment 引用模板
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inference-pool
spec:
  replicas: 4
  template:
    spec:
      containers:
        - name: model-server
          image: triton-server:24.08
          resources:
            claims:
              - name: gpu
      resourceClaims:
        - name: gpu
          source:
            resourceClaimTemplateName: gpu-share
```

## DRA vs Device Plugin 对比

| 维度 | Device Plugin | DRA |
|------|:---:|:---:|
| 调度感知 | ❌ 仅报告计数 | ✅ 调度器感知设备属性和拓扑 |
| 资源子分配 | ❌ 整卡分配 | ✅ MIG / TimeSlicing / 分区 |
| 多 Pod 共享设备 | ❌ | ✅ 通过 ResourceClaim 实现 |
| 属性选择 | ❌ | ✅ `selectableAttributes` 按型号/显存筛选 |
| 资源生命周期 | 绑定到 Pod | 绑定到 ResourceClaim（独立于 Pod 生命周期） |
| Cluster Autoscaler | ❌ 不支持模拟 | ✅ 结构化参数可模拟 |
| 网络设备（RDMA/NIC） | ❌ | ✅ 同框架支持 |
| API 版本 | `deviceplugin/v1beta1` | `resource.k8s.io/v1` (GA) |

## 版本演进时间线

| 版本 | 进展 |
|------|------|
| v1.26 | DRA Alpha（旧 API） |
| v1.28 | CDI 设备注入 Alpha |
| v1.31 | 新 DRA API（结构化参数）Alpha，旧 API 废弃 |
| v1.32 | 旧 DRA 撤回，结构化参数 Beta |
| v1.33 | 结构化参数 v1beta2 Beta，DRA 多种扩展 Alpha |
| **v1.34** | **DRA 核心 GA**（`resource.k8s.io/v1`） |
| v1.35 | DRA 扩展（可分区设备、设备污点） |
| v1.36 | AdminAccess GA、优先替代 GA、原生 ResourceClaim Alpha |

## 注意事项

| 注意 | 说明 |
|------|------|
| **需要 DRA 驱动** | GPU 厂商需提供 DRA 驱动（NVIDIA 已支持，Intel/AMD 开发中） |
| **旧 Device Plugin 仍可用** | DRA 不替代 Device Plugin，两者可共存 |
| **ResourceClaim 生命周期** | 可独立于 Pod，删除 Pod 不一定删除 ResourceClaim |
| **调度复杂度** | DRA 引入新约束，增加调度器计算量 |
| **仅 v1.34+** | 核心 API 在 v1.34 GA，v1.32/v1.33 有 Beta 但 API 可能变化 |

## 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| ResourceClaim 一直 Pending | 集群没有匹配的 ResourceSlice | 检查 DeviceClass 和驱动 |
| Pod 因 ResourceClaim 未分配而 Pending | ResourceClaim 尚未分配 | `kubectl describe resourceclaim` 查看状态 |
| 调度器不选 GPU 节点 | ResourceSlice 未覆盖目标节点 | DRA 驱动可能未正确配置节点标签 |

## 关联知识

- [[../versions/K8s 1.34 Of Wind and Will 详解]]（DRA GA 版本）
- [[../versions/K8s 1.36 Haru 详解]]（DRA AdminAccess GA）
- [[../K8s 1.28-1.36 版本更新总结#主线 1：设备管理 — 从 Device Plugin 到 DRA]]

## 参考资源

- KEP-3063（DRA 结构化参数）：https://kep.k8s.io/3063
- DRA 官方文档：https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/
- NVIDIA DRA Driver：https://github.com/NVIDIA/k8s-dra-driver

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 初次学习 | 2026-06-29 | 理解 DRA vs Device Plugin |
| 深入理解 | | 部署 NVIDIA DRA Driver 验证 |
| 实战应用 | | 生产 GPU 集群从 Device Plugin 迁移 |

---

**状态**: 📖 已掌握

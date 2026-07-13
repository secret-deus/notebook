---
date: 2026-06-29
tags:
  - gpu
  - kubernetes
  - scheduling
  - device-plugin
type: 学习笔记
category: GPU集群运维/调度
source: K8s 官方文档 + NVIDIA
difficulty: 进阶
title: "K8s GPU 调度机制详解"
---

# K8s GPU 调度机制详解

> Kubernetes 中 GPU 资源的调度、分配与隔离机制，从 Device Plugin 到 MIG 的完整链路。

## 概述

Kubernetes 原生不支持 GPU 调度，需通过 Device Plugin 机制将 GPU 注册为扩展资源。了解从 Pod 创建到 GPU 分配的全链路是 GPU 集群运维的基础。

## 📖 核心概念（已掌握）

### 1. Device Plugin 架构

```
kubelet → Device Plugin (gRPC) → GPU Driver → GPU Hardware

流程:
1. nvidia-device-plugin 启动，向 kubelet 注册
2. kubelet 通过 ListAndWatch 获取 GPU 资源列表
3. Pod 请求 nvidia.com/gpu 资源
4. kubelet 调用 Allocate() 分配 GPU
5. Device Plugin 将 GPU 设备挂载到容器
```

### 2. GPU 资源类型

| 资源名 | 说明 | 适用场景 |
|--------|------|----------|
| `nvidia.com/gpu` | 整卡 GPU | 训练任务 |
| `nvidia.com/mig-<slice>` | MIG 切片 | 推理多租户 |
| `nvidia.com/gpu.shared` | Time-Slicing 共享 | 开发调试 |
| `nvidia.com/gpu-memory` | 按显存分配 | 灵活调度 |

### 3. 分配策略

```
整卡分配:    1 Pod = 1~N 完整 GPU (训练)
MIG 分片:    1 Pod = 1 MIG Slice (推理)
Time-Slicing: 多 Pod 共享 1 GPU (交互式)
MPS:         多进程共享 GPU 上下文
```

### 4. GPU Operator 体系

```
gpu-operator/
├── nvidia-driver       # 驱动自动部署
├── nvidia-container-toolkit
├── nvidia-device-plugin
├── dcgm-exporter       # 监控采集
├── nvidia-mig-manager  # MIG 管理
└── gpu-feature-discovery
```

---

## 📖 Device Plugin 内部机制详解（已掌握）

### gRPC 接口与交互流程

Device Plugin 与 kubelet 之间通过 Unix Socket (`/var/lib/kubelet/device-plugins/`) 和 gRPC 通信，实现 `Registration` 和 `DevicePlugin` 两个 service。

```protobuf
// Device Plugin gRPC 核心接口
service Registration {
    rpc Register(RegisterRequest) returns (Empty);
}

service DevicePlugin {
    rpc GetDevicePluginOptions(Empty) returns (DevicePluginOptions);
    rpc ListAndWatch(Empty) returns (stream ListAndWatchResponse);
    rpc Allocate(AllocateRequest) returns (AllocateResponse);
    rpc PreStartContainer(PreStartContainerRequest) returns (PreStartContainerResponse);
}
```

### ListAndWatch 流程（资源上报）

```bash
# 1. Device Plugin 启动时向 kubelet 注册
# Socket 路径: /var/lib/kubelet/device-plugins/nvidia-gpu.sock

# 2. kubelet 调用 ListAndWatch 获取设备列表
# 首次返回全量，后续通过 stream 推送变更
```

```json
// ListAndWatch Response 示例
{
  "devices": [
    {
      "ID": "GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",  // UUID
      "health": "Healthy",
      "topology": {
        "nodes": [{"ID": 0}]  // NUMA node 0
      }
    }
  ]
}
```

### Allocate 流程（设备分配与挂载）

```
Pod 请求 nvidia.com/gpu: 2
  → kubelet 选择 2 个 GPU UUID 并调用 Allocate()
    → Device Plugin 返回 AllocateResponse:
      - 环境变量: NVIDIA_VISIBLE_DEVICES=GPU-uuid1,GPU-uuid2
      - 挂载点: /dev/nvidia0, /dev/nvidiactl, /dev/nvidia-uvm...
      - 预启动钩子（可选）
        → kubelet 在容器创建时注入这些挂载和环境变量
          → nvidia-container-runtime 拦截容器创建
            → nvidia-container-toolkit 注入 GPU 库和二进制文件
```

```go
// AllocateResponse 关键字段
type ContainerAllocateResponse struct {
    Envs        map[string]string  // NVIDIA_VISIBLE_DEVICES=GPU-uuid1,GPU-uuid2
    Mounts      []*Mount          // /dev/nvidia*, /usr/local/nvidia/lib64
    Devices     []*DeviceSpec     // /dev/nvidia0 -> /dev/nvidia0 设备文件
    Annotations map[string]string
}
```

### nvidia-container-toolkit 集成原理

```bash
# 容器创建路径
containerd/cri-o
  → runc (OCI runtime)
    → nvidia-container-runtime (OCI prestart hook)
      → nvidia-container-cli (实际注入逻辑)
        → ldconfig 更新 → 注入 libcuda.so, libnvidia-ml.so 等

# 关键挂载点
# /usr/local/nvidia/lib64 → 容器内的 GPU 库路径
# /dev/nvidia*           → GPU 设备文件
# /proc/driver/nvidia    → NVIDIA 驱动信息

# 查看容器中的 GPU 挂载
docker inspect <container> | jq '.[0].HostConfig.Devices'
# 或 k8s: kubectl exec <pod> -- ls /dev/nvidia* /usr/local/nvidia
```

### Device Plugin 故障恢复

```bash
# Device Plugin 崩溃后，kubelet 会检测到 gRPC 连接断开
# 行为：kubelet 标记该节点上的 GPU 资源为 Unhealthy
#     → 已调度的 Pod 不受影响（但有 OOM/设备丢失风险）
#     → 新 Pod 不会被调度到此节点

# 恢复：Device Plugin 重启后重新 Register + ListAndWatch
#     → kubelet 更新节点资源状态为 Healthy
#     → 调度恢复

# 查看 Device Plugin 日志
kubectl logs -n gpu-operator -l app=nvidia-device-plugin-daemonset
```

---

## 📖 GPU Operator 完整架构（已掌握）

```
┌─────────────────────────────────────────────────────────┐
│                    GPU Operator (Helm)                    │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────────────┐              │
│  │  Driver (DS) │  │ Container Toolkit    │              │
│  │  驱动安装/更新  │  │ nvidia-container-*  │              │
│  └─────────────┘  └──────────────────────┘              │
│  ┌────────────────┐  ┌──────────────────────┐           │
│  │ Device Plugin  │  │ GPU Feature Disc.    │           │
│  │ gRPC 资源注册   │  │ Node Labels 自动发现   │           │
│  └────────────────┘  └──────────────────────┘           │
│  ┌────────────┐   ┌─────────────┐   ┌──────────┐       │
│  │ DCGM Exp.  │   │ MIG Manager │   │Validator │       │
│  │ 指标导出    │   │ MIG 分区管理 │   │ 部署自检   │       │
│  └────────────┘   └─────────────┘   └──────────┘       │
└─────────────────────────────────────────────────────────┘
```

### 各组件职责与协作

| 组件 | 部署方式 | 职责 | Pod 调度关系 |
|------|---------|------|-------------|
| **nvidia-driver** | DaemonSet | 在每个 GPU 节点安装/更新 NVIDIA 驱动 | 仅 GPU 节点 |
| **nvidia-container-toolkit** | DaemonSet | 配置容器运行时支持 GPU 挂载 | 每个 GPU 节点 |
| **nvidia-device-plugin** | DaemonSet | 向 kubelet 注册 GPU 资源，处理 Allocate 请求 | 每个 GPU 节点 |
| **dcgm-exporter** | DaemonSet | 暴露 DCGM 指标（温度/功耗/ECC/利用率）给 Prometheus | 每个 GPU 节点 |
| **gpu-feature-discovery** | DaemonSet | 自动发现 GPU 型号/驱动版本/计算能力，打 Node Label | 每个 GPU 节点 |
| **nvidia-mig-manager** | DaemonSet | 管理 MIG 分区策略，自动创建/销毁 MIG 实例 | 仅 MIG 节点 |
| **validator** | Job | 安装后运行 GPU 验证测试，确认集群 GPU 可用 | 临时的 Pod |

### GFD（GPU Feature Discovery）自动打标签

```bash
# GFD 自动发现并打标签示例
kubectl describe node gpu01 | grep nvidia.com
# nvidia.com/gpu.product=NVIDIA-A100-SXM4-80GB
# nvidia.com/gpu.count=8
# nvidia.com/gpu.memory=81920
# nvidia.com/gpu.family=turing
# nvidia.com/cuda.driver-version=550.90.07
# nvidia.com/cuda.runtime-version=12.4
# nvidia.com/gpu.compute.major=8
# nvidia.com/gpu.compute.minor=0
```

### Operator 自检（Validator）

```yaml
# Validator 输出的测试项
# ✅ NVIDIA Driver Validation
# ✅ CUDA Validation
# ✅ Device Plugin Validation
# ✅ GPU Feature Discovery Validation
# ❌ MIG Manager Validation (if not configured)
```

---

## 📖 Topology Manager + GPU（已掌握）

### 为何需要拓扑感知

GPU 与 GPU 之间、GPU 与 CPU/内存之间存在 NUMA 亲和性：

```
NUMA Node 0                    NUMA Node 1
├── CPU 0-31                  ├── CPU 32-63
├── Memory 256GB              ├── Memory 256GB
├── GPU 0 ──NVLink── GPU 1    ├── GPU 2 ──NVLink── GPU 3
│    └──NVLink── GPU 4 ──────┘    └──NVLink── GPU 5
└── NIC mlx5_0                └── NIC mlx5_1
```

### Topology Manager 策略

```yaml
# Kubelet 配置 /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
topologyManagerPolicy: single-numa-node  # none | best-effort | restricted | single-numa-node
topologyManagerScope: container           # container | pod
featureGates:
  CPUManager: true
  MemoryManager: true
```

| 策略 | 行为 | 适用场景 |
|------|------|----------|
| `none` | 不做拓扑对齐 | 非 NUMA 硬件 |
| `best-effort` | 尽力对齐，失败不拒绝 | 开发/测试 |
| `restricted` | 强制对齐，失败则拒绝 Pod | 生产环境推荐 |
| `single-numa-node` | 最严格：所有资源必须在同一 NUMA node | 高性能训练 |

### Device Plugin 如何向 Topology Manager 提供拓扑信息

```json
// ListAndWatch Response 中携带 topology 字段
{
  "devices": [
    {
      "ID": "GPU-xxx-yyy",
      "topology": {
        "nodes": [{"ID": 0}]  // NUMA node 0
      }
    }
  ]
}
// Topology Manager 根据此信息决策是否满足 single-numa-node 约束
```

### 配置示例 — 严格拓扑对齐

```yaml
# Pod 使用 Topology Manager 示例
apiVersion: v1
kind: Pod
metadata:
  name: gpu-training-numa0
spec:
  containers:
  - name: trainer
    image: nvcr.io/nvidia/pytorch:24.06-py3
    resources:
      requests:
        memory: "200Gi"
        cpu: "30"
        nvidia.com/gpu: "4"
      limits:
        memory: "200Gi"
        cpu: "30"
        nvidia.com/gpu: "4"
  # 配合 CPU Manager static policy 和单 NUMA node 策略
  # 保证 4 张 GPU + 30 核 CPU + 200G 内存全部在 NUMA0 上
```

---

## 📖 Time-Slicing 深度解析（已掌握）

### 工作原理

```
物理时间线（1 秒）:
┌──────┬──────┬──────┬──────┐
│ PodA │ PodB │ PodC │ PodA │
└──────┴──────┴──────┴──────┘
  250ms  250ms  250ms  250ms

启用 Time-Slicing (replicas=4) 后:
1 GPU 被 Device Plugin 上报为 4 个 nvidia.com/gpu 资源
4 个 Pod 各分配到 1 个 "虚拟 GPU"
实际物理 GPU 通过 CUDA Time-Slicing 在进程间轮转
```

### 配置深度解析

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: device-plugin-config
data:
  time-slicing: |
    version: v1
    flags:
      migStrategy: none        # Time-Slicing 和 MIG 互斥
    sharing:
      timeSlicing:
        renameByDefault: false  # 不重命名资源名
        failRequestsGreaterThanOne: false  # 允许多副本请求
        resources:
          # 方案 1: 按切片数配置
          - name: nvidia.com/gpu
            replicas: 4
          # 方案 2: 多档位共存
          - name: nvidia.com/gpu
            replicas: 4
            rename: nvidia.com/gpu.shared
          # 保留整卡资源供训练使用
          - name: nvidia.com/gpu
            replicas: 1
            rename: nvidia.com/gpu.whole
```

### 时间片调度测率对比

| 特性 | Time-Slicing | MIG | MPS |
|------|-------------|-----|-----|
| 内存隔离 | ❌ 无 | ✅ 硬隔离 | ❌ 共享 |
| 故障隔离 | ❌ OOM 影响其他 | ✅ 独立 | ❌ 无 |
| 计算隔离 | ✅ 时间片 | ✅ 计算单元 | ✅ 上下文隔离 |
| 开销 | 低 | 启动时配置 | 运行时开销 |
| 显卡要求 | 所有 GPU | 仅 Ampere+ | 所有 GPU |
| 弹性 | ✅ 可以动态调整 | ❌ 需重启 | ✅ 动态 |
| 适用场景 | 开发调试/Jupyter 多租户 | 生产多租户推理 | 单用户多进程 |

### Time-Slicing 潜在问题

```bash
# 1. 显存爆炸 — 多 Pod 共享显存无隔离
# PodA 占用 70G，PodB 再申请 20G → OOM Kill
# 缓解: 设置 cudaLimit 或使用 MPS + 显存限制

# 2. 计算干扰 — 4 个 Pod 竞争 CUDA Core
# 某个 Pod 的 CUDA kernel 占用过长，其他 Pod 延迟飙升
# 缓解: 设置环境变量 CUDA_MPS_PIPE_DIRECTORY 限制并发

# 3. 碎片化调度 — 4 个 1 GPU Pod 占满所有节点
# 无法调度 8 GPU 训练任务
# 缓解: 使用 Volcano gang-scheduling 或 nodeSelector 区隔
```

---

## 📖 GPU 分配故障排查（已掌握）

### 问题1：GPU 未被检测到

```bash
# 症状: kubectl describe node | grep nvidia 无输出
# 排查步骤:

# 1. 检查 nvidia-device-plugin Pod 状态
kubectl get pods -n gpu-operator -l app=nvidia-device-plugin-daemonset -o wide

# 2. 查看 Device Plugin 日志
kubectl logs -n gpu-operator nvidia-device-plugin-daemonset-xxxxx

# 常见错误:
# - "no devices found" → 驱动未安装或 nvidia-smi 不可用
# - "failed to connect to nvidia-ml" → nvidia-persistenced 未启动
# - "NUMA node information not available" → 内核未编译 NUMA 支持

# 3. 节点侧检查
ssh gpu01 "nvidia-smi"                          # 驱动是否正常
ssh gpu01 "ls /dev/nvidia*"                      # 设备文件是否存在
ssh gpu01 "systemctl status nvidia-persistenced"  # persistence daemon
ssh gpu01 "ls /var/lib/kubelet/device-plugins/"  # socket 文件是否存在
```

### 问题2：Pod 请求 GPU 后一直 Pending

```bash
# 症状: Pod status = Pending
kubectl describe pod gpu-pod

# 常见原因:

# A. GPU 资源不足
#    Events: 0/3 nodes are available: 3 Insufficient nvidia.com/gpu
kubectl describe node gpu01 | grep -A5 "Allocated resources"
# → 确认已分配的 GPU 数量和剩余数量

# B. 节点有 Taints
kubectl describe node gpu01 | grep Taints
# 如有 nvidia.com/gpu:NoSchedule，Pod 需要 toleration

# C. Topology Manager 拒绝（restricted/single-numa-node）
#    Events: TopologyAffinityError
# → 调整 topologyManagerPolicy 为 best-effort 或减少资源请求

# D. MIG 配置未生效
ssh gpu01 "nvidia-smi mig -lgi"       # 查看 MIG 实例
kubectl get node gpu01 -o json | jq '.status.allocatable | with_entries(select(.key|startswith("nvidia.com/mig")))'
# → 确认 MIG 是否正确创建并上报

# E. Time-Slicing ConfigMap 未挂载
kubectl get configmap -n gpu-operator device-plugin-config -o yaml
# → 检查是否正确配置并挂载到 Device Plugin Pod
```

### 问题3：Device Plugin 崩溃/重启循环

```bash
# 症状: nvidia-device-plugin Pod 反复重启
kubectl get pods -n gpu-operator -w

# 常见原因与修复:
# 1. 驱动版本不兼容 → 匹配驱动版本和 Device Plugin 版本
# 2. OOM → 增加 memory limits:
kubectl patch daemonset -n gpu-operator nvidia-device-plugin-daemonset \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"nvidia-device-plugin","resources":{"limits":{"memory":"1Gi"}}}]}}}}'

# 3. ConfigMap 格式错误 → 校验 YAML:
kubectl get configmap -n gpu-operator device-plugin-config -o jsonpath='{.data}' | yq eval -P

# 4. 内核模块冲突 → 检查 dmesg:
ssh gpu01 "dmesg | grep -i nvidia | tail -20"
```

### 问题4：MIG 未正确暴露

```bash
# 症状: MIG 已配置但 k8s 看不到 mig slice

# 排查:
# 1. 确认物理 MIG 配置
ssh gpu01 "nvidia-smi mig -lgi"
# 预期输出:
# GPU 0: 2g.20gb × 2, 1g.10gb × 4 (示例)

# 2. 确认 MIG Manager 策略
kubectl get migconfig -n gpu-operator -o yaml
# 检查 spec.mig.config.name 是否正确

# 3. 确认 MIG Strategy
kubectl logs -n gpu-operator nvidia-device-plugin-xxx | grep "mig-strategy"
# migStrategy: mixed  → 同时暴露整卡和 MIG 切片
# migStrategy: single → 只暴露 MIG 切片
# migStrategy: none   → 不暴露 MIG

# 4. 确认战略 ConfigMap 已创建
kubectl get configmap -n gpu-operator mig-config -o yaml
```

---

## 📖 多版本 GPU Operator 策略（已掌握）

### 驱动/CUDA/Operator 兼容矩阵

| GPU Operator | Device Plugin | 驱动版本(推荐) | CUDA | K8s 版本 | GPU 架构 |
|-------------|---------------|---------------|------|---------|---------|
| v24.9.x | v0.15.x | 550.x | 12.4 | 1.28-1.30 | Ampere/Hopper/Ada |
| v24.6.x | v0.14.x | 545.x | 12.3 | 1.27-1.29 | Ampere/Hopper |
| v23.9.x | v0.13.x | 535.x | 12.2 | 1.26-1.28 | Ampere |
| v23.6.x | v0.12.x | 525.x | 12.1 | 1.25-1.27 | 所有架构 |

### Canary 升级策略

```bash
# Step 1: 标记 canary 节点
kubectl label node gpu01 gpu-operator-upgrade=canary

# Step 2: 部署新版本 Operator 仅到 canary 节点
cat > gpu-operator-v2-values.yaml << EOF
operator:
  defaultRuntime: containerd
devicePlugin:
  version: "v0.16.0"
  args: ["--mig-strategy=mixed"]
driver:
  version: "555.42.02"
EOF

helm upgrade --install gpu-operator-v2 nvidia/gpu-operator \
  --namespace gpu-operator-v2 --create-namespace \
  --version v24.12.0 \
  --values gpu-operator-v2-values.yaml \
  --set nodeSelector.gpu-operator-upgrade=canary

# Step 3: 验证 canary 节点
# 运行训练任务到 gpu01，监控 GPU 指标
kubectl run benchmark --image=nvcr.io/nvidia/pytorch:24.06-py3 \
  --restart=Never --overrides='{"spec":{"nodeSelector":{"kubernetes.io/hostname":"gpu01"}}}' \
  -- nvidia-smi && python -c "import torch; print(torch.cuda.device_count())"

# Step 4: 灰度扩量
# 增加 canary 节点数量，逐步验证
kubectl label node gpu02 gpu03 gpu-operator-upgrade=canary

# Step 5: 全量切换
helm uninstall gpu-operator -n gpu-operator
helm upgrade --install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --version v24.12.0 \
  --values gpu-operator-v2-values.yaml
```

### 版本固定与回滚

```bash
# 固定版本（防止意外升级）
helm upgrade --install gpu-operator nvidia/gpu-operator \
  --version v24.9.0 \
  --set operator.upgradePolicy.reconcileInterval=0 \
  --values gpu-operator-values.yaml

# 回滚到上一版本
helm rollback gpu-operator -n gpu-operator

# 查看历史版本
helm history gpu-operator -n gpu-operator

# 回滚到指定版本
helm rollback gpu-operator 3 -n gpu-operator
```

---

## 关键要点

### Device Plugin 配置

```yaml
# nvidia-device-plugin 配置示例
apiVersion: v1
kind: ConfigMap
metadata:
  name: nvidia-device-plugin-config
data:
  config.yaml: |
    version: v1
    flags:
      migStrategy: mixed        # none | single | mixed
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 4         # 每卡 4 个时间片
```

### Pod 请求示例

```yaml
# 整卡请求
apiVersion: v1
kind: Pod
metadata:
  name: train-job
spec:
  containers:
  - name: trainer
    resources:
      limits:
        nvidia.com/gpu: 8
---
# MIG 切片请求
apiVersion: v1
kind: Pod
metadata:
  name: inference-instance
spec:
  containers:
  - name: server
    resources:
      limits:
        nvidia.com/mig-1g.10gb: 1
```

## 常见问题

1. **GPU 碎片化**：MIG 切分后无法动态调整，需提前规划
2. **拓扑感知缺失**：K8s 原生不感知 NVLink 拓扑，需 Topology Manager + Volcano
3. **Time-Slicing 的内存隔离**：时间片共享不隔离显存，OOM 风险
4. **Device Plugin 重启**：插件重启会导致已分配 GPU 的 Pod 异常

## 关联知识

- [[Volcano 调度器实战]]
- [[GPU 资源分配与隔离策略]]
- [[Device Plugin 与 DRA 对比]] — DRA 详细对比独立笔记
- [[../hardware/NVIDIA GPU 架构演进]]
- [[../automation/GPU 驱动与固件管理]] — 驱动管理与 Device Plugin
- [[../../k8s/特性详解/DRA 动态资源分配详解]] — K8s 原生 DRA 机制

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 框架搭建 | 2026-06-29 | 骨架创建 |
| DRA 对比 | 2026-06-30 | Device Plugin vs DRA 独立笔记 |
| 实战展开 | 2026-06-30 | Device Plugin 内部机制、GPU Operator 架构、Topology Manager、Time-Slicing、故障排查、多版本策略 |

## 状态标记

📖 已掌握 — Device Plugin gRPC 全链路（ListAndWatch/Allocate）、GPU Operator 7 组件架构与协作、Topology Manager 与 Device Plugin 配合、Time-Slicing 原理与配置、GPU 分配常见问题排查、多版本 Canary 升级与回滚
📝 待补充 — Volcano gang-scheduling 集成示例、DRA 与 Device Plugin 迁移路径、GPU 碎片整理自动 rebalance 方案

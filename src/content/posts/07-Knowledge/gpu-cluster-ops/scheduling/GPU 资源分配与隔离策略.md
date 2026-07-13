---
date: 2026-06-30
tags:
  - gpu
  - scheduling
  - mig
  - time-slicing
  - mps
  - isolation
type: 学习笔记
category: GPU集群运维/调度
source: NVIDIA 官方文档 + K8s Device Plugin 文档
difficulty: 进阶
title: "GPU 资源分配与隔离策略"
---

# GPU 资源分配与隔离策略

> GPU 资源的分配策略（整卡、MIG 物理分区、Time-Slicing 时间片、MPS 进程共享）各有优劣。选对策略直接影响集群利用率和任务稳定性。

---

## 一、四种策略对比

| 策略 | 隔离级别 | 显存隔离 | 故障隔离 | 性能损耗 | 适用场景 |
|------|:------:|:------:|:------:|:------:|------|
| **整卡分配** | 硬件 | ✅ | ✅ | 0% | 大模型训练 |
| **MIG** | 硬件（SM+显存） | ✅ | ✅ | 0% | 推理多租户 |
| **Time-Slicing** | 时间片轮转 | ❌ 共享 | ❌ OOM 互相影响 | <5% | 开发调试 |
| **MPS** | 进程级上下文 | ❌ 共享 | ❌ 单进程崩溃全挂 | <3% | 小模型批量推理 |

---

## 二、MIG 详解

### 2.1 A100 MIG 配置

```
A100 40GB:
┌────────────────────────────────────────────────┐
│ 配置 1: 7 × 1g.5gb  (每个实例 1/7 SM + 5GB)    │
│ 配置 2: 3 × 2g.10gb (每个实例 2/7 SM + 10GB)   │
│ 配置 3: 2 × 3g.20gb (每个实例 3/7 SM + 20GB)   │
│ 配置 4: 1 × 7g.40gb (整卡)                      │
│ 混合: 1×3g.20gb + 2×2g.10gb                    │
└────────────────────────────────────────────────┘

A100 80GB:
  支持 1g.10gb, 2g.20gb, 3g.40gb, 4g.40gb, 7g.80gb
```

### 2.2 H100 MIG 增强

```
H100 MIG 改进:
- 最大 14 个 GI (GPU Instance)，每个 GI 最多 14 个 CI (Compute Instance)
- MIG 模式下 NVLink 仍可用（A100 MIG 禁用 NVLink）
- 更灵活的配置: 1g.5gb ~ 7g.80gb，支持异构混合
```

### 2.3 MIG 管理命令

```bash
# 启用 MIG 模式（需重启 GPU）
nvidia-smi -i 0 -mig 1

# 创建 MIG 配置
nvidia-smi mig -cgi 9,9,9,9,9,9,9 -C  # 7 × 1g.5gb 在 GPU 0

# 查看 MIG 状态
nvidia-smi mig -lgi
nvidia-smi mig -lci

# 销毁所有 MIG 配置
nvidia-smi mig -dci
nvidia-smi mig -dgi

# 恢复整卡模式
nvidia-smi -i 0 -mig 0
```

### 2.4 MIG 在 K8s 中

```yaml
# 启用 MIG 后，device plugin 自动暴露 mig 资源
# Pod 请求 MIG slice:
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: inference
    resources:
      limits:
        nvidia.com/mig-1g.10gb: 1
```

---

## 三、Time-Slicing

```yaml
# nvidia-device-plugin 配置
data:
  config.yaml: |
    version: v1
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 4    # 1 物理 GPU 暴露为 4 个虚拟 GPU
          - name: nvidia.com/mig-1g.10gb
            replicas: 2    # 1 MIG slice 暴露为 2 个虚拟 slice
```

**⚠️ 风险**：显存不隔离，某个 Pod OOM 会连带影响同 GPU 上所有 Pod。

---

## 四、MPS

```bash
# 启动 MPS 守护进程
nvidia-cuda-mps-control -d

# 多个进程自动共享 GPU 上下文
# 适合：大量小推理请求，不需要严格隔离的场景
```

---

## 五、策略选择决策树

```
需要严格隔离？（多租户/生产推理）
├── 是 → 需要多卡互联？
│         ├── 是 → 整卡（MIG 禁 NVLink on A100）
│         └── 否 → MIG
│
└── 否 → 需要显存隔离？
          ├── 是 → MIG 或整卡
          └── 否 → 负载类型？
                    ├── 高并发小推理 → MPS
                    └── 交互式开发 → Time-Slicing
```

---

## 关联知识

- [[K8s GPU 调度机制详解]] — Device Plugin 中如何暴露这些资源
- [[Device Plugin 与 DRA 对比]] — DRA 对共享策略的原生支持
- [[Volcano 调度器实战]] — 批量调度器与资源隔离配合
- [[../hardware/NVIDIA GPU 架构演进]] — MIG 在各代架构中的支持
- [[GPU 集群运维知识总览]] — 返回总览

## 参考资源

- [NVIDIA MIG 用户指南](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/)
- [K8s Device Plugin Time-Slicing](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html)

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 内容创建 | 2026-06-30 | MIG/Time-Slicing/MPS 对比与实战 |

## 状态标记

📖 已掌握 — 四种策略对比、MIG 配置命令、K8s 集成
📝 待补充 — H100 MIG 混合配置最佳实践、MPS 性能 benchmark、DRA 共享策略进阶

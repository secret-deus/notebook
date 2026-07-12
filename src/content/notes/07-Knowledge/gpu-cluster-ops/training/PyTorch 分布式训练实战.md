---
date: 2026-06-30
tags:
  - gpu
  - pytorch
  - distributed-training
  - fsdp
  - ddp
type: 学习笔记
category: GPU集群运维/训练
source: PyTorch 官方文档 + 个人整理
difficulty: 进阶
title: "PyTorch 分布式训练实战"
---

# PyTorch 分布式训练实战

> PyTorch 分布式训练的四种并行策略实战指南：DDP、FSDP、张量并行、流水线并行。从 torchrun 启动到性能调优，覆盖 GPU 集群运维中最常见的训练场景。

## 1. DDP (DistributedDataParallel)

### 1.1 工作原理

DDP 在每个 GPU 上维护完整模型副本。前向传播各自独立计算，反向传播时通过 **AllReduce** 同步梯度。默认使用 `NCCL` 后端，通信模式为 **bucket-based gradient reduction**：梯度被分组到 bucket 中，一旦某个 bucket 内所有梯度就绪，立即启动异步 AllReduce，与 backward 计算重叠。

```python
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel as DDP

dist.init_process_group(backend="nccl")
model = Model().cuda(local_rank)
model = DDP(model, device_ids=[local_rank])
```

### 1.2 Gradient Sync 模式

- **默认**：每个 backward step 后自动触发 bucket AllReduce
- **no_sync()**：累积多个 micro-batch 梯度后再同步，等同于梯度累积

```python
# 梯度累积 + DDP no_sync
for i, batch in enumerate(dataloader):
    context = model.no_sync() if (i + 1) % accum_steps != 0 else nullcontext()
    with context:
        loss = model(batch) / accum_steps
        loss.backward()
    if (i + 1) % accum_steps == 0:
        optimizer.step()
        optimizer.zero_grad()
```

### 1.3 适用 vs 不适用场景

| 适用 | 不适用 |
|------|--------|
| 模型可放入单卡显存 | 单卡放不下完整模型 |
| 数据量极大需要加速 | 模型参数量 > 70B |
| batch size 足够大 | 需要极致显存利用 |
| DDP 通信开销可接受 | 跨节点带宽瓶颈严重 |

### 1.4 torchrun 启动

```bash
# 单机 8 卡
torchrun --nproc_per_node=8 train.py

# 多机 32 卡（4 节点 × 8卡）
torchrun --nproc_per_node=8 --nnodes=4 \
  --node_rank=$NODE_RANK \
  --master_addr=$MASTER_ADDR \
  --master_port=29500 train.py
```

---

## 2. FSDP (FullyShardedDataParallel)

### 2.1 核心思想

FSDP 将模型参数、梯度和优化器状态 **分片 (shard)** 到所有 GPU 上。计算时按需通过 **all-gather** 收集参数，计算完成后释放回分片状态。这使单 GPU 显存仅需保存 `总参数量 / world_size` 的参数，大幅降低显存需求。

### 2.2 FSDP1 vs FSDP2

| 特性 | FSDP1 (torch.distributed.fsdp) | FSDP2 (torch.distributed.fsdp) |
|------|-------------------------------|-------------------------------|
| 引入版本 | PyTorch 1.11 | PyTorch 2.0+ |
| API | `FullyShardedDataParallel` 包装整个模型 | `fully_shard()` 逐层应用 |
| 粒度 | module-level wrapping | per-parameter sharding |
| DTensor | 不支持 | 原生 DTensor，支持 TP 组合 |
| 推荐 | 旧代码兼容 | PyTorch 2.0+ 新项目 |

**FSDP2 示例：**

```python
from torch.distributed.fsdp import fully_shard
from torch.distributed._composable.fsdp import MixedPrecisionPolicy
import torch.distributed as dist

dist.init_process_group(backend="nccl")
model = MyModel().cuda()
# 逐层应用 FSDP
for layer in model.layers:
    fully_shard(layer)
fully_shard(model)
```

### 2.3 Sharding Strategies

| Strategy | 分片内容 | 通信量 | 显存节省 | 适用场景 |
|----------|---------|--------|---------|---------|
| `FULL_SHARD` | 参数 + 梯度 + 优化器 | 高 | 最高 | 单机多卡，模型超大 |
| `SHARD_GRAD_OP` | 梯度 + 优化器（参数不分片） | 中 | 中等 | 参数刚好超出单卡 |
| `HYBRID_SHARD` | 节点内副本，节点间分片 | 中 | 较高 | 多机场景，减少跨节点通信 |
| `NO_SHARD` | 无（等价 DDP） | 低 | 无 | 显存充足时 |

**HYBRID_SHARD 配置：**

```python
from torch.distributed.fsdp import HybridShard, ShardingStrategy

# 节点内 DDP 副本 + 节点间 FULL_SHARD
strategy = HybridShard(
    intra_node_sharding_strategy=ShardingStrategy.NO_SHARD,
    inter_node_sharding_strategy=ShardingStrategy.FULL_SHARD,
)
```

### 2.4 内存节省计算

假设模型 70B 参数，FP32 优化器，Adam (momentum + variance = 2× 参数)，world_size=64：

| 组件 | 无分片(GB) | FULL_SHARD(GB/卡) |
|------|-----------|-------------------|
| 参数 (FP32) | 70 × 4 = 280 | 280 / 64 = 4.4 |
| 梯度 (FP32) | 280 | 4.4 |
| 优化器状态 | 280 × 2 = 560 | 8.8 |
| **总计** | **≈1120 GB** | **≈17.6 GB/卡** |

> 实际还需加上激活内存（受 batch size 和 activation checkpointing 影响）。

---

## 3. Tensor Parallel + FSDP (2D 并行)

### 3.1 组合策略

- **TP（张量并行）**：在 **节点内** 利用 NVLink 高带宽（900 GB/s）切分单层参数，减少激活内存
- **FSDP/DP**：在 **节点间** 做数据并行，利用 InfiniBand/RoCE 通信

这种组合也称为 **2D 并行**（TP + DP），是训练 70B+ 模型的标配。

### 3.2 DTensor 实现（PyTorch 2.0+）

```python
import torch.distributed as dist
import torch.distributed.tensor as dtensor
from torch.distributed.tensor.parallel import (
    parallelize_module,
    ColwiseParallel,
    RowwiseParallel,
)
from torch.distributed.device_mesh import init_device_mesh

# 构建 2D 设备网格: tp_size=4 节点内, dp_size=8 节点间
mesh = init_device_mesh("cuda", (8, 4), mesh_dim_names=("dp", "tp"))

# TP 切分 attention + MLP
parallelize_plan = {
    "q_proj": ColwiseParallel(),
    "k_proj": ColwiseParallel(),
    "v_proj": ColwiseParallel(),
    "o_proj": RowwiseParallel(),
}
model = parallelize_module(model, mesh["tp"], parallelize_plan)

# 再对剩余维度应用 FSDP（dp mesh 维）
from torch.distributed.fsdp import fully_shard
for layer in model.layers:
    fully_shard(layer, mesh=mesh["dp"])
```

### 3.3 实际配置示例（8 节点 × 8×H100, 训练 Llama-70B）

```bash
# 节点内 TP=4（NVLink 900 GB/s），节点间 FSDP
# 每个节点 8 GPU → tp_size=4 形成 2 个 TP 组
# 8 节点 → dp_size=8×2=16 个 DP rank

torchrun --nproc_per_node=8 --nnodes=8 \
  --node_rank=$RANK --master_addr=$MASTER --master_port=29500 \
  train_tp_fsdp.py \
  --tp_size=4 \
  --model_name meta-llama/Llama-2-70b-hf \
  --batch_size=1 \
  --gradient_accumulation_steps=16
```

---

## 4. torchrun 命令行详解

### 4.1 所有关键标志

| 标志 | 含义 | 示例 |
|------|------|------|
| `--nproc_per_node` | 每节点进程数（通常 = 每节点 GPU 数） | `8` |
| `--nnodes` | 总节点数 | `4` |
| `--node_rank` | 当前节点编号 (0-based) | `$SLURM_NODEID` 或 `$RANK` |
| `--master_addr` | rank 0 所在节点的 IP/域名 | `$MASTER_ADDR` |
| `--master_port` | rank 0 监听端口 | `29500` |
| `--rdzv_backend` | rendezvous 后端（static / c10d / etcd） | `c10d` (默认) |
| `--rdzv_endpoint` | rendezvous 地址（替代 master_addr:master_port） | `$MASTER_ADDR:29500` |
| `--rdzv_id` | rendezvous 唯一 ID（同一 job 共享） | `$(date +%s)` |
| `--max_restarts` | 失败自动重启次数 | `3` |
| `--log_dir` | 各 rank 的日志输出目录 | `./logs` |

### 4.2 生产环境启动示例

```bash
#!/bin/bash
# SLURM 环境
export MASTER_ADDR=$(scontrol show hostnames $SLURM_JOB_NODELIST | head -n1)
export MASTER_PORT=29500
export OMP_NUM_THREADS=12

torchrun \
  --nproc_per_node=${SLURM_GPUS_PER_NODE:-8} \
  --nnodes=${SLURM_NNODES} \
  --node_rank=${SLURM_NODEID} \
  --master_addr=${MASTER_ADDR} \
  --master_port=${MASTER_PORT} \
  --rdzv_backend=c10d \
  --rdzv_endpoint=${MASTER_ADDR}:${MASTER_PORT} \
  --max_restarts=3 \
  train.py
```

---

## 5. 实战训练脚本

### 5.1 最小 FSDP 训练循环

```python
import os
import torch
import torch.distributed as dist
import torch.distributed.fsdp as fsdp
from torch.distributed.fsdp import FullyShardedDataParallel as FSDP
from torch.distributed.fsdp import ShardingStrategy, MixedPrecision
from torch.distributed.fsdp.wrap import transformer_auto_wrap_policy
from functools import partial

def main():
    local_rank = int(os.environ["LOCAL_RANK"])
    torch.cuda.set_device(local_rank)
    dist.init_process_group(backend="nccl")

    model = MyModel().cuda()
    auto_wrap_policy = partial(
        transformer_auto_wrap_policy,
        transformer_layer_cls={TransformerBlock},
    )
    mixed_precision = MixedPrecision(
        param_dtype=torch.bfloat16,
        reduce_dtype=torch.bfloat16,
        buffer_dtype=torch.bfloat16,
    )
    model = FSDP(
        model,
        sharding_strategy=ShardingStrategy.FULL_SHARD,
        auto_wrap_policy=auto_wrap_policy,
        mixed_precision=mixed_precision,
        device_id=torch.cuda.current_device(),
    )

    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4)
    scaler = torch.cuda.amp.GradScaler()

    for epoch in range(3):
        for batch in dataloader:
            optimizer.zero_grad()
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                loss = model(batch)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()

    dist.destroy_process_group()

if __name__ == "__main__":
    main()
```

### 5.2 Checkpoint 保存与加载

```python
# === 保存 ===
from torch.distributed.fsdp import FullStateDictConfig, StateDictType

save_policy = FullStateDictConfig(offload_to_cpu=True, rank0_only=True)
with FSDP.state_dict_type(model, StateDictType.FULL_STATE_DICT, save_policy):
    state_dict = model.state_dict()
if dist.get_rank() == 0:
    torch.save({"model": state_dict, "optimizer": optimizer.state_dict()}, "ckpt.pt")

# === 加载 ===
checkpoint = torch.load("ckpt.pt", map_location="cpu")
with FSDP.state_dict_type(model, StateDictType.FULL_STATE_DICT):
    model.load_state_dict(checkpoint["model"])
optimizer.load_state_dict(checkpoint["optimizer"])
```

### 5.3 Mixed Precision (torch.cuda.amp)

```python
# bf16: 不需要 GradScaler（bf16 动态范围大，不易溢出）
with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
    loss = model(batch)
loss.backward()

# fp16: 需要 GradScaler 防溢出
scaler = torch.cuda.amp.GradScaler()
with torch.autocast(device_type="cuda", dtype=torch.float16):
    loss = model(batch)
scaler.scale(loss).backward()
scaler.step(optimizer)
scaler.update()
```

---

## 6. 性能调优

### 6.1 梯度累积

```python
for step, batch in enumerate(dataloader):
    with torch.autocast("cuda", dtype=torch.bfloat16):
        loss = model(batch) / GRADIENT_ACCUMULATION_STEPS
    loss.backward()  # 累积梯度，不同步
    if (step + 1) % GRADIENT_ACCUMULATION_STEPS == 0:
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()
        optimizer.zero_grad()
```

### 6.2 激活检查点 (Activation Checkpointing)

将中间激活丢弃，反向传播时重新计算，以计算换显存。

```python
from torch.distributed.fsdp.wrap import _module_wrap_policy
from torch.distributed.algorithms._checkpoint.checkpoint_wrapper import (
    checkpoint_wrapper,
    CheckpointImpl,
    apply_activation_checkpointing,
)

# FSDP + Activation Checkpointing
non_reentrant_wrapper = partial(
    checkpoint_wrapper, checkpoint_impl=CheckpointImpl.NO_REENTRANT,
)
apply_activation_checkpointing(
    model, checkpoint_wrapper_fn=non_reentrant_wrapper,
    check_fn=lambda m: isinstance(m, TransformerBlock),
)
```

### 6.3 torch.compile

```python
# FSDP2 + torch.compile (PyTorch 2.2+)
model = torch.compile(model, mode="reduce-overhead")
# mode 选项:
# "default"  — 适度优化，少量编译开销
# "reduce-overhead" — 更好性能，更多编译时间
# "max-autotune" — 最佳性能，最长编译时间
```

### 6.4 核心调优参数汇总

| 参数/技术 | 效果 | 代价 |
|-----------|------|------|
| `gradient_accumulation_steps` | 增大有效 batch size | 更多 forward pass |
| `activation_checkpointing` | 显存节省 30-50% | 约 15-20% 额外计算 |
| `torch.compile(mode="reduce-overhead")` | 吞吐提升 10-30% | 首次编译时间 |
| `OMP_NUM_THREADS=12` | 减少 CPU 争抢 | 需根据节点核心数调 |
| `NCCL_NSOCKS_PERTHREAD=4` | 提升 NCCL 通信并发 | 需配合 NCCL_SOCKET_NTHREADS |
| `pin_memory=True` in DataLoader | 加速 CPU→GPU 传输 | 额外 CPU 内存 |

---

## 7. 故障排查

### 7.1 OOM 修复清单

```bash
# 1. 降低 batch size
# 2. 开启 activation checkpointing
activation_checkpointing(model, ...)

# 3. 使用 FSDP FULL_SHARD（替代 DDP/SHARD_GRAD_OP）
ShardingStrategy.FULL_SHARD

# 4. 启用 CPU offload
from torch.distributed.fsdp import CPUOffload
FSDP(model, cpu_offload=CPUOffload(offload_params=True))

# 5. 使用 bf16 替代 fp32 训练
torch.autocast("cuda", dtype=torch.bfloat16)

# 6. 检查是否启用了 pin_memory，禁用看是否缓解
DataLoader(..., pin_memory=False)
```

### 7.2 NCCL 初始化超时

```bash
# 症状: "NCCL timeout" 或 "init_process_group" 卡住
# 原因: 网络不通、防火墙、IB 驱动问题、不同节点 CUDA 版本不一致

# 排查步骤:
# 1. 检查所有节点通信
pdsh -w node[01-04] nvidia-smi

# 2. 检查 InfiniBand / RoCE
ibstat          # InfiniBand
ib_write_bw     # 带宽测试

# 3. 增加 NCCL 超时 + 开启调试日志
export NCCL_TIMEOUT=1800
export NCCL_DEBUG=INFO
export NCCL_IB_DISABLE=1   # 临时禁用 IB，测试 TCP 是否通
```

### 7.3 GPU 利用率不均

```python
# 原因1: DataLoader worker 数不足
DataLoader(dataset, num_workers=8, pin_memory=True)

# 原因2: 某些 rank 计算量不均（如不均衡的 padding）
# → 使用 packed dataset / sorted batching

# 原因3: 通信等待 —— 检查 FSDP sharding strategy
# 节点内用 FULL_SHARD，节点间用 HYBRID_SHARD 减少跨节点通信
```

### 7.4 DataLoader 瓶颈检测

```python
# 添加 CUDA 事件计时器，检测 CPU→GPU 是否拖后腿
import time
from torch.cuda import Event

start_event = Event(enable_timing=True)
end_event = Event(enable_timing=True)

for batch in dataloader:
    start_event.record()
    loss = model(batch)
    end_event.record()
    torch.cuda.synchronize()
    elapsed = start_event.elapsed_time(end_event)  # ms
    # 若 GPU 计算时间占比 < 70%，说明 DataLoader 是瓶颈
```

---

## 关联知识

- [[分布式训练框架对比]]
- [[../network/NCCL 通信原理与调优]]
- [[../performance/GPU 集群性能调优指南]]
- [[../hardware/NVLink 与 NVSwitch 拓扑详解]]
- [[GPU 集群运维知识总览]]

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 骨架创建 | 2026-06-30 | 框架搭建 |

## 状态标记

📖 已掌握 — DDP 原理与 torchrun 启动
📖 已掌握 — FSDP sharding strategies 与显存计算
📖 已掌握 — Mixed Precision (bf16/fp16) 训练
📖 已掌握 — Gradient accumulation + clipping + activation checkpointing
📝 待补充 — FSDP2 + torch.compile 端到端实测性能数据
📝 待补充 — Pipeline Parallel (torch.distributed.pipelining) 详细实战
📝 待补充 — DeepSpeed ZeRO Stage 1/2/3 与 FSDP 的对比 benchmark

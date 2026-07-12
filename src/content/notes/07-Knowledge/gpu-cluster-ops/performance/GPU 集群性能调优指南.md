---
date: 2026-06-30
tags:
  - gpu
  - performance
  - tuning
  - cuda
  - nccl
type: 学习笔记
category: GPU集群运维/性能优化
source: NVIDIA 性能优化指南 + 实战经验
difficulty: 高级
status: 📖 已掌握
title: "GPU 集群性能调优指南"
---

# GPU 集群性能调优指南

> 从 MFU 测量到 Kernel 级优化的完整实战手册，覆盖 CUDA、NCCL、内存、流水线、Profiling 全链路。

## 1. MFU (Model FLOPs Utilization)

### 1.1 计算方式

```
MFU = 实际 FLOPs / (GPU 理论峰值 FLOPs × GPU 数量 × 训练时间)

实际 FLOPs ≈ 6 × N_params × tokens_per_step    (Transformer 前向)
         + 12 × N_params × tokens_per_step    (反向，约前向的 2x)
         = 18 × N_params × tokens_per_step    (总计)
```

**更精确的估算**（考虑 Attention 和 FFN）：

```python
def estimate_transformer_flops(B, S, H, L, V):
    """
    B: batch size, S: seq_len, H: hidden_dim
    L: num_layers, V: vocab_size
    Returns: total FLOPs for one step (fwd + bwd)
    """
    d_ff = 4 * H
    # Attention: 4H²·S (QKV proj + output) + 2H·S² (scores)
    attn = L * (4 * B * S * H * H + 2 * B * H * S * S)
    # FFN: 2 * B * S * H * d_ff (two matmuls)
    ffn = L * (2 * B * S * H * d_ff)
    # Embedding: B * S * H * V  (negligible for large models)
    emb = B * S * H * V
    fwd = attn + ffn + emb
    return 3 * fwd  # fwd ≈ bwd×2, fwd+bwd = 3×fwd
```

### 1.2 不同 GPU 的 MFU 参考值

| GPU 型号 | 理论峰值 (BF16 TFLOPS) | 优秀 MFU | 良好 MFU | 及格线 | 典型瓶颈 |
|----------|----------------------|----------|----------|--------|----------|
| A100-80GB SXM | 312 | 50-60% | 40-50% | 30% | 通信占比大 |
| A100-80GB PCIe | 312 | 45-55% | 35-45% | 25% | PCIe 带宽限制 |
| H100 SXM | 990 | 45-55% | 35-45% | 25% | HBM 带宽更易成为瓶颈 |
| H200 SXM | 990 | 48-58% | 38-48% | 28% | 更大 HBM，缓解部分瓶颈 |
| H800 (国内特供) | 756 | 45-55% | 35-45% | 25% | NVLink 阉割，跨节点影响大 |
| L40S | 362 (FP8) | 35-45% | 25-35% | 20% | 无 NVLink，多卡扩展差 |

> **关键认知**：H100 的 MFU 普遍低于 A100，因为算力增长远超显存带宽增长，导致更多时间花在数据搬运上。

### 1.3 如何测量 MFU

```bash
# 方法1: PyTorch Profiler 获取 Kernel 执行时间
python -m torch.distributed.run --nproc_per_node=8 train.py \
    --profile --profile_out trace.json

# 方法2: 使用 NVIDIA 的 megatron-lm 内置 MFU 日志
# megatron 会自动在日志中打印:
# [2026-06-30 10:00:00] iteration 100/1000 | consumed samples: 12800
# | elapsed time per iteration (ms): 520.3 | throughput per GPU (TFLOPs): 156.2
# | MFU: 51.2%

# 方法3: 手动计算
GPU_TFLOPS=312  # A100 BF16
WORLD_SIZE=64   # 64 GPUs
STEP_TIME_MS=520
MODEL_PARAMS=70e9  # 70B model
GLOBAL_BATCH=1024
SEQ_LEN=4096

# tokens per step
TOKENS=$(( GLOBAL_BATCH * SEQ_LEN ))
# FLOPs = 18 * params * tokens  (simplified)
FLOPS=$(echo "18 * $MODEL_PARAMS * $TOKENS" | bc -l)
# MFU
MFU=$(echo "scale=2; $FLOPS / ($GPU_TFLOPS * 1e12 * $WORLD_SIZE * ($STEP_TIME_MS / 1000)) * 100" | bc)
echo "MFU: ${MFU}%"
```

## 2. GPU-Level Tuning

### 2.1 混合精度训练

```python
# PyTorch 自动混合精度 (AMP)
from torch.cuda.amp import autocast, GradScaler

scaler = GradScaler()  # FP16 需要；BF16 不需要 scaler

for data, target in dataloader:
    with autocast(dtype=torch.bfloat16):  # 或 torch.float16
        output = model(data)
        loss = criterion(output, target)
    scaler.scale(loss).backward()
    scaler.step(optimizer)
    scaler.update()
```

**精度选择决策树**：

```
                     启动训练
                        │
          ┌─────────────┴─────────────┐
          │ GPU 支持 BF16？           │
          │ (A100/H100/...)           │
          └─────────────┬─────────────┘
                 ┌──────┴──────┐
                是             否
                 │              │
             用 BF16         显卡支持 FP8？
             无需 scaler          │
                          ┌──────┴──────┐
                         是             否
                          │              │
                  Transformer 引擎   用 FP16 + scaler
                  (te.fp8_autocast)  注意 loss scaling
```

**FP8 训练示例（Hopper 架构专属）**：

```python
import transformer_engine.pytorch as te
from transformer_engine.common.recipe import Format, DelayedScaling

# FP8 训练配置
fp8_format = Format.HYBRID  # E4M3 forward, E5M2 backward
fp8_recipe = DelayedScaling(
    margin=0, interval=1, fp8_format=fp8_format,
    amax_history_len=16,
    amax_compute_algo="max",
)

# 替换 Linear 层
model = te.Linear(in_features, out_features)  # 自动使用 FP8

# 训练循环
with te.fp8_autocast(enabled=True, fp8_recipe=fp8_recipe):
    output = model(data)
    loss = criterion(output, target)
loss.backward()
```

### 2.2 Tensor Core 利用率

Tensor Core 触发条件（CUDA Core 不满足即回退）：

| 条件 | 要求 |
|------|------|
| 矩阵维度 | M, N, K 为 8 的倍数 (FP16) 或 16 的倍数 (FP8) |
| 内存对齐 | 128 字节对齐 |
| 数据类型 | FP16, BF16, TF32, FP8, INT8 |
| cuBLAS 使用 | 必须在 `torch.matmul` 或 `F.linear` 中触发 |

```python
# 检查 Tensor Core 是否被使用
# 方法1: ncu profiler
ncu --set full --section SpeedOfLight \
    python train.py

# 方法2: PyTorch 检查
import torch
torch.backends.cuda.matmul.allow_tf32 = True        # Ampere+
torch.backends.cudnn.allow_tf32 = True

# 确保维度对齐
hidden_dim = 4096  # ✅ 8 的倍数
vocab_size = 32000  # ✅ 8 的倍数
# 不要用 hidden_dim=4095，会回退 CUDA Core 慢 3-10x
```

### 2.3 cuBLAS Workspace 与 CUDA Graph

```python
# cuBLAS workspace — 减少 cublasHandle 重复分配
torch.backends.cuda.preferred_blas_library = "cublaslt"
# 或设置环境变量
# export CUBLAS_WORKSPACE_CONFIG=:4096:8

# CUDA Graph — 消除 CPU launch overhead（小 batch 收益最大）
# Warmup
g = torch.cuda.CUDAGraph()
static_input = torch.randn(batch, seq, hidden, device='cuda')
static_target = torch.randn(batch, seq, hidden, device='cuda')

# Capture
with torch.cuda.graph(g):
    static_output = model(static_input)
    static_loss = loss_fn(static_output, static_target)
    static_loss.backward()

# Replay (极低 overhead)
for real_input, real_target in dataloader:
    static_input.copy_(real_input)
    static_target.copy_(real_target)
    g.replay()
    optimizer.step()
    optimizer.zero_grad()
```

## 3. Communication Tuning (NCCL)

### 3.1 NCCL 环境变量详解

```bash
# ===== 基础调试 =====
export NCCL_DEBUG=INFO          # WARN | INFO | TRACE
export NCCL_DEBUG_FILE=/tmp/nccl_%h_%p.log  # 日志输出到文件
export NCCL_DEBUG_SUBSYS=ALL    # INIT | NET | GRAPH | TUNING

# ===== 网络传输 =====
export NCCL_IB_DISABLE=0        # 启用 InfiniBand/RoCE (默认 0)
export NCCL_SOCKET_IFNAME=eth0  # TCP/IP 使用的网卡接口
export NCCL_IB_HCA=mlx5_0,mlx5_1,mlx5_2,mlx5_3  # 指定 IB/RoCE 网卡
export NCCL_IB_GID_INDEX=3      # RoCEv2: GID index (常用 3)
export NCCL_IB_TIMEOUT=22       # IB 超时时间 (秒)
export NCCL_IB_RETRY_CNT=7      # IB 重试次数

# ===== GPUDirect RDMA =====
export NCCL_NET_GDR_LEVEL=5     # 0=禁用 | 5=全启用 (默认取决于硬件)
#   Level 0: 不使用 GDR (通过 CPU 中转)
#   Level 5: 全路径 GDR (GPU → NIC → NIC → GPU, 不走 CPU)
export NCCL_NET_GDR_READ=1      # 启用 GDR read
export NCCL_IB_GDR_SUPPORT=1    # 检查确认 (nccl 会自动检测)

# ===== NVLink / NVSwitch =====
export NCCL_P2P_DISABLE=0       # 启用 GPU P2P (默认 0, NVLink 通信)
export NCCL_P2P_LEVEL=5         # P2P 级别: 0=NVL | 5=system
export NCCL_NVLS_ENABLE=1       # 启用 NVLink SHARP (NVSwitch 硬件聚合)
export NCCL_PXN_DISABLE=0       # 启用 PXN (绕过 CPU 的跨节点 NVLink)

# ===== 连接与并发 =====
export NCCL_IB_QPS_PER_CONNECTION=4   # 每个连接的 Queue Pair 数
export NCCL_IB_TC=106           # RoCE DSCP traffic class
export NCCL_MIN_NCHANNELS=4     # 最小通信环数量
export NCCL_MAX_NCHANNELS=32    # 最大通信环数量
export NCCL_NSOCKS_PERTHREAD=4  # 每线程 socket 数 (TCP fallback 时)

# ===== 协议选择 =====
export NCCL_PROTO=LL128         # LL | LL128 | Simple
#   Simple: 大数据量, 最高带宽
#   LL128:  中等数据量, 128B 粒度, 低延迟
#   LL:     小数据量, 极低延迟
export NCCL_ALGO=Ring           # Ring | Tree | CollnetDirect | CollnetChain | NVLS
#   Ring:   AllReduce 默认
#   Tree:   AllReduce 备选, 延迟更优
#   NVLS:   NVSwitch 硬件聚合

# ===== 拓扑检测 =====
export NCCL_TOPO_FILE=/path/to/custom_topo.xml  # 自定义拓扑文件
export NCCL_GRAPH_DUMP_FILE=/tmp/nccl_graph.txt # 导出拓扑图
```

### 3.2 NVLink SHARP 启用

```bash
# 条件: NVSwitch 硬件 (DGX H100 / HGX H100)
# NVLink SHARP 在 NVSwitch 内部完成 Reduce，减少数据往返
export NCCL_NVLS_ENABLE=1

# 验证是否生效
# NCCL_DEBUG=INFO 日志中搜索:
#   "NCCL INFO NET/Plugin: Using NVLS"
#   "NCCL INFO Using NVLS algorithm"

# 测试前/后带宽
mpirun -np 8 --allow-run-as-root \
    -x NCCL_NVLS_ENABLE=1 \
    all_reduce_perf -b 128M -e 2G -f 2 -g 1

# 期望: 启用后 bus bandwidth 提升 10-20%
```

### 3.3 GPUDirect RDMA 级别选择

```
Level 选择决策:
┌─────────────────────────────────────────────────────┐
│ Level 0: 不用 GDR, GPU→CPU→NIC→CPU→GPU              │
│   适用: 无 GDR 支持的网卡 / 调试阶段                   │
├─────────────────────────────────────────────────────┤
│ Level 1-4: 部分路径 GDR (逐步启用)                    │
│   适用: 兼容性过渡                                    │
├─────────────────────────────────────────────────────┤
│ Level 5: 全路径 GDR                                  │
│   要求: ConnectX-6+ / EDR+ IB / BAR1 size ≥ GPU VRAM │
│   检验: nvidia-smi topo -m 确认 NIC→GPU PIX 连接      │
└─────────────────────────────────────────────────────┘
```

```bash
# 确认 GDR 可用性
nvidia-smi topo -m | grep -E "mlx5|GPU"

# 期望输出 (NIC 和 GPU 在同一 PCIe switch 下):
# GPU0    mlx5_0     PIX
# GPU1    mlx5_1     PIX

# 检查 BAR1 size
nvidia-smi -q -d BAR1 | grep Total
# BAR1 Memory Usage
#     Total      : 65536 MiB    # ← 需 ≥ GPU VRAM
```

### 3.4 多网卡绑定

```bash
# 场景: 8 GPU 节点配 8 张 IB 网卡 (每 GPU 一张)
# 确保每块 GPU 绑定最近的 NIC

# 1. 查看拓扑
nvidia-smi topo -m

# 2. 设置 NCCL 使用多 HCA
export NCCL_IB_HCA=mlx5_0,mlx5_1,mlx5_2,mlx5_3,mlx5_4,mlx5_5,mlx5_6,mlx5_7

# 3. 绑定网卡中断到对应 NUMA 节点 (可选, 减少跨 NUMA 延迟)
# /etc/rdma/mlx5.conf — 配置 HCA 亲和性

# 4. 验证
# 启动 nccl-tests, 查看 NCCL_DEBUG=INFO 输出:
# "NCCL INFO NET/IB: Using [8] mlx5_0:1/... [8] HCA per communicator"
```

## 4. Memory Tuning

### 4.1 Gradient Checkpointing

```python
# PyTorch 原生
from torch.utils.checkpoint import checkpoint

def forward_block(x):
    x = self.attn(x)
    x = self.ffn(x)
    return x

# 每 N 层 checkpoint 一次 (平衡)
x = checkpoint(forward_block, x, use_reentrant=False)

# FSDP + Activation Checkpointing
from torch.distributed.fsdp import ActivationWrapper
# 或使用 --gradient-checkpointing 标志 (HuggingFace Trainer)
```

**内存节省估算**：

```
内存节省 ≈ (L - L/K) × activation_size_per_layer
K = checkpoint_interval (每隔 K 层保存一次)

对于 70B 模型, seq=4096, batch=8:
  无 checkpoint: ~120 GB activation → OOM (A100 80GB)
  K=2:           ~60 GB activation  → 可训练
  K=1 (每层):    ~3 GB activation   → 但增加 33% 计算量
```

### 4.2 Activation Offloading 与 CPU Offload

```python
# DeepSpeed ZeRO-3 + CPU Offload
# deepspeed_config.json
{
    "zero_optimization": {
        "stage": 3,
        "offload_optimizer": {
            "device": "cpu",
            "pin_memory": true
        },
        "offload_param": {
            "device": "cpu",
            "pin_memory": true
        }
    }
}

# FSDP + CPU Offload (PyTorch 2.0+)
from torch.distributed.fsdp import CPUOffload
fsdp_kwargs = {
    "cpu_offload": CPUOffload(offload_params=True)
}

# Megatron-LM: --activations-checkpoint-granularity selective
# 选择性重计算: 只重计算大 activation, 保留小 activation
```

### 4.3 内存碎片与 OOM 预防

```python
# 1. 启用 CUDA 内存缓存分配器
# export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

# 2. 监控内存碎片
import torch
print(f"allocated: {torch.cuda.memory_allocated()/1e9:.2f} GB")
print(f"reserved:  {torch.cuda.memory_reserved()/1e9:.2f} GB")
# 如果 reserved >> allocated → 碎片严重

# 3. 定期清理
torch.cuda.empty_cache()  # 释放 unused reserved memory
# (慎用, 会打断 CUDA graph, 仅在 checkpoint 后调用)

# 4. 预分配策略 (Megatron 做法)
# 在训练开始前分配最大的 buffer, 避免运行时分配碎片
```

### 4.4 pin_memory 和 num_workers

```python
# 最优配置取决于存储和 CPU
DataLoader(
    dataset,
    batch_size=micro_batch_size,
    num_workers=4,            # CPU 核数充足: 4-8
    pin_memory=True,          # 几乎总是启用
    prefetch_factor=2,        # 每 worker 预取 2 个 batch
    persistent_workers=True,  # 避免 worker 反复创建/销毁
    pin_memory_device='cuda', # PyTorch 2.1+: 直接 pin 到 GPU
)

# 调优 num_workers: 逐步增加直到 GPU 利用率不提升
# 1 → 2 → 4 → 8 → 16
# 观察 nvidia-smi dmon -s puc 中 GPU 利用率变化
# 过高的 num_workers 会导致 CPU 竞争, 反而降低吞吐
```

## 5. Pipeline Tuning

### 5.1 Micro-Batch Size 与 Gradient Accumulation

```
global_batch = micro_batch × accumulation_steps × data_parallel_size

选择 micro_batch 的原则:
1. 最大化 GPU 计算强度 (满 SM 占用)
2. micro_batch 至少达到吞吐饱和点
3. 但不超过显存限制
```

```python
# 典型配置
micro_batch_size = 1      # 最大模型, 每 GPU 只能装 1 条
gradient_accumulation_steps = 32
global_batch_size = micro_batch_size * gradient_accumulation_steps * dp_size

# Pipeline Parallel 中 micro-batch 数目选择
# 越多 micro-batch → pipeline bubble 越小
# 建议: num_micro_batches ≥ 4 × pp_size (减少 bubble)

# PyTorch 中实现
total_loss = 0
for i, (data, target) in enumerate(dataloader):
    output = model(data)
    loss = criterion(output, target) / gradient_accumulation_steps
    loss.backward()
    if (i + 1) % gradient_accumulation_steps == 0:
        optimizer.step()
        optimizer.zero_grad()
```

### 5.2 Pipeline Bubble 计算

```
Pipeline Bubble (1F1B 调度):

  时间 →
  ┌──────────────────────────────────┐
  │ GPU0 ██░░░░░░████░░░░░░████████  │
  │ GPU1 ░░████░░░░░░████░░░░░░████  │
  │ GPU2 ░░░░████░░░░░░████░░░░░░    │
  │ GPU3 ░░░░░░████░░░░░░████░░░░    │
  └──────────────────────────────────┘
  ██ = 有效计算   ░░ = Bubble (空闲)
```

```python
# Bubble Ratio 公式
# 对于 1F1B (one-forward-one-backward) 调度:
bubble_ratio = (pp_size - 1) / num_micro_batches

# 例如:
# pp_size=4, num_micro_batches=32 → bubble=3/32=9.4%
# pp_size=8, num_micro_batches=32 → bubble=7/32=21.9%  ← 显著增加

# 减小 bubble 的方法:
# 1. 增加 num_micro_batches (但受显存和 global_batch 限制)
# 2. 使用交错调度 (interleaved 1F1B):
#    bubble ≈ (pp_size - 1) / (num_micro_batches × num_model_chunks)
#    代价: 额外通信量增加
# 3. 减少 pp_size → 转用 TP 或 ZeRO-3

# Megatron-LM 交错调度配置
# --num-layers-per-virtual-pipeline-stage 2
# 将模型切成更细的 virtual stage, bubble 减半
```

## 6. Profiling Tools

### 6.1 Nsight Systems (nsys) — 系统级

```bash
# 基本用法
nsys profile -o output_report \
    --trace=cuda,nvtx,osrt,cublas,ucx,mpi \
    python train.py

# 多节点 profile
mpirun -np 8 -H node01:4,node02:4 \
    nsys profile -o node%q{OMPI_COMM_WORLD_RANK} \
    --trace=cuda,nvtx,nccl,mpi \
    python train.py

# 分析
# 打开 output_report.nsys-rep (Nsight Systems GUI) 查看:
# - GPU 利用率 Timeline
# - Kernel 执行时间线
# - NCCL 通信耗时占比
# - CPU/GPU 空闲区间 (bubble)

# 常见指标解读:
# 如果大量时间花在 "cudaLaunchKernel" → 优化 CPU launch overhead
# 如果 NCCL 通信时间长 → 优化通信拓扑/环境变量
# 如果 GPU 频繁 idle → 检查数据加载或 CPU 预处理
```

### 6.2 Nsight Compute (ncu) — Kernel 级

```bash
# 分析单个 Kernel
ncu --set full \
    --kernel-name 'gemm|attention' \
    --launch-count 10 \
    python train.py

# 关键 Section 分析
ncu --set full \
    --section SpeedOfLight \
    --section MemoryWorkloadAnalysis \
    --section SchedulerStats \
    --section WarpStateStats \
    python train.py

# 关键指标解读:
# SpeedOfLight:
#   - Compute (SM) Throughput:  越高越好 (>60% 优秀)
#   - Memory Throughput:       接近峰值说明 compute-bound
#
# MemoryWorkloadAnalysis:
#   - L1/TEX Hit Rate:  命中率低 → 优化访存模式
#   - L2 Hit Rate:      低 L2 命中 → 数据复用差
#
# SchedulerStats:
#   - Active Warps per SM:  接近最大 warps/SM 说明 occupancy 好
#   - Eligible Warps per Scheduler: 为 0 → warp stall (等待数据)
```

### 6.3 PyTorch Profiler

```python
from torch.profiler import profile, record_function, ProfilerActivity

with profile(
    activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA],
    schedule=torch.profiler.schedule(wait=1, warmup=1, active=3, repeat=1),
    on_trace_ready=torch.profiler.tensorboard_trace_handler('./log/profiler'),
    record_shapes=True,
    profile_memory=True,
    with_stack=True,
) as prof:
    for step in range(10):
        with record_function("forward"):
            output = model(data)
            loss = criterion(output, target)
        with record_function("backward"):
            loss.backward()
        with record_function("optimizer_step"):
            optimizer.step()
            optimizer.zero_grad()
        prof.step()

# 在 TensorBoard 中查看:
# tensorboard --logdir=./log/profiler
# 分析: GPU Summary → 查看 kernel 时间分布
#       Trace View → 查看 CPU/GPU 时间线
```

### 6.4 DCGM Profiler

```bash
# DCGM 诊断级 profiling
dcgmi diag -r 3  # Level 3: 长时间压力测试

# Metrics profile (性能计数器)
dcgm-exporter  # 配合 Prometheus 持续监控

# 或使用 prometheus-dcgm
helm install dcgm-exporter nvidia/dcgm-exporter \
    --set serviceMonitor.enabled=true

# 关键指标:
# DCGM_FI_PROF_GR_ENGINE_ACTIVE   — SM 核心活跃度
# DCGM_FI_PROF_PIPE_TENSOR_ACTIVE — Tensor Core 活跃度
# DCGM_FI_PROF_DRAM_ACTIVE         — 显存带宽使用率
# DCGM_FI_PROF_NVLINK_RX_BYTES    — NVLink 接收带宽
# DCGM_FI_PROF_PCIE_TX_BYTES      — PCIe 发送带宽

# 一句话看整体状态
nvidia-smi dmon -s pucvmet -c 60 -d 2
# p=power, u=util, c=clock, v=volatile-gpu, m=memory, e=enc, t=temp
```

## 7. Real Optimization Workflow

### 7.1 标准优化流程

```
Step 1: Baseline → Step 2: Profile → Step 3: Identify → Step 4: Fix → Step 5: Validate
```

### Step-by-Step 实战

```bash
# ==================== Step 1: Baseline ====================
# 跑 100 步, 记录基准指标
python train.py --max-steps 100 --log-interval 1 2>&1 | tee baseline.log
# 提取: step time, tokens/sec, MFU, GPU util, memory

# ==================== Step 2: Profile ====================
# 2a. 系统级: 看瓶颈在计算/通信/IO?
nsys profile -o baseline --trace=cuda,nvtx,nccl,osrt \
    python train.py --max-steps 20

# 2b. 如果 GPU util < 80%:
#   检查 DataLoader: torch.utils.bottleneck train.py
#   检查通信占比: nsys report --stats=true baseline.nsys-rep

# 2c. 如果 GPU util > 80% 但吞吐不理想:
#   Kernel 级分析
ncu --set full --section SpeedOfLight --kernel-name regex:gemm \
    python train.py --max-steps 5

# ==================== Step 3: Identify Bottleneck ====================

# 计算瓶颈诊断矩阵
# ┌──────────────────┬──────────────────┬──────────────────┐
# │ 症状              │ 根因              │ 优化方向          │
# ├──────────────────┼──────────────────┼──────────────────┤
# │ GPU util < 50%   │ 数据加载慢        │ num_workers, DALI │
# │ GPU util 波形     │ 通信/计算交替     │ 通信隐藏, overlap │
# │ NCCL time > 20%  │ 通信瓶颈          │ NCCL env, 拓扑    │
# │ Memory > 90%     │ 显存紧张          │ checkpoint, offload│
# │ SM util < 60%    │ Kernel 效率差     │ ncu 分析, 重写     │
# │ Step time 抖动   │ 慢节点             │ 检查硬件健康度    │
# └──────────────────┴──────────────────┴──────────────────┘

# ==================== Step 4: Fix ====================
# 每次只改一个变量! (否则无法归因)

# Fix A: 数据加载优化
# 改 num_workers: 2 → 4 → 8
# 加 pin_memory=True, persistent_workers=True

# Fix B: 通信优化
export NCCL_NVLS_ENABLE=1
export NCCL_NET_GDR_LEVEL=5
export NCCL_IB_QPS_PER_CONNECTION=4

# Fix C: 计算优化
# 启用 BF16, TF32, cuBLAS workspace
# 使用 CUDA Graph

# Fix D: 内存优化
# 添加 gradient checkpointing
# 调整 micro_batch_size

# ==================== Step 5: Re-benchmark ====================

# 重新跑 100 步
python train.py --max-steps 100 --log-interval 1 2>&1 | tee optimized.log

# 对比
echo "=== Baseline ==="
grep "elapsed time" baseline.log | tail -5
echo "=== Optimized ==="
grep "elapsed time" optimized.log | tail -5

# 计算提升比例
# 基准 step_time: 520ms → 优化后: 450ms → 提升 13.5%
```

### 7.2 优化检查清单 (Checklist)

```
□ 数据加载
  □ num_workers ≥ 4
  □ pin_memory=True, persistent_workers=True
  □ prefetch_factor ≥ 2
  □ 无 CPU 预处理瓶颈 (torch.utils.bottleneck 确认)

□ 计算
  □ 使用 BF16/FP8 (根据 GPU 代际)
  □ TF32 已启用 (torch.backends.cuda.matmul.allow_tf32=True)
  □ 矩阵维度是 8 的倍数
  □ CUDA Graph 已启用 (小 batch 场景)
  □ cuBLAS workspace 已配置

□ 通信
  □ NCCL_NVLS_ENABLE=1 (有 NVSwitch 时)
  □ NCCL_NET_GDR_LEVEL=5 (有 GDR 硬件时)
  □ 多 NIC 绑定正确
  □ NCCL_DEBUG=INFO 日志无异常
  □ nccl-tests all_reduce_perf 带宽 > 理论值 80%

□ 内存
  □ Gradient checkpointing 已启用 (大模型)
  □ activation offloading 已配置 (超大模型)
  □ 无 OOM 或频繁 gc

□ 流水线
  □ num_micro_batches ≥ 4 × pp_size
  □ pipeline bubble < 15%
  □ gradient accumulation steps 合理

□ Profiling
  □ nsys 确认 GPU idle 时间 < 10%
  □ ncu 确认 SM Throughput > 60%
  □ PyTorch Profiler 确认无意外 CPU op 瓶颈
```

## 关联知识

- [[../hardware/NVIDIA GPU 架构演进]] — 理解各代 GPU 的算力/带宽特征
- [[../network/NCCL 通信原理与调优]] — NCCL 底层机制与进阶调优
- [[../monitoring/DCGM 监控体系详解]] — 生产环境持续性能监控
- [[../training/分布式训练框架对比]] — FSDP/DeepSpeed/Megatron 对比
- [[../storage/分布式文件系统选型]] — 存储侧 I/O 性能优化
- [[GPU 集群运维知识总览]]

## 学习记录

| 阶段 | 时间 | 内容 |
|------|------|------|
| 初版创建 | 2026-06-29 | 基础骨架与工具链 |
| 全面重写 | 2026-06-30 | MFU/GPU/通信/内存/流水线/Profiling/实战流程 |

## 状态标记

📖 已掌握 — 核心调优方法论（MFU 计算、NCCL 环境变量、Gradient Checkpointing、Pipeline Bubble 公式、nsys/ncu 使用、端到端优化流程）

📝 待补充 — 各集群规模 benchmark 数据（千卡/万卡）、自动化性能回归测试 CI 集成、FP8 训练稳定性踩坑记录

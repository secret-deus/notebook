---
date: 2026-06-30
tags:
  - gpu
  - hardware
  - nvidia
  - architecture
type: 学习笔记
category: GPU集群运维/硬件
source: NVIDIA 官方白皮书 + 个人整理
difficulty: 进阶
title: "NVIDIA GPU 架构演进"
---

# NVIDIA GPU 架构演进

> 从 Kepler 到 Blackwell，理解每一代 GPU 架构的核心变化及其对 AI 训练/推理的影响。本文聚焦数据中心 GPU，不涉及消费级（GeForce）和图形工作站（Quadro/RTX）产品线。

---

## 一、架构代际总览

| 架构 | 代号 | 发布年 | 制程 | 代表型号 | 显存 | 关键特性 |
|------|------|--------|------|----------|------|----------|
| Kepler | GK110 | 2012 | 28nm | K80 | 24GB GDDR5 | GPUDirect RDMA, Dynamic Parallelism |
| Maxwell | GM200 | 2014 | 28nm | M40 | 24GB GDDR5 | 能效比大幅提升，统一虚拟寻址 |
| Pascal | GP100 | 2016 | 16nm | P100 | 16GB HBM2 | **NVLink 1.0**, HBM2, **FP16** 原生支持 |
| Volta | GV100 | 2017 | 12nm | V100 | 16/32GB HBM2 | **Tensor Core V1**, NVLink 2.0 |
| Turing | TU104 | 2018 | 12nm | T4 | 16GB GDDR6 | Tensor Core V2, **INT8/INT4** 推理加速 |
| Ampere | GA100 | 2020 | 7nm | A100 | 40/80GB HBM2e | **TF32**, **MIG**, NVLink 3.0, Sparsity |
| Hopper | GH100 | 2022 | 4nm | H100 | 80GB HBM3 | **FP8**, **Transformer Engine**, NVLink 4.0 |
| Blackwell | GB100 | 2024 | 4nm | B100/B200 | 192GB HBM3e | **FP4/FP6**, NVLink 5.0, 双 Die 封装 |

> **运维提示**：生产集群常见 GPU 型号为 A100、H100、T4（推理），V100 在存量集群中仍大量使用。K80/M40/P100 已基本淘汰。

---

## 二、各代架构详解

### 2.1 Volta (V100) — Tensor Core 的诞生

```
GV100 核心规格:
├── 84 SM（满血），单卡实际 80 SM
├── 5120 CUDA Core / 640 Tensor Core (V1)
├── 16GB / 32GB HBM2，带宽 900 GB/s
├── NVLink 2.0：6 路 × 50 GB/s = 300 GB/s
└── FP16 算力：125 TFLOPS（Tensor Core）
```

**SM 微架构**：每个 SM 包含 64 FP32 Core + 32 FP64 Core + 8 Tensor Core + 4 纹理单元。

**运维要点**：
- V100 32GB 显存模型是 16GB 的两倍，训练大模型时显存是硬瓶颈
- NVLink 2.0 最多 6 GPU 直连，超过 6 卡需借助 NVSwitch
- `nvidia-smi topo -m` 可查看 GPU 间 NVLink 连接拓扑

### 2.2 Turing (T4) — 推理专用卡

```
TU104 核心规格:
├── 40 SM
├── 2560 CUDA Core / 320 Tensor Core (V2)
├── 16GB GDDR6，带宽 320 GB/s
├── 无 NVLink（单卡推理，不需多卡互联）
├── FP16 算力：65 TFLOPS（Tensor Core）
└── INT8 算力：130 TOPS
```

**设计定位**：低成本推理卡，75W 功耗（无需外接供电），适合 K8s 集群中大规模部署推理服务。

**运维要点**：
- T4 无 NVLink，只适合单卡推理，不要用于多卡训练
- INT8 推理速度是 FP16 的 2 倍，部署时优先启用 TensorRT INT8 量化
- T4 显存仅 16GB，LLM 推理放不下 7B 以上模型（需至少 A10/L40S/A100）

### 2.3 Ampere (A100) — 数据中心主力

```
GA100 核心规格:
├── 108 SM（满血），单卡实际 108 SM
├── 6912 CUDA Core / 432 Tensor Core (V3)
├── 40GB / 80GB HBM2e，带宽 1555 GB/s（40GB）/ 2039 GB/s（80GB）
├── NVLink 3.0：12 路 × 50 GB/s = 600 GB/s
├── PCIe 版限 NVLink Bridge 连接（2 卡）
└── SXM 版支持 NVSwitch 全互联（8 卡）
```

**关键特性详解**：

#### TF32（Tensor Float 32）
```
FP32 输入 → Tensor Core 内部 19 位计算 → FP32 累加输出
≈ FP32 精度 + FP16 速度，训练时几乎零精度损失
```

#### MIG（Multi-Instance GPU）
```
A100 40GB 可切分为最多 7 个 GPU 实例：
┌──────────────────────────────────────┐
│  1g.5gb  ×7    (每个实例 1/7 SM + 5GB)│
│  2g.10gb ×3    (每个实例 2/7 SM + 10GB)│
│  3g.20gb ×2    (每个实例 3/7 SM + 20GB)│
│  7g.40gb ×1    (整卡)                  │
└──────────────────────────────────────┘
```

#### 结构化稀疏（Sparsity）
```
密集矩阵 → 2:4 稀疏化（50% 权重置零） → Tensor Core 自动跳过 → 理论 2x 加速
实际业务加速比 ≈ 1.3-1.5x（取决于模型稀疏性）
```

**运维要点**：
- A100 是目前生产集群最常见 GPU，80GB 版本显存带宽比 40GB 高 31%
- SXM vs PCIe 选择：SXM 版 NVLink 带宽更高，适合多卡训练；PCIe 版成本低，适合推理
- MIG 启用后性能隔离好，但单实例性能下降（SM 切分导致），且部分 CUDA 特性不可用
- 查看 MIG 状态：`nvidia-smi mig -lgi` / `nvidia-smi mig -lci`

### 2.4 Hopper (H100) — Transformer 专用加速

```
GH100 核心规格:
├── 132 SM（满血），单卡实际 132 SM
├── 16896 CUDA Core / 528 Tensor Core (V4)
├── 80GB HBM3，带宽 3.35 TB/s
├── NVLink 4.0：18 路 × 50 GB/s = 900 GB/s
└── FP8 算力：1979 TFLOPS（Tensor Core）/ 3958 TFLOPS（稀疏）
```

**关键特性详解**：

#### Transformer Engine
```
传统流程：Weight(FP16) × Input(FP16) → 累加(FP32) → 输出(FP16)

H100 流程（动态精度）：
训练前向/反向 → 硬件自动统计张量范围 → 动态选择 FP8(E4M3)/FP8(E5M2) →
FP8 GEMM → FP16 累加 → 精度损失 < 0.1%
```

#### DPX 指令（动态规划加速）
```
Smith-Waterman、Needleman-Wunsch 等算法 → 基因测序、路径规划
与 AI 运维关系不大，HPC 领域场景
```

#### TMA（Tensor Memory Accelerator）
```
异步拷贝单元，减少 SM 浪费在数据搬运上的时间
配合 CUDA 12.x 异步编程模型，显存带宽利用率提升 20-30%
```

#### MIG 增强
```
H100 MIG 更灵活：
- 支持 14 个 GI（GPU Instance），每个 GI 最多 14 个 CI（Compute Instance）
- MIG + 多租户共享 NVLink（之前 A100 MIG 禁用 NVLink）
```

**运维要点**：
- H100 的 FP8 是训练加速核心，需配合 Transformer Engine 库（`transformer_engine` pip 包）
- H100 显存带宽 3.35 TB/s = A100(80GB) 的 1.64×，推理场景优势明显
- MIG 模式下 NVLink 可用是重大改进（A100 MIG 禁 NVLink）
- 单 H100 功耗 700W（SXM），散热和供电要求高于 A100(400W)

### 2.5 Blackwell (B100/B200) — 双 Die 时代

```
B200 核心规格（双 Die 封装）:
├── 2× GB100 Die = 2080 亿晶体管
├── 192GB HBM3e，带宽 8 TB/s
├── NVLink 5.0：1.8 TB/s（双向，单向 900 GB/s）
├── FP4 算力：9 PFLOPS（Tensor Core）
├── FP8 算力：4.5 PFLOPS
└── TDP：1000W（SXM）/ 1200W（NVL72 机柜）

B100 核心规格（单 Die）:
├── 1× GB100 Die = 1040 亿晶体管
├── 192GB HBM3e，带宽 8 TB/s
├── NVLink 5.0：1.8 TB/s
└── 算力约为 B200 的 50%
```

**关键特性**：

#### FP4/FP6 精度
```
FP4(E2M1)：模型推理终极压缩，1/4 FP16 显存
FP6：训练微调精度，介于 FP8 和 FP4 之间
配合 NVLink 5.0 和 8 TB/s HBM3e → 72B 模型纯 FP4 推理单卡可跑
```

#### NVLink 5.0 + NVSwitch Gen5
```
单 GPU → 18 对差分对 → 单向 900 GB/s → 双向 1.8 TB/s
NVL72 机柜：72 块 B200 全互联，总带宽 130 TB/s
```

#### 可靠性增强（RAS）
```
Blackwell 新增芯片级 RAS 引擎：
- 硬件故障预测
- 在线 ECC 重试
- 链路级错误恢复
→ 千卡集群 MTBF 提升 10-20×
```

**运维要点**：
- Blackwell 目前（2026 上半年）逐步到货，处于早期部署阶段
- 功耗和散热是最大挑战：单卡 1000W+，传统风冷不够，需液冷
- 驱动要求：CUDA 12.6+ / Driver 560+，需提前验证
- NVL72 机柜需要数据中心基础设施改造（电力、液冷、机柜承重）

---

## 三、Tensor Core 演进深度对比

### 3.1 各代 Tensor Core 架构差异

| 特性 | V1 (Volta) | V2 (Turing) | V3 (Ampere) | V4 (Hopper) | V5 (Blackwell) |
|------|-----------|------------|------------|------------|----------------|
| 每 SM 数量 | 8 | 8 | 4 | 4 | — |
| 矩阵尺寸 | 4×4×4 | 8×8×4 | 8×4×8 / 16×8×8 | 16×8×16 | 支持任意 |
| 支持精度 | FP16 | FP16/INT8/INT4 | FP16/BF16/TF32/INT8/INT4/INT1 | +FP8 | +FP4/FP6 |
| Sparsity | ❌ | ❌ | ✅ (2:4) | ✅ (2:4) | ✅ |
| 异步拷贝 | ❌ | ❌ | ✅ (async copy) | ✅ (TMA) | ✅ (TMA+) |

### 3.2 关键精度算力对比表

| GPU | FP32 (TF) | TF32 (TF) | FP16/BF16 (TF) | FP8 (TF) | INT8 (TOPS) |
|-----|-----------|-----------|----------------|----------|-------------|
| V100 | 15.7 | — | 125 | — | — |
| T4 | 8.1 | — | 65 | — | 130 |
| A100 (80G) | 19.5 | 156 | 312 | — | 624 |
| H100 (SXM) | 67 | 495 | 990 | 1979 | 3958 |
| B200 | ~90 | ~900 | ~2250 | 4500 | — |

> **关键结论**：从 A100 到 H100，FP16 算力 3.2×；从 H100 到 B200，FP8 算力 2.3×。代际提升主要来自 SM 数量 + 频率 + 新精度支持。

### 3.3 精度选择的实战建议

```
场景                        推荐精度      原因
──────────────────────────────────────────────────
大模型预训练                 BF16         精度与 FP32 等价，A100+ 原生支持
大模型 SFT 微调              BF16/FP8     若框架支持 FP8 无精度损失
LLM 推理（生产）              FP8/INT8     TensorRT-LLM INT8 量化
Embedding / 推荐模型训练       TF32         A100 默认，零代码改动
CV 模型训练                  FP16          cuDNN 自动优化
量化感知训练 (QAT)           FP8          需 Transformer Engine
端侧部署推理                  INT4/FP4     Blackwell 原生支持
```

---

## 四、显存体系演进

### 4.1 HBM 代际对比

| 特性 | HBM2 | HBM2e | HBM3 | HBM3e |
|------|------|-------|------|-------|
| 每引脚速率 | 2.0 Gbps | 3.6 Gbps | 6.4 Gbps | 9.6 Gbps |
| 单 Stack 带宽 | 256 GB/s | 460 GB/s | 819 GB/s | 1.2 TB/s |
| 单 Stack 容量 | 8 GB | 16 GB | 24 GB | 36 GB |
| 代表 GPU | V100 (4 stacks) | A100 (5 stacks) | H100 (6 stacks) | B200 (8 stacks) |

### 4.2 显存带宽对推理的影响

```
模型推理瓶颈：显存带宽 >> 计算算力

以 Llama-2 70B (INT8) 为例：
- 模型大小 ≈ 70 GB
- A100 80GB 显存带宽 = 2.0 TB/s
  → 理论最大吞吐 ≈ 2000 / 70 ≈ 28.6 token/s（单 batch）
- H100 显存带宽 = 3.35 TB/s
  → 理论最大吞吐 ≈ 3350 / 70 ≈ 47.9 token/s

结论：推理吞吐量由显存带宽决定，不是 TFLOPS。
     选推理 GPU 时，显存带宽是第一优先级。
```

### 4.3 L1/L2 Cache 演进

| GPU | L1/SM (KB) | L2 Cache (MB) |
|-----|-----------|---------------|
| V100 | 128 | 6 |
| A100 | 192 | 40 |
| H100 | 256 | 50 |
| B200 | ~512 | ~96 |

> L2 Cache 直接影响计算密集型 Kernel 性能（如 FlashAttention、GEMM 的分块大小）。

---

## 五、NVLink 演进概要

详见 [[NVLink 与 NVSwitch 拓扑详解]]，此处仅列出关键参数：

| 版本 | 代际 | 单链路速率 | GPU 总带宽 | 最大 GPU 数 |
|------|------|-----------|-----------|-------------|
| NVLink 1.0 | Pascal | 25 GB/s | 300 GB/s | 8 (NVSwitch 桥接) |
| NVLink 2.0 | Volta | 50 GB/s | 300 GB/s | 8 (NVSwitch) |
| NVLink 3.0 | Ampere | 50 GB/s | 600 GB/s | 8 (NVSwitch) |
| NVLink 4.0 | Hopper | 50 GB/s | 900 GB/s | 8 (NVSwitch Gen4) |
| NVLink 5.0 | Blackwell | 100 GB/s | 1800 GB/s | 72 (NVL72) |

---

## 六、运维实战：硬件信息检查

### 6.1 nvidia-smi 查 GPU 型号和规格

```bash
# 查看 GPU 型号、显存、驱动版本
nvidia-smi --query-gpu=index,name,memory.total,driver_version,compute_cap --format=csv

# 典型输出：
# 0, NVIDIA A100-SXM4-80GB, 81920 MiB, 535.154.05, 8.0
# 1, NVIDIA H100-80GB-HBM3, 81559 MiB, 550.54.15, 9.0
```

### 6.2 计算能力（Compute Capability）与架构对应

| Compute Capability | 架构 | 代表型号 |
|--------------------|------|----------|
| 3.7 | Kepler | K80 |
| 5.2 | Maxwell | M40 |
| 6.0 | Pascal | P100 |
| 7.0 | Volta | V100 |
| 7.5 | Turing | T4 |
| 8.0 | Ampere | A100 |
| 9.0 | Hopper | H100 |
| 10.0 | Blackwell | B100/B200 |

```bash
# 查看 Compute Capability
nvidia-smi --query-gpu=compute_cap --format=csv,noheader
```

### 6.3 查看 PCIe 拓扑和 NVLink 连接

```bash
# GPU 拓扑（PCIe + NVLink 混合拓扑）
nvidia-smi topo -m

# SXM 平台（NVSwitch）典型输出：
#         GPU0  GPU1  GPU2  GPU3  GPU4  GPU5  GPU6  GPU7
#  GPU0    X    NV12  NV12  NV12  NV12  NV12  NV12  NV12
#  GPU1   NV12   X    NV12  ...

# PCIe 平台典型输出：
#         GPU0  GPU1  GPU2  GPU3
#  GPU0    X    PHB   PHB   PHB    ← PHB = PCIe Host Bridge, 无直连
#  GPU1   PHB    X    NODE  NODE   ← NODE = 同 NUMA node
```

### 6.4 GPU 型号与显存型号识别

```bash
# 查看详细 GPU 信息（含序列号、PCIe 链路速度）
nvidia-smi -q -d SUMMARY

# 查看 NVLink 状态
nvidia-smi nvlink -s

# 查看 MIG 配置（A100/H100）
nvidia-smi mig -lgi    # 列出 GPU 实例
nvidia-smi mig -lci    # 列出计算实例
```

---

## 七、GPU 选型决策树

```
需要训练大模型（>7B）？
├── 是 → 需要多卡互联？
│         ├── 是 → A100 80GB SXM / H100 SXM（取决于预算）
│         └── 否 → 单卡 A100 80GB 或 H100（看显存需求）
│
└── 否 → 推理还是训练？
          ├── 推理 → 模型多大？
          │         ├── <7B  → T4 / A10
          │         ├── 7-70B → A100 40GB / A100 80GB
          │         └── >70B → H100 / B200
          │
          └── 小规模训练 → A100 40GB / A100 80GB（单卡足够）
```

---

## 八、常见问题

**Q1：PCIe 版和 SXM 版 GPU 有什么区别？**
- SXM：NVIDIA 高密度封装，NVSwitch 互联，适合 DGX/HGX 整机；价格高，不可自行更换
- PCIe：标准 PCIe 插槽，NVLink Bridge 仅支持 2 卡互联；灵活，价格低，适合白牌服务器

**Q2：A100 80GB 比 40GB 贵多少？值得吗？**
- 价格约 1.3-1.5×，显存带宽高 31%。如果训练 13B+ 模型或推理 7B+ 模型，80GB 更划算

**Q3：如何判断 GPU 是否降频（Throttle）？**
```bash
nvidia-smi -q -d CLOCK
# 查看 clocks_throttle_reasons.active 字段
# 常见原因：thermal（过热）、power（功耗墙）、sync_boost（等待互联同步）
```

---

## 关联知识

- [[NVLink 与 NVSwitch 拓扑详解]] — 深入理解 GPU 互联
- [[GPU 服务器硬件选型指南]] — 服务器整机选型
- [[../scheduling/GPU 资源分配与隔离策略]] — MIG、Time-Slicing 实战
- [[../scheduling/K8s GPU 调度机制详解]] — Device Plugin 工作原理
- [[../training/分布式训练框架对比]] — 多卡训练最佳实践
- [[../performance/GPU 集群性能调优指南]] — 端到端性能优化
- [[../GPU 集群运维知识总览]] — 返回总览

## 参考资源

- [NVIDIA A100 Tensor Core GPU Architecture](https://images.nvidia.com/aem-dam/en-zz/Solutions/data-center/nvidia-ampere-architecture-whitepaper.pdf)
- [NVIDIA H100 Tensor Core GPU Architecture](https://resources.nvidia.com/en-us-tensor-core)
- [NVIDIA Blackwell Architecture Technical Brief](https://www.nvidia.com/en-us/data-center/technologies/blackwell-architecture/)
- [NVIDIA CUDA C++ Programming Guide](https://docs.nvidia.com/cuda/cuda-c-programming-guide/)

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 框架搭建 | 2026-06-29 | 骨架创建 |
| 内容填充 | 2026-06-30 | 补全各代架构详解、Tensor Core 对比、运维命令 |

## 状态标记

📖 已掌握 — 各代架构特征、Tensor Core 演进、显存带宽对推理的影响
📝 待补充 — Blackwell GA102 推理卡（B40）规格、NVIDIA Vera CPU + GPU 融合架构

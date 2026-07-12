---
date: 2026-06-30
tags:
  - llm
  - training
  - inference
  - pretraining
  - sft
  - rlhf
type: 学习笔记
category: 大模型训练/流程
source: 个人整理
difficulty: 进阶
title: "LLM 训练与推理流程"
---

# LLM 训练与推理全流程

> 本文从工程实践角度出发，覆盖从预训练到推理部署的完整链路。核心章节标记为 📖 已掌握，进阶主题标记为 📝 待补充。

---

## 目录

1. [Pre-training（预训练）](#1-pre-training预训练)
2. [SFT（监督微调）](#2-sft监督微调)
3. [RLHF（人类反馈强化学习）](#3-rlhf人类反馈强化学习)
4. [Inference（推理）](#4-inference推理)
5. [Sampling Strategies（采样策略）](#5-sampling-strategies采样策略)
6. [Batch Inference（批量推理）](#6-batch-inference批量推理)
7. [Practical GPU Ops（GPU 算力实践）](#7-practical-gpu-opsgpu-算力实践)

---

## 1. Pre-training（预训练）

> 📖 已掌握

![[assets/训练三阶段.svg|1000]]

预训练是 LLM 能力的基础。一个基座模型（base model）在这一阶段学到了语言的统计规律、世界知识、推理能力——本质上都来源于"预测下一个 token"。

### 1.1 训练数据

预训练数据量级以 **万亿 token** 计。数据来源和构成直接决定了模型的能力边界。

| 数据来源 | 典型占比 | 说明 |
|----------|----------|------|
| 网页爬取（Common Crawl） | 60-70% | 覆盖面最广，但需要进行严格的质量过滤（去重、去噪、语言识别） |
| 书籍 | 5-10% | 长文本、文学性、叙事逻辑的主要来源 |
| 代码 | 5-15% | GitHub、StackOverflow 等，显著提升推理和代码能力 |
| 学术论文 / Wikipedia | 3-5% | 高质量事实性和结构化知识 |
| 多语言语料 | 5-10% | 非英语语料，影响多语言能力 |

**数据处理流水线：**
```
原始数据 → 语言识别 → 质量过滤（困惑度/分类器）→ 去重（MinHash/SimHash）→ 
个人身份信息（PII）脱敏 → 去毒化（toxic content filtering）→ 分词（Tokenization）→ 打包进训练序列
```

数据质量的优先级远高于数据量——**垃圾进，垃圾出**。在实际工程中，一个高质量的小数据集往往比一个低质量的大数据集训练出的模型表现更好，因此数据清洗通常会消耗整体项目 40%-60% 的时间。

**数据混合（Data Mix）策略：** 不同来源的数据按比例混合，通常通过"epoch 比例"或"采样权重"来控制。常见的做法包括：
- **静态混合**：固定的采样比例，如 LLaMA 论文中的配比
- **动态混合**：训练过程中调整比例，后期增加高质量数据占比
- **退火策略（Annealing）**：训练最后阶段用极高纯度的小数据集（如教科书级别内容）做退火，可以显著提升 benchmark 表现

典型的高质量预训练数据混合示例：Common Crawl 过滤后约 67%，代码 15%，书籍 5%，Wikipedia 4%，其他来源（论文、对话、多语言等）约 9%。

### 1.2 训练目标：Next-Token Prediction

形式化定义：

给定一个 token 序列 \( x = (x_1, x_2, ..., x_T) \)，模型要学习条件概率分布：

\[
P(x_t | x_{<t}; \theta)
\]

损失函数是标准的交叉熵损失（Cross-Entropy Loss）：

\[
\mathcal{L}(\theta) = -\frac{1}{T}\sum_{t=1}^{T} \log P(x_t | x_{<t}; \theta)
\]

本质上是一个 **自监督学习** 任务——不需要人工标注，文本本身就是标签。给定上文，预测下一个词；然后用真实的下一个词计算损失。这也是为什么可以用万亿级 token 训练的原因。

### 1.3 一次训练步骤的完整过程

```
┌─────────────────────────────────────────────────────────────┐
│  One Training Step (一个训练步骤)                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. FORWARD PASS（前向传播）                                  │
│     Input IDs → Embedding → N×Transformer Layers → Logits    │
│     - 输入: [batch_size, seq_len]                            │
│     - 输出: [batch_size, seq_len, vocab_size]                │
│     - 主要耗时: Self-Attention 的 QK^T 计算（O(n²d)）         │
│                                                             │
│  2. COMPUTE LOSS（计算损失）                                   │
│     Cross-Entropy(Logits[shifted], Labels)                   │
│     - Logits 去掉最后一个 token 的预测                        │
│     - Labels 去掉第一个 token（因为无上文）                    │
│                                                             │
│  3. BACKWARD PASS（反向传播）                                  │
│     loss.backward() → 计算每个参数的梯度 ∂L/∂θ                │
│     - 显存峰值通常在此阶段出现                                │
│     - Activation Checkpointing 在此处 trade compute for memory│
│                                                             │
│  4. OPTIMIZER STEP（优化器更新）                               │
│     AdamW: θ = θ - lr * (m_hat / (sqrt(v_hat) + ε))         │
│     - m: 一阶动量（梯度指数移动平均）                          │
│     - v: 二阶动量（梯度平方指数移动平均）                      │
│     - Gradient Clipping: 防止梯度爆炸                        │
│     - 更新后清零梯度（为下一步做准备）                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

每一步的实际计算中，前向传播和反向传播占用了绝大部分 GPU 时间，优化器更新的计算量相对很小。在典型的 Transformer 训练中，前向 + 反向的计算量约为纯前向的 3 倍。

### 1.4 损失曲线（Loss Curves）

理解损失曲线是判断训练是否健康的必要条件。

**健康的损失曲线特征：**
- 整体呈 **平滑下降** 趋势
- 初期（前 1%-5% 的 steps）下降最快
- 中期进入稳定的对数线性下降阶段
- 后期下降速度逐渐放缓，接近收敛
- 训练损失与验证损失差距小且稳定

**Loss Spike（损失尖峰）是什么：**

损失尖峰是指训练过程中损失值突然剧烈跳升的现象——跳跃幅度可以达到正常损失值的 5-20 倍。

```
Loss
 │
 │           ┌── Spike ──┐
 │          ╱             ╲
 │    ─────╱               ╲──────
 │  ╱                               ╲___
 │╱
 └──────────────────────────────────────────→ Steps
```

**常见原因：**
- 某个 batch 的数据质量极差（被污染的文本、随机噪声、格式化异常）
- 学习率过高导致的参数更新过猛
- 梯度爆炸（尤其是训练初期或长时间未 clip 的情况）
- FP16/BF16 精度溢出（某些层的激活值或梯度超出表示范围）
- 数据分布突变（混合数据时某个来源的极端样本）

**如何处理：**
- **小尖峰（< 2x 正常 loss）**：通常可以自行恢复，继续观察
- **大尖峰（> 5x 正常 loss）**：立即回滚到最近的 checkpoint，降低学习率重新开始
- **频繁尖峰**：考虑降低学习率、增加 gradient clipping 强度、检查数据质量

**一个经验法则：** 如果 loss 在 100-200 步内没有回落到尖峰前水平，建议回滚并从更早的 checkpoint 重启。

**Loss 不下降了怎么办：**
- 降低学习率（通常降至原来的 1/10 继续训练）
- 检查是否发生了模型坍塌（model collapse），如重复输出同一 token
- 验证数据 pipeline 是否正常（是否还在喂入有效数据）

### 1.5 Checkpointing（检查点保存）

预训练通常持续数周到数月——中间随时可能出问题（硬件故障、loss spike、想回滚实验），所以 checkpoint 策略非常关键。

**典型的 Checkpoint 保存策略：**
```
每 N steps 保存一次（如每 1000 steps）
保留最近 K 个 checkpoint（如最近 5 个）
保存内容：
  - model_state_dict（模型权重）
  - optimizer_state_dict（Adam 动量 m 和 v）
  - scheduler_state_dict（学习率调度器状态）
  - training_step（当前步数）
  - consumed_tokens（已消费 token 数）
  - random_states（随机数种子 → 保证可复现）
  - config（模型超参数）
```

单个 checkpoint 的大小估算（以 LLaMA-7B 为例）：

```
模型权重:       7B × 2 bytes (BF16)    = ~14 GB
优化器状态(m+v): 14 GB × 2              = ~28 GB
合计（不含其他）:                         ≈ 42 GB / checkpoint
```

所以保留 5 个 checkpoint 需要 200+ GB 的存储空间。实际中通常使用**异步保存**（后台线程写入磁盘，不阻塞训练）来减少 I/O 开销。

### 1.6 关键训练指标

| 指标 | 定义 | 意义 |
|------|------|------|
| **Loss** | 交叉熵损失 | 最直接的训练进度指标，越低越好 |
| **Perplexity (PPL)** | \( e^{Loss} \) | 更直观——表示模型在每一步"平均有几个合理选择"。完美模型 PPL=1 |
| **Learning Rate** | 优化器步长 | 遵循 warmup → cosine decay → minimum 的变化曲线 |
| **Gradient Norm** | 梯度的 L2 范数 | 监控稳定性：过大→梯度爆炸；过小→梯度消失 |
| **MFU (Model FLOPs Utilization)** | 实际 FLOPs / 理论峰值 FLOPs | GPU 利用效率，优秀的训练可达 50-60% |
| **Tokens/sec** | 每秒处理 token 数 | 训练速度的直接度量 |

**学习率调度（Learning Rate Schedule）：**

最常用的策略是 **Warmup + Cosine Decay**：

```
lr
 │
 │     ╱‾‾‾‾‾‾‾‾‾‾‾‾‾╲
 │    ╱                  ╲
 │   ╱                    ╲  ← Cosine Decay
 │  ╱                      ╲________
 │ ╱
 │╱ ← Linear Warmup
 └────────────────────────────────────→ Steps
```

- **Warmup 阶段**：学习率从 0 线性增加到目标值（如 3e-4），通常占总步数的 1%-3%
  - 为什么需要 warmup：训练初期梯度不可靠，直接用大学习率容易造成不稳定的参数更新
- **Cosine Decay 阶段**：学习率按照余弦曲线逐渐衰减到最小值（通常为目标值的 10%）
  - 余弦衰减在开始和结束时变化缓慢，中间阶段变化较快，有助于在不同阶段找到合适的下降速度

### 1.7 训练时间估算

以 LLaMA-7B 为例：

```
模型规模:         7B parameters
训练数据:         1T tokens
硬件:            1024 × A100 80GB
Global Batch Size: ~4M tokens
Steps:            1T / 4M = 250,000 steps
单步时间:         约 9 秒
总训练时间:       250,000 × 9s ≈ 2,250,000s ≈ 26 天
GPU 花费:         1024 × 26 × 24h ≈ 640,000 GPU-hours
```

更大模型的时间估算（基于公开信息）：
- LLaMA-13B（1T tokens, 2048 A100s）：约 24 天
- LLaMA-65B（1.4T tokens, 2048 A100s）：约 21 天
- 更大规模（如 GPT-4 量级）：估计 10,000+ H100s 运行数月

核心瓶颈是 **通信**（多卡之间梯度同步的 AllReduce）和 **显存**（模型状态 + 激活值 + 优化器状态）。参见 [[混合精度训练]] 和 [[显存计算详解]]。

**扩展定律（Scaling Laws）：**

根据 Chinchilla 缩放定律，给定计算预算 C，最优方案是：
- 模型参数量 N ∝ C^0.5
- 训练 token 数 D ∝ C^0.5
- 即模型大小和训练数据量应该等比例增长

简单来说，每增加 1 个参数，应该增加约 20 个训练 token。例如 7B 模型应训练约 140B tokens（实践中往往训练更多以求更好性能）。

---

## 2. SFT（监督微调）

> 📖 已掌握

预训练得到的是一个"完形填空"模型——它知道下一个词是什么，但不知道要"回答问题"。SFT 教模型按照人类的指令格式来回复。

### 2.1 数据格式

SFT 数据是 **(instruction, response) 对**，有时会加上 system prompt：

```
{
  "messages": [
    {"role": "system", "content": "你是一个有帮助的AI助手"},
    {"role": "user", "content": "解释什么是黑洞"},
    {"role": "assistant", "content": "黑洞是宇宙中引力极强的区域..."}
  ]
}
```

**数据量对比：**

| 阶段 | 数据量 | 数据来源 |
|------|--------|----------|
| Pre-training | 1T+ tokens | 网页、书籍、代码（自监督） |
| SFT | 10K - 1M pairs | 人工标注 / 合成（有监督） |

SFT 数据通常来自：
- 人工标注（质量最高，但成本高昂）
- 更强大的模型生成（如 GPT-4 生成 → 训练小模型，Self-Instruct 范式）
- 开源数据集（Alpaca, ShareGPT, OpenOrca, UltraChat 等）

高质量 SFT 数据的特征：
- 指令多样性（涵盖不同领域、难度、格式要求）
- 回复准确性和完整性
- 良好的格式一致性
- 覆盖安全性和拒绝回答的场景

### 2.2 与预训练的差异

| 维度 | Pre-training | SFT |
|------|-------------|-----|
| 数据量 | ~1T tokens | ~10K-1M pairs（百万到亿级 tokens） |
| 训练方式 | 全参数 | 全参数 / LoRA |
| 损失计算 | 所有 token | **仅 response 部分的 token** |
| 典型 Epoch | 1 epoch（数据太多，不会过拟合） | 2-5 epochs |
| 训练时间 | 数周/数月 | 数小时 |
| 学习率 | 3e-4 | 2e-5 ~ 5e-5（比预训练低一个数量级） |

**为什么要仅在 response 部分计算损失：**

```
Input tokens:  [INST] 解释什么是黑洞 [/INST]
Response tokens: 黑洞是宇宙中...引力极强...质量极大...
                   ↑ 只在这部分计算损失 ↑
```

如果对 instruction 部分也计算损失，模型会学习"生成指令 + 回答"，这会导致推理时模型可能继续自我生成指令，而不是直接回答。所以实践中会把 instruction/user 部分的 label 设为 -100（PyTorch 中 ignore_index）来屏蔽损失。

### 2.3 LoRA（Low-Rank Adaptation）

对于资源有限的场景，LoRA 是 SFT 的首选方案。核心思想来自一个经验观察：模型适配新任务时，权重矩阵的变化是低秩的。

**原理：**
```
冻结原始权重 W (d×k)
添加可训练的旁路:
  ΔW = B × A
  其中 B: d×r, A: r×k, r << min(d,k)

前向计算: h = Wx + ΔWx = Wx + BAx
```

一个 7B 模型的全参数 SFT：
- 需要加载 7B × 2 bytes = 14 GB（仅模型）+ 优化器状态 ≈ 42 GB

使用 LoRA（r=16）：
- 可训练参数仅约 0.1% - 1%
- 显存需求大幅降低，单卡即可训练
- 训练速度提升（不需要计算全量梯度）
- 可以保存多个 LoRA adapter 快速切换不同任务

**LoRA 超参数选择：**
- Rank r：通常 8-64，越大表达能力越强但参数越多
- Alpha：缩放因子，通常设为 r 的 2 倍
- Target modules：通常选 Q 和 V 的投影矩阵（q_proj, v_proj）
- Dropout：0.05 - 0.1，防止过拟合

### 2.4 为什么 SFT 这么快

- **数据少**：10K-1M 条对话 vs 1T tokens
- **步数少**：只需几千到几万步，不是几十万步
- **序列短**：SFT 序列通常 2K-4K tokens，预训练常用 4K-8K（甚至更长）
- **显存充裕时可以增大 batch size**，进一步提高吞吐

在 8×A100 上，一个 7B 模型的全参数 SFT（10K 条数据，3 epochs）通常只需 **2-4 小时**。

### 2.5 过拟合风险

SFT 数据量远小于预训练，过拟合是一个真实的风险。

**过拟合的迹象：**
- 训练 loss 持续下降但验证 loss 开始上升
- 模型开始"背诵"训练数据（逐字重复 SFT 样本中的回复）
- 通用能力下降（如数学、代码等预训练阶段获得的能力退化）
- 回复变得千篇一律，缺乏多样性

**缓解策略：**
- **Early Stopping**：监控验证集 loss，在上升前停止
- **小学习率**：2e-5 显著优于 1e-4
- **数据增强**：同一 instruction 生成多个高质量回复变体
- **混合数据**：在 SFT 数据中混入少量预训练数据，维持通用能力
- **Weight Decay**：轻微的 L2 正则化

---

## 3. RLHF（人类反馈强化学习）

> 📖 已掌握（核心概念） | 📝 待补充（GRPO 实现细节、DPO 变体）

RLHF 是目前让 LLM 输出更"符合人类偏好"（有帮助、诚实、无害）的主流方法。它解决的核心问题是：**"正确回答"不等于"好的回答"**。

两个不同的回答可能都是事实正确的，但人类明显偏好其中一个——更清晰、更简洁、更安全、更有帮助。这种偏好难以用 SFT 的固定标签来捕捉，因为它是相对的、主观的、依赖上下文的。

### 3.1 三阶段流程

```
┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Step 1      │    │  Step 2          │    │  Step 3          │
│  训练 Reward  │ → │  PPO/GRPO 训练    │ → │  迭代优化         │
│  Model       │    │  (RL 阶段)       │    │  收集新数据再来    │
└──────────────┘    └──────────────────┘    └──────────────────┘
```

### 3.2 Step 1：训练 Reward Model（奖励模型）

**数据格式：偏好对（Preference Pairs）**

```
Prompt: 解释什么是黑洞

Response A（chosen/win）：黑洞是时空曲率大到光都无法逃脱的天体...
Response B（rejected/loss）：黑洞就是黑黑的洞，很大很黑...
                                                ↑
                                    标注员选择 A > B
```

**训练目标：Bradley-Terry 模型**

\[
P(A > B | prompt) = \frac{e^{r(prompt, A)}}{e^{r(prompt, A)} + e^{r(prompt, B)}} = \sigma(r_A - r_B)
\]

损失函数：

\[
\mathcal{L}_{RM} = -\mathbb{E}_{(x, y_w, y_l)}\left[\log \sigma(r_\theta(x, y_w) - r_\theta(x, y_l))\right]
\]

其中 \( y_w \) 是偏好的回答（win），\( y_l \) 是不偏好的回答（loss），\( \sigma \) 是 sigmoid 函数。直观理解：让 reward model 给好的回答打更高的分，差的回答打更低的分，拉大两者之间的差距。

**Reward Model 架构：**
- 通常从 SFT 模型初始化（共享主干，最后加一个线性头输出标量分数）
- 也可以是共享参数的（ppo 时不需要单独加载）
- 规模通常与 policy model 相同或略小

### 3.3 Step 2：PPO 训练

PPO（Proximal Policy Optimization）是 RLHF 阶段最经典的方法。

**PPO 工作流（每个迭代）：**

```
┌──────────────────────────────────────────────────────────┐
│  PPO Iteration                                           │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  1. SAMPLE（采样）                                        │
│     Policy 模型针对一批 prompts 生成 responses              │
│                                                          │
│  2. SCORE（打分）                                         │
│     Reward Model 对每个 (prompt, response) 打分            │
│                                                          │
│  3. REWARD SHAPING（奖励塑形）                             │
│     Final Reward = RM_Score - β × KL(policy || reference) │
│     KL 惩罚项防止 policy 偏离 reference 太远               │
│     （reference = 初始 SFT 模型，β 通常 0.02-0.1）       │
│                                                          │
│  4. ADVANTAGE ESTIMATION（优势估计）                       │
│     GAE (Generalized Advantage Estimation)               │
│     A_t = Σ (γλ)^l × (r_{t+l} + γV(s_{t+l+1}) - V(s_t)) │
│                                                          │
│  5. POLICY UPDATE（策略更新）                              │
│     L^{CLIP}(θ) = min(ratio × A, clip(ratio, 1-ε, 1+ε) × A)│
│     其中 ratio = π_θ(a_t|s_t) / π_old(a_t|s_t)            │
│     ε = 0.2 是典型的裁剪范围                                │
│                                                          │
│  6. VALUE UPDATE（价值函数更新）                           │
│     训练 Critic 网络使其 V(s) 更准确地预测实际回报           │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**PPO 的四个模型（显存大户）：**
1. **Policy Model**（要训练的模型）——被优化
2. **Reference Model**（冻结的 SFT 模型，与 Policy 结构完全相同）——用于计算 KL 散度，确保 Policy 不会跑偏
3. **Reward Model**（打分模型）——对生成的回复打分
4. **Critic Model**（价值网络，结构与 Policy 类似但有 value head）——估计每个状态的期望回报

四个模型同时驻留在 GPU 显存中，这是 RLHF 显存需求极大的根本原因。

### 3.4 GRPO（Group Relative Policy Optimization）

> 📝 待补充

来自 DeepSeek-R1。核心创新：**不需要 Critic Model**。

**GRPO 的核心思想：**

```
传统 PPO:                          GRPO:
每个 prompt 生成 1 个 response      每个 prompt 生成 G 个 responses (如 G=8)
→ 需要 Critic 估计 Advantage       → 组内互相对比计算 Advantage
```

GRPO 的优势估计方式：

\[
A_i = \frac{r_i - \text{mean}(r_1, ..., r_G)}{\text{std}(r_1, ..., r_G)}
\]

不再需要训练一个单独的 Critic 来估计状态价值。Advantage 直接由**组内标准化**得到——好的回复的 reward 高于组均值就是正优势，低于均值就是负优势。这显著减少了显存开销（省去 Critic 模型），同时组内对比天然提供了更稳定的训练信号。

**GRPO vs PPO 对比：**

| 维度 | PPO | GRPO |
|------|-----|------|
| 模型数量 | 4 (Policy + Reference + Reward + Critic) | 3 (Policy + Reference + Reward) |
| Advantage 来源 | GAE + Critic 估计 | 组内相对比较 |
| 采样效率 | 中 | 高（G 个响应共享一个 prompt） |
| 训练稳定性 | 依赖 Critic 质量 | 更稳定，但需要足够大的 G |
| 代表工作 | InstructGPT, ChatGPT | DeepSeek-R1 |

### 3.5 DPO（Direct Preference Optimization）

> 📖 已掌握

DPO 是一个更简单的替代方案——**完全不需要单独的 Reward Model**。

**核心洞察：** 在 Bradley-Terry 偏好模型下，最优 policy \( \pi^* \) 和 reward function 之间存在一一对应关系：

\[
r(x, y) = \beta \log \frac{\pi^*(y|x)}{\pi_{\text{ref}}(y|x)} + \beta \log Z(x)
\]

将这个关系代入 Reward Model 的损失函数，可以直接得到 DPO 的损失：

\[
\mathcal{L}_{\text{DPO}} = -\mathbb{E}_{(x, y_w, y_l)}\left[ \log \sigma\left( \beta \log \frac{\pi_\theta(y_w|x)}{\pi_{\text{ref}}(y_w|x)} - \beta \log \frac{\pi_\theta(y_l|x)}{\pi_{\text{ref}}(y_l|x)} \right) \right]
\]

**直观理解：** 增大偏好回答相对于初始模型的概率，同时减小不偏好回答的相对概率。β 控制偏离 reference model 的程度。

**DPO vs PPO/RLHF：**

| 维度 | PPO | DPO |
|------|-----|-----|
| 不需要 Reward Model | ❌ | ✅ |
| 不需要 Critic | ❌ | ✅ |
| 在线采样 | ✅ | ❌（离线训练） |
| 训练稳定性 | 低 | 高 |
| 显存需求 | 极大（4个模型） | 中等（2个模型） |
| 性能上限 | 更高（可迭代） | 受限于偏好数据质量 |

DPO 的代价是：它使用的是**静态的偏好数据集**，无法像 PPO 那样在线探索——模型无法通过生成新回复获得新的奖励信号。这限制了它的性能上限。

### 3.6 为什么 RLHF 不稳定

RLHF 被称为"训练最难的阶段"，原因包括：

1. **奖励黑客（Reward Hacking）**：Policy 学会利用 Reward Model 的漏洞获得高分，但不代表回复质量真的好。例如模型发现使用某些"高分词汇"（如"详细地"、"全面地"）可以骗过 reward model 拿到高分，但实际内容并没有变好。

2. **多模型协调复杂**：PPO 需要 4 个模型（Policy、Reference、Reward、Critic）同时配合，其中任何一个出问题都会影响训练。超参数组合爆炸式增长，调参难度极高。

3. **KL 散度与性能的平衡**：β 太小 → Policy 偏离太远、可能产生胡言乱语（reward hacking）；β 太大 → Policy 绑在 reference 附近、无法有效优化。合适的 β 值通常需要在 0.01-0.1 之间反复试验。

4. **Reward Model 的质量瓶颈**：Reward Model 本身也是训练的，它的评分可能不准确或存在偏差。如果 reward model 对大段文字、特定风格、使用某种语言（如英文）有系统性偏好，policy 就会学到这些偏差。

5. **分布漂移（Distribution Shift）**：Policy 更新后生成的回复分布变了，但 Reward Model 是在旧分布上训练的 → 在新分布上评分不准 → 训练信号噪音增大。这就是 RLHF 需要经常迭代（重新收集偏好数据、重新训练 reward model）的原因。

---

## 4. Inference（推理）

> 📖 已掌握

![[assets/推理两阶段PrefillDecode.svg|1000]]

推理阶段的目标是效率——以最小的延迟和成本生成高质量的文本。理解推理的内部机制对于部署优化至关重要。

### 4.1 自回归生成（Autoregressive Generation）

LLM 一次只生成一个 token：

```
输入： "今天天气"
  ↓
Step 1: 输出 "真"
Step 2: 上下文变为 "今天天气真"，输出 "好"
Step 3: 上下文变为 "今天天气真好"，输出 "！"
Step 4: 上下文变为 "今天天气真好！"，输出 <EOS>
  ↓
最终输出： "今天天气真好！"
```

每生成一个 token 都需要：
1. 把整个序列（包括刚生成的 token）喂给模型
2. 模型输出下一个 token 的概率分布
3. 根据采样策略选择下一个 token

### 4.2 KV Cache

KV Cache 是 LLM 推理中最重要的优化，没有之一。

**为什么需要 KV Cache：**

在 Self-Attention 中，每个 token 需要与所有之前的 token 计算注意力：

```
Attention(Q, K, V) = softmax(QK^T / √d_k) × V

对 token t：
  Q_t: 来自当前 token 的投影（需要重新计算）
  K_1,...,K_{t-1}: 之前 token 的 Key（已经算过了！不需要重算）
  V_1,...,V_{t-1}: 之前 token 的 Value（已经算过了！不需要重算）
```

**没有 KV Cache：** 每生成一个 token 都要对整条序列重新计算所有 K 和 V → 计算量 O(n²) 且重复计算 → 完全不可接受。

**有 KV Cache：** 之前 token 的 K 和 V 向量缓存在显存中，新 token 只需要计算自己的 QKV，然后用新的 Q 去 attend 所有的 K 和 V。计算量从 O(n²) 降到 O(n)。

**KV Cache 显存占用计算：**

```
KV Cache 大小 = 2 × n_layers × n_heads × d_head × seq_len × 2 bytes (FP16)

以 LLaMA-7B 为例（n_layers=32, n_heads=32, d_head=128）：
  1 token:   2 × 32 × 32 × 128 × 2 = 524,288 bytes = 0.5 MB
  1K tokens: 0.5 GB
  4K tokens: 2 GB
  8K tokens: 4 GB
```

KV Cache 的显存占用与序列长度成线性关系，序列越长、显存压力越大。对于长上下文推理场景，KV Cache 往往是显存的瓶颈。

### 4.3 推理的两阶段特性

```
┌──────────────────────────────────────────────────────────────────┐
│                    LLM 推理的两个阶段                               │
├──────────────────┬───────────────────────────────────────────────┤
│  Prefill（预填充） │  Decode（解码）                                │
│  处理输入 Prompt   │  逐 token 生成输出                             │
├──────────────────┼───────────────────────────────────────────────┤
│                   │                                               │
│  输入: Prompt     │  输入: 前一步生成的 token                        │
│  输出: 第一个 token│  输出: 下一个 token                             │
│                   │                                               │
│  矩阵乘法: 大      │  矩阵乘法: 小                                   │
│  计算密度高        │  计算密度低                                     │
│  Compute-Bound    │  Memory-Bandwidth-Bound                        │
│                   │                                               │
│  GPU 利用率高      │  GPU 利用率低                                   │
│  瓶颈: 算力        │  瓶颈: 显存带宽（读写 KV Cache）                  │
│                   │                                               │
│  适合集群/大卡     │  适合高带宽卡、小模型                             │
│                   │                                               │
└──────────────────┴───────────────────────────────────────────────┘
```

**Prefill 阶段（计算密集型）：**
- 输入 prompt 的所有 token **并行**处理（可以充分利用矩阵乘法优化）
- 计算量：O(n²)，其中 n 是 prompt 长度
- 瓶颈是 GPU 的计算能力（FLOPS）
- 可以通过增加 batch size 来提高 GPU 利用率
- 产生第一个 token 的延迟主要取决于这个阶段

**Decode 阶段（显存带宽密集型）：**
- 一次只处理 **1 个新 token**
- 计算量很小，但需要从显存中读取整个 KV Cache
- 瓶颈是 GPU 的显存带宽（HBM Bandwidth），不是计算能力
- Decode 阶段占据了推理总时间的绝大部分（生成 100 个 token，99 步在 decode）
- 延迟主要由显存带宽决定

**为什么两个阶段需要不同的 GPU 配置：**
- Prefill 阶段希望更多的 FLOPS 和更大的 batch → 大卡（如 H100）表现更好
- Decode 阶段希望更高的显存带宽和更小的延迟 → HBM 带宽是关键指标
- 部署时需要权衡：是用少量大卡同时处理 prefill 和 decode，还是用多张小卡分别处理

---

## 5. Sampling Strategies（采样策略）

> 📖 已掌握

采样策略直接决定了模型输出的质量、多样性和可控性。

### 5.1 核心概念

模型输出的是 vocabulary 上每个 token 的 **logits**（未归一化的分数）：

```
logits → softmax → probabilities → sample → token
```

采样策略就是在"选择最好的 token"和"保持多样性"之间找平衡。

### 5.2 各策略详解

#### Greedy（贪心解码）

```
next_token = argmax(logits)
```

- 每步选择概率最高的 token
- **确定性**输出：同一个输入总是得到相同的输出（除非有随机种子差异）
- 问题：容易陷入重复循环，输出单调、机械
- 适用于：翻译、代码生成等需要确定性输出的场景
- **不推荐**用于创意写作或对话

#### Temperature

```
scaled_logits = logits / temperature
probs = softmax(scaled_logits)
```

- Temperature = 1.0：原始分布，不做调整
- Temperature < 1.0（如 0.3）：概率分布更尖锐（高概率 token 更高）→ 输出更确定、更保守
- Temperature > 1.0（如 1.5）：概率分布更平坦（低概率 token 也有机会被选中）→ 输出更多样但可能出错
- Temperature → 0：趋近于 greedy
- Temperature → ∞：趋近于均匀随机采样

**经验参考：**
- 代码生成：0.1 - 0.3
- 翻译：0.3 - 0.5
- 通用对话：0.7 - 0.9
- 创意写作：0.9 - 1.2

#### Top-k Sampling

```
只从 logits 最高的 k 个 token 中采样，其余 token 的概率置零
k = 50 → 从最可能的 50 个 token 中采样
```

- 防止极低概率的 token 污染输出
- k 太小（如 5）→ 输出过于受限
- k 太大（如 500）→ 低质量 token 仍可能被选中
- 固定 k 的问题：对于"确定性"的位置（如"中国的首都是___"），50 个候选太多；对于"创意性"的位置（如故事开头），50 个候选可能不够
- k 值推荐范围：10 - 100

#### Top-p（Nucleus Sampling）

```
在概率从高到低累积到 p 的 token 集合中采样
p = 0.9 → 选择累积概率刚好超过 90% 的那组 token
```

- 动态调整候选集大小：当模型很确定时（概率集中在少数 token），候选集很小；当模型不确定时，候选集更大
- 比固定 k 更灵活和合理
- 常用值：0.9 - 0.95

#### Repetition Penalty

```
logits[t] = logits[t] - penalty * has_appeared[t]
或
logits[t] = logits[t] / repetition_penalty  (如果 token 已出现过)
```

- 对已经出现过的 token 施加惩罚
- 防止模型陷入循环（不断重复同一段话）
- penalty 常用值：1.0 - 1.2（1.0 = 不惩罚，> 1.0 = 惩罚）
- 过高（> 1.5）会导致模型刻意避免使用某些常见词汇
- 一些实现还会区分 n-gram 级别的重复惩罚

### 5.3 推荐配置速查

| 场景 | Temperature | Top-p | Top-k | Rep. Penalty |
|------|-------------|-------|-------|--------------|
| 代码生成 | 0.2 - 0.3 | 0.95 | 50 | 1.0 |
| 翻译 | 0.3 | 0.9 | 50 | 1.0 |
| 事实问答 | 0.3 - 0.5 | 0.9 | 50 | 1.05 |
| 通用对话 | 0.7 | 0.9 | 50 | 1.1 |
| 创意写作 | 0.8 - 0.9 | 0.95 | 80 | 1.05 |
| 头脑风暴 | 0.9 - 1.0 | 0.95 | 100 | 1.0 |

最常用的"安全"配置：temperature=0.7, top_p=0.9（适合大多数对话场景）。

---

## 6. Batch Inference（批量推理）

> 📖 已掌握

服务场景下需要同时处理多个用户的请求。如何高效地批量推理是推理系统设计的核心。

### 6.1 Static Batching 的问题

```
静态批处理：
┌──────────────────────────────────────┐
│  Batch: [Req1, Req2, Req3, Req4]     │
│  Req1: "What is AI?" → 短                               │
│  Req2: "Write an essay about..." → 很长                                  │
│  Req3: "Hello" → 非常短                  │
│  Req4: ...中等长度...                                 │
│                                      │
│  必须等待最长的 Req2 完成才能开始下一批                      │
└──────────────────────────────────────┘
```

问题：
- 短请求完成后 GPU 闲置，等待长请求（木桶效应）
- Batch 大小固定，无法动态调整
- 资源利用率低（大量空闲时间）

### 6.2 Continuous Batching（连续批处理）

```
连续批处理：
┌──────────────────────────────────────────────────┐
│  Step 1: [Req1, Req2, Req3, Req4]                 │
│  Step 2: [Req1, Req2, Req3, Req4]                 │
│  Step 3: Req3 完成 → 从 batch 移除                 │
│  Step 4: [Req1, Req2, Req4, → Req5 加入]           │
│  Step 5: [Req1, Req2, Req4, Req5]                 │
│  Step 6: Req1 完成 → 移除; Req6 加入               │
│  ...                                              │
│  GPU 始终保持满载状态                               │
└──────────────────────────────────────────────────┘
```

核心思想：
- 每个 decode step 后检查哪些请求已完成（生成 EOS token 或达到 max_tokens）
- 完成的请求从 batch 中移除
- 新到达的请求（已完成 prefill）加入 batch
- **GPU 端到端持续工作，没有空闲等待**

效果：相比静态批处理，吞吐量通常可以提升 **5-10 倍**。

### 6.3 vLLM 的 PagedAttention

vLLM 是目前最流行的 LLM 推理框架，核心创新是 **PagedAttention**。

**KV Cache 管理的类比：**
```
操作系统虚拟内存        →    PagedAttention 的 KV Cache
─────────────────────────────────────────────────
物理内存分页 (4KB)      →   KV Cache 分块 (block)
每个进程有页表           →   每个请求有 block table
页面可以非连续存放       →   KV blocks 可以非连续存放
换页 (swap)             →   必要时可以 swap 到 CPU 内存
```

**为什么这很重要：**

传统的 KV Cache 管理方式是为每个请求预分配一块连续的显存空间（按最大可能长度分配）。这造成：
- 大量 **内部碎片**（实际生成了 500 tokens 但预分配了 4096 的空间）
- 不同请求之间的 KV Cache **不能共享**
- 预分配限制了一个 batch 中能处理的请求数量

PagedAttention 的解决方案：
- KV Cache 被分割成固定大小的 blocks（如 16 tokens/block）
- 请求按需分配 blocks，不需要预分配最大长度
- 不同请求可以共享相同的 blocks（如所有请求共享 system prompt 的 KV Cache）
- 显存利用率从传统方式的 20-30% 提升到 **80-90%**
- 可以处理 **10-20 倍**的并发请求量

### 6.4 Throughput vs Latency

| 指标 | 优化方向 | 方法 |
|------|----------|------|
| **Throughput（吞吐量）** | 每秒处理更多 token | 增大 batch size、连续批处理、量化 |
| **Latency（延迟）** | 每个请求更快的响应 | 减少 batch size、更快的 GPU、KV Cache 优化 |
| **TTFT（Time To First Token）** | 首 token 更快出现 | 优化 prefill 阶段、prefill chunking |
| **TPOT（Time Per Output Token）** | 每个生成 token 更快 | 高显存带宽、小模型 |

**实际部署中的权衡：**
```
增大 batch → 吞吐量 ↑ 但延迟 ↑（每个请求分到的计算资源更少）
减小 batch → 延迟 ↓ 但吞吐量 ↓（GPU 利用率降低）

服务化部署通常设置：
  max_batch_size 和 max_wait_time 来平衡
```

---

## 7. Practical GPU Ops（GPU 算力实践）

> 📖 已掌握

不同阶段的 GPU 使用特性完全不同，理解这些差异是高效训练和部署的前提。

### 7.1 阶段对比一览

| 阶段 | 瓶颈类型 | 关键指标 | 显存主要消耗 | GPU 配置建议 |
|------|----------|----------|-------------|-------------|
| **Pre-training** | Compute-Bound | MFU（越高越好） | 模型参数 + 优化器状态 + 激活值 | 多卡集群，NVLink/InfiniBand，大VRAM |
| **SFT** | Compute-Bound（但时间短） | 灵活性、快速实验 | 模型参数 + 优化器状态（LoRA 可大幅减少） | 单卡或多卡，checkpoint 管理重要 |
| **RLHF** | Compute + Memory-Bound | 稳定性（loss 不爆炸） | 4 个模型同时驻留 + 生成 batch 的 KV Cache | 最大 VRAM，至少 2-4 卡 |
| **Inference** | Memory-Bandwidth-Bound | Tokens/sec, Latency | KV Cache + 模型权重 | 高带宽 GPU，量化优先 |

### 7.2 Pre-training：Compute-Bound，MFU 是王道

**MFU（Model FLOPs Utilization）**衡量 GPU 算力有多少真正用在了模型计算上：

```
MFU = 实际完成的计算量 / 理论最大计算量

优秀水平：50-60%（Megatron-LM 级别优化）
一般水平：30-40%
```

**提升 MFU 的关键技术：**
- 算子融合（Fused Kernels）：将多个小操作合并为一个 CUDA kernel，减少 kernel launch 开销
- 通信计算重叠（Overlap）：在反向传播计算的同时进行梯度通信（AllReduce），隐藏通信延迟
- FlashAttention：减少 attention 计算的显存读写量，通过分块计算避免将完整的 attention matrix 写入 HBM
- Activation Checkpointing：不保存所有激活值，反向传播时重新计算——用额外的 30% 计算时间换取显存空间，使得可以用更大的 batch size

### 7.3 SFT：短平快，Checkpoint 管理重要

SFT 训练时间短（几小时），失败成本低，但需要快速迭代实验。关键操作要点：
- 频繁保存 checkpoint（每几百步）以便回滚
- **务必保留 SFT 前的基座模型 checkpoint**，不要覆盖
- 过拟合的风险真实存在，坚持使用 early stopping
- LoRA 保存的是 adapter 权重而非全量模型，文件更小、切换更快

### 7.4 Inference：Memory-Bandwidth-Bound

**为什么 decode 阶段是 memory-bandwidth-bound：**

每生成一个 token 的计算量：
```
对于 LLaMA-7B（在 A100-80GB 上）：
  计算量: ~14 GFLOPs（非常小）
  显存读取: 模型权重 + KV Cache ≈ 16+ GB
  Compute time: 14G / 312 TFLOPS ≈ 0.045 ms
  Memory time: 16GB / 2039 GB/s ≈ 7.8 ms
  → 99%+ 的时间在等待数据传输！
```

这就是为什么推理优化（量化、KV Cache 压缩、投机解码等）如此重要——计算本身几乎不花时间，几乎所有时间都在等待数据从 HBM 传到计算单元。

**常见推理优化技术：**
- 模型量化（FP16 → INT8/INT4）：减少模型权重和 KV Cache 的显存占用和传输量
- FlashDecoding：优化长序列 decode 阶段的 attention 计算
- 投机解码（Speculative Decoding）：用小模型快速生成多个候选 token，大模型并行验证
- Prefix Caching：缓存相同前缀 prompt 的 KV Cache（尤其对 system prompt 有效）

### 7.5 Continuous Batching 的 GPU 内存管理

连续批处理的核心挑战是 **GPU 显存的动态管理**：
- 新请求到达时需要分配 KV Cache 空间
- 请求完成时需要释放 KV Cache 空间
- 不同请求长度不同，KV Cache 大小也不同
- 碎片化问题严重（频繁分配/释放不同大小的空间）

PagedAttention 的 block 机制很好地解决了这个问题——像操作系统的虚拟内存一样管理 KV Cache，把外部碎片降到最低。这本质上是把 OS 领域几十年的内存管理经验搬到了 GPU 显存管理上。

---

## 相关笔记

- [[Transformer 架构基础]] — 理解 Attention 机制和 Transformer Block 的内部结构
- [[显存计算详解]] — 训练/推理阶段的显存占用详细分解
- [[混合精度训练]] — FP16/BF16 训练的最佳实践和精度控制
- [[Tokenization 与 Embedding 详解]] — 从文本到 token 的全过程

---

## 参考资源

- LLaMA: Open and Efficient Foundation Language Models (Touvron et al., 2023)
- Training language models to follow instructions with human feedback (InstructGPT, Ouyang et al., 2022)
- Direct Preference Optimization (Rafailov et al., 2023)
- DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning (2025)
- vLLM: Easy, Fast, and Cheap LLM Serving with PagedAttention (Kwon et al., 2023)
- Efficient Memory Management for Large Language Model Serving with PagedAttention
- FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness (Dao et al., 2022)
- Scaling Laws for Neural Language Models (Kaplan et al., 2020)
- Training Compute-Optimal Large Language Models (Chinchilla, Hoffmann et al., 2022)

---

> **📖 已掌握：** Pre-training 全流程、SFT 机制、RLHF 三阶段、DPO 原理、推理两阶段特性、采样策略、连续批处理概念  
> **📝 待补充：** GRPO 实现细节（组采样 + 无 Critic 训练的具体实现）、DPO 高级变体（IPO、KTO、SimPO 等）、Speculative Decoding 实战、量化方案对比（GPTQ vs AWQ vs GGUF）、长上下文推理优化（RingAttention 等）、PPO 调参实战经验

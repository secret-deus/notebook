---
date: 2026-06-30
tags:
  - llm
  - transformer
  - attention
type: 学习笔记
category: 大模型训练/架构
source: 个人整理
difficulty: 入门
title: "Transformer 架构基础"
---

# Transformer 架构基础

> Attention Is All You Need（2017）——一篇论文定义了整个大模型时代。理解 Transformer 不是为了成为 AI 研究员，而是为了理解你集群里那几千张 GPU 的显存到底被谁吃了。

## 目录

1. [Transformer 解决了什么问题](#1-transformer-解决了什么问题)
2. [整体架构：一张图看懂](#2-整体架构一张图看懂)
3. [Self-Attention：核心中的核心](#3-self-attention核心中的核心)
4. [Multi-Head Attention：多个角度看问题](#4-multi-head-attention多个角度看问题)
5. [FFN：前馈网络](#5-ffn前馈网络)
6. [参数都藏在哪里](#6-参数都藏在哪里)
7. [为什么 GPU 运维需要懂这个](#7-为什么-gpu-运维需要懂这个)

---

## 1. Transformer 解决了什么问题

在 Transformer 之前，处理文本的主流方案是 **RNN / LSTM**——像一个只能逐字阅读的人。读到第 100 个词时，前 99 个词的记忆已经模糊了。

```
RNN 的工作方式：
[我] → [今天] → [很] → [开] → [心]    ← 一次只能看一个
 ↑ 必须等上一步算完才能算下一步
```

这带来了两个致命问题：

| 问题 | 解释 |
|------|------|
| **无法并行** | 必须等上一步算完，GPU 大量核心闲着 |
| **长距离遗忘** | 句子长了，开头的词和结尾的词很难建立联系 |

**Transformer 的做法完全不同——它让所有 token 同时互相看：**

```
Transformer 的工作方式：
[我] ←→ [今天] ←→ [很] ←→ [开] ←→ [心]
 ↑         ↑         ↑        ↑        ↑
        所有 token 同时计算关联关系
```

这就是 **Self-Attention** 的核心思想：**每个词同时关注句子中的所有词**，不受距离限制。

**为什么这对 GPU 很重要：** 这种"同时处理所有"的模式天然适合 GPU 并行计算——千上万个 CUDA 核心终于可以同时干活，而不用排队等前一步算完。这也是为什么 Transformer 能扩展到数千亿参数、百万 token 上下文——而 RNN 永远做不到。

---

## 2. 整体架构：一张图看懂

![[assets/Transformer架构.svg|1000]]

用最简单的话描述 Transformer 的流程：

```
输入文本
   │
   ▼
┌──────────────┐
│  Tokenizer   │  "你好世界" → [12, 456, 789]  三个 token ID
└──────────────┘
   │
   ▼
┌──────────────┐
│  Embedding   │  每个 token ID → 一个 4096 维的向量（数字列表）
└──────────────┘
   │
   ▼
┌──────────────────────────────────────────────────┐
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │        Transformer Layer × N             │   │  ← N = 32（LLaMA-7B）
│  │                                          │   │       = 80（LLaMA-70B）
│  │  ┌────────────────┐  ┌───────────────┐  │   │
│  │  │  Attention     │→│    FFN        │  │   │
│  │  │  互相看、找关联  │  │  独立加工信息  │  │   │
│  │  └────────────────┘  └───────────────┘  │   │
│  │                                          │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
└──────────────────────────────────────────────────┘
   │
   ▼
┌──────────────┐
│  LM Head     │  最后一个 token → 预测下一个 token 的概率
└──────────────┘
   │
   ▼
"世" → "界" → 输出下一个词
```

**关键概念解释：**

- **Token（词元）：** 模型处理的最小单位。一个中文字 ≈ 1-2 个 token，"transformer" ≈ 2 个 token（"transform" + "er"）。一个 1000 字的文章 ≈ 1500-2000 tokens。
- **Embedding（嵌入）：** 把 token ID 映射成一个高维向量（LLaMA-7B 中是 4096 维）。你可以理解为：给每个词一组 4096 个数字，用来描述它的含义。意思相近的词，这组数字也相近。
- **Layer（层）：** 数据反复经过同一套操作结构。每层都在上一层的输出上继续加工。层数越多 → 模型越深 → 能学到越复杂的模式 → 但显存消耗也越大。

---

## 3. Self-Attention：核心中的核心

### 3.1 直觉理解

想象你是一个 token，站在一群人中间。你要判断：
1. 这些人里谁跟你关系最密切？（**Query**）
2. 他们各自提供了什么信息？（**Key**）
3. 他们实际说了什么内容？（**Value**）

所以 Q、K、V 就是这么来的：

| 角色 | 问题 | 实际含义 |
|------|------|----------|
| **Q（Query，查询）** | "谁跟我有关系？" | 当前 token 想知道什么 |
| **K（Key，键）** | "我有什么信息可以提供？" | 每个 token 的"标签" |
| **V（Value，值）** | "我的实际内容是什么？" | 每个 token 的真实信息 |

### 3.2 计算步骤

假设输入一句话："我 爱 吃 苹果"，每个 token 的 Embedding 维度为 d=4096。

**Step 1：投影到 Q、K、V 空间**

```
输入 X: (4, 4096)    ← 4 个 token，每个 4096 维

Q = X × W_Q → (4, 4096)    ← 这是"提问能力"
K = X × W_K → (4, 4096)    ← 这是"被问到时的回应能力"
V = X × W_V → (4, 4096)    ← 这是"实际传递的内容"
```

W_Q、W_K、W_V 是三组可学习的权重矩阵（训练时会自动调整）。

**Step 2：计算注意力分数**

```
Scores = Q × Kᵀ → (4, 4)

详细图解：![[assets/注意力矩阵推导.svg|1000]]

这个 4×4 的矩阵长这样（示意）：
         我    爱    吃   苹果
  我  [ 0.9  0.3  0.1  0.5 ]
  爱  [ 0.2  0.8  0.6  0.3 ]
  吃  [ 0.1  0.5  0.9  0.7 ]
 苹果 [ 0.4  0.2  0.7  0.8 ]

每一行是"这个 token 看所有 token 的注意力分数"
```

**Step 3：Softmax 归一化**

```
Attention_Weights = Softmax(Scores / √d_k)  ← 除以 √d_k 是为了防止分数太大

归一化后每行加起来 = 1，变成概率分布：
  [ 0.4  0.2  0.1  0.3 ]   ← "我" 最关注自己，然后"苹果"
```

**Step 4：加权求和**

```
Output = Attention_Weights × V → (4, 4096)

"我" 的输出 = 0.4×V_我 + 0.2×V_爱 + 0.1×V_吃 + 0.3×V_苹果
```

### 3.3 为什么会 O(n²)

**这是重点——直接影响你的显存账单。**

注意力分数矩阵的大小是 **(token 数) × (token 数)**。如果你有 n 个 token：

- 计算量：O(n² · d) —— n² 次点积（每个 Q 和每个 K 做点积）
- **显存需求：O(n²) —— 必须存储完整的 n×n 注意力矩阵！**

```
序列长度 n = 1024  →  注意力矩阵 = 1024² = 100 万个元素   ← 还好
序列长度 n = 4096  →  注意力矩阵 = 4096² = 1600 万个元素  ← 开始大了
序列长度 n = 8192  →  注意力矩阵 = 8192² = 6700 万个元素  ← 很多 GPU 开始吃力
序列长度 n = 32768 →  注意力矩阵 = 32K² = 10 亿个元素    ← 这就要 FlashAttention 了
序列长度 n = 128K  →  注意力矩阵 = ...                     ← 需要 KV Cache 压缩
```

**这是 GPU 运维最需要记住的一点：序列长度翻倍，Attention 显存涨 4 倍。**

---

## 4. Multi-Head Attention：多个角度看问题

![[assets/Multi-Head-Attention.svg|1000]]

### 4.1 为什么要多头

一个注意力头只能看到一种关系。如果只用单头，"苹果"可能只能和"吃"建立联系，却看不到"红红"和它的关系。

多头注意力 = 同时从多个角度关注：

| Head | 可能关注的角度 | 示例 |
|------|---------------|------|
| Head 1 | 语法关系 | 主谓宾结构 |
| Head 2 | 语义关系 | "苹果"是水果还是公司？ |
| Head 3 | 位置关系 | 相邻的词 |
| ... | ... | ... |
| Head 32 | 长距离依赖 | 段落开头和结尾的关系 |

### 4.2 实际数字：LLaMA-7B 为例

```
总隐藏维度 d = 4096
头数 h = 32
每头维度 d_k = 4096 / 32 = 128    ← 每头的 Q、K、V 都是 128 维

一个注意力层的数据流：

输入 X: (B, S, 4096)
          │
          ├──→ Q: (B, S, 4096) → reshape → (B, S, 32, 128) → transpose → (B, 32, S, 128)
          ├──→ K: (B, S, 4096) → reshape → (B, S, 32, 128) → transpose → (B, 32, S, 128)
          └──→ V: (B, S, 4096) → reshape → (B, S, 32, 128) → transpose → (B, 32, S, 128)

每个头独立计算 Attention（维度 128，不是 4096）
          │
          ├──→ Head_1: Attention(Q₁, K₁, V₁) → (B, S, 128)
          ├──→ Head_2: Attention(Q₂, K₂, V₂) → (B, S, 128)
          ├──→ ...
          └──→ Head_32: Attention(Q₃₂, K₃₂, V₃₂) → (B, S, 128)

拼接所有头 → (B, S, 4096)
          │
          ▼
    经过 W_O 投影 → (B, S, 4096)  ← 恢复到原始维度
```

**为什么这样设计：** 32 个头各做各的注意力，最后拼接起来，再过一个线性层做"融合"——这样模型能同时学到 32 种不同的注意力模式。

---

## 5. FFN：前馈网络

### 5.1 什么是 FFN

FFN 就是**两层全连接网络**，每个 token 独立经过。注意力和 FFN 各司其职：

```
Attention → 负责"交流"：让 token 之间互相看、交换信息
   FFN   → 负责"思考"：每个 token 把从 Attention 收集到的信息进行深度加工
```

### 5.2 结构

每个 Transformer 层的 FFN 长这样：

```
输入: (S, d)          ← LLaMA 中 d = 4096
   │
   ▼
Linear_up: d → d_ff   ← 升维，d_ff 通常是 d 的整数倍
   │
   ▼
激活函数              ← SwiGLU / GELU
   │
   ▼
Linear_down: d_ff → d ← 降维回原维度
   │
   ▼
输出: (S, d)
```

### 5.3 为什么 FFN 是 4 倍隐藏维度

```
LLaMA-7B 的 FFN：
  输入:  4096
         ↓  × up_proj  (4096 → 11008)
         ↓  × gate_proj (4096 → 11008)
         ↓
  中间:  11008  ← 约 2.7 倍（实际用 8/3 ≈ 2.67 倍）
         ↓
  输出:  4096
```

4 倍（或近似）是个经验值——太小了模型学不到足够知识，太大了浪费计算和显存。

### 5.4 激活函数：SwiGLU vs GELU

```
GELU（GPT 系列用）：
  GELU(x) = x × Φ(x)    ← x 乘以正态分布的累积函数
  形状像一条"圆润的 ReLU"，在 0 附近光滑过渡

SwiGLU（LLaMA 系列用）：
  SwiGLU(x, W, V, W₂) = (xW × SiLU(xV)) × W₂
  比 GELU 多了一个 gate 机制：两路信号逐元素相乘
  效果更好但需要多 50% 的 FFN 参数量（多一个 gate 矩阵）
```

**为什么 LLaMA 选 SwiGLU：** 实验表明在相同计算量下 SwiGLU 效果更好，代价是参数多一些。

---

## 6. 参数都藏在哪里

以 **LLaMA-7B（32 层，d=4096，d_ff=11008，V=32000）** 为例，算一遍总参数量。

### 6.1 每层的参数分布

| 组件 | 矩阵 | 形状 | 参数数量 | 计算 |
|------|------|------|----------|------|
| **Attention** | W_Q | (4096, 4096) | 16.8M | 4096² |
| | W_K | (4096, 4096) | 16.8M | 4096² |
| | W_V | (4096, 4096) | 16.8M | 4096² |
| | W_O（输出） | (4096, 4096) | 16.8M | 4096² |
| **Attention 小计** | | | **67.1M** | 4 × 4096² |
| **FFN** | up_proj | (4096, 11008) | 45.1M | 4096 × 11008 |
| | gate_proj | (4096, 11008) | 45.1M | 4096 × 11008 |
| | down_proj | (11008, 4096) | 45.1M | 11008 × 4096 |
| **FFN 小计** | | | **135.3M** | 3 × 4096 × 11008 |

**每层总计：67.1M + 135.3M ≈ 202.4M 参数**

### 6.2 完整模型参数

```
Transformer 层: 32 × 202.4M ≈ 6477M  ← 占了 96%
Embedding 层:   Vocab × d = 32000 × 4096 ≈ 131M
输出头 (LM Head): Vocab × d = 32000 × 4096 ≈ 131M  ← 通常和 Embedding 共享
LayerNorm:      每层 2 × 4096，32 层 ≈ 0.3M              ← 几乎忽略不计

总计 ≈ 6.7B 参数 ≈ 六七亿参数
```

### 6.3 参数分布比例

```
                   ┌─────────────────────────────┐
                   │         FFN (~66%)          │  ← 显存大头在 FFN 的权重
                   │  up + gate + down           │
                   └─────────────────────────────┘
                   ┌───────────────────────┐
                   │    Attention (~33%)    │
                   │    QKV + Output        │
                   └───────────────────────┘
                   ┌──────┐
                   │Embed │ (~2%)    ← 几乎忽略
                   └──────┘
```

**重点：FFN 占了约 2/3 的参数量，所以你集群中大部分显存存的是 FFN 权重。**

---

## 7. 为什么 GPU 运维需要懂这个

### 7.1 Attention 和 FFN 的显存行为完全不同

|  | Attention | FFN |
|------|-----------|-----|
| **操作类型** | 大量小矩阵乘法、Softmax | 两个大矩阵乘法 |
| **瓶颈** | **显存带宽**（Memory-bound） | **算力**（Compute-bound） |
| **为什么** | Attention 矩阵太大，大部分时间花在读写显存上，GPU 核心在等数据 | 大矩阵乘法能喂饱 GPU 计算单元，效率高 |
| **优化方向** | FlashAttention、KV Cache 压缩 | 使用 Tensor Core、FP8 加速 |

### 7.2 KV Cache：推理时的显存怪物

推理时（生成文本），每个新 token 的 Attention 需要看之前所有 token 的 K 和 V。如果不做缓存，每生成一个 token 都要重新算一遍所有历史 K、V——O(n²) 的重计算。

**KV Cache 的做法：** 把之前所有 token 的 K 和 V 存起来，新 token 直接用。

```
KV Cache 的显存消耗（LLaMA-7B, BF16）：

每层:  2（K+V）× 32（头数）× 128（头维度）× n_token × 2字节 ≈ 16384 × n_token 字节
32层:  16384 × n_token × 32 ≈ 524K × n_token 字节

如果 n_token = 4096:   KV Cache ≈ 524K × 4096 ≈ 2.1 GB
如果 n_token = 32768:  KV Cache ≈ 524K × 32768 ≈ 17 GB
如果 n_token = 128K:   KV Cache ≈ 524K × 131072 ≈ 68 GB
```

**这就是为什么长上下文推理疯狂吃显存——每多一个 token，KV Cache 就多存一份。**

### 7.3 FlashAttention：不用存完整注意力矩阵

标准 Attention 的最大问题是：**必须把完整的 S×S 注意力矩阵存在显存里**，然后再软最大化。S=128K 时，这个矩阵就有 160 亿个元素。

FlashAttention 的 trick：
```
不再一次算完整个 Attention：
  不存注意力的原始矩阵
  ↓
  把 Q、K、V 分块加载到 GPU 的片上共享内存（SRAM）
  ↓
  在芯片内部算完一块直接输出，不写回显存
  ↓
  显存里只存最终的输出，不存中间的注意力权重矩阵
```

效果：显存从 O(n²) 降到 O(n)，同时因为避免了显存读写，反而更快。

### 7.4 训练 vs 推理的显存差异

| 项目 | 训练 | 推理 |
|------|------|------|
| **模型权重** | 1× | 1× |
| **优化器状态** | 2-3×（Adam 的 m、v） | 无 |
| **梯度** | 1× | 无 |
| **激活值（重计算前）** | 每层都有，很大 | 只需当前层 |
| **KV Cache** | 无（每步重新算） | 有，随序列增长 |
| **典型显存比例** | 模型:2× / 优化器:6× / 激活:4× | 模型:1× / KV Cache: 随序列增大 |

训练时显存大头的公式：
```
Total ≈ 权重(2B) + 优化器(12B) + 激活值(可变)
      ≈ 模型参数 × 18-20 倍（BF16 + Adam）
```

---

## 8. Normalization 与残差连接

### 8.1 为什么需要 Normalization

深层网络的每一层输出，数据分布会逐渐偏移。不归一化的话，越深的层输入越"畸形"，训练越来越不稳定。

Normalization 做的事：**把每层的数据拉到均值为 0、方差为 1 的分布**。

### 8.2 LayerNorm（原始 Transformer 用）

```
输入: x ∈ R^d

μ = mean(x)           ← 均值
σ² = var(x)           ← 方差
x̂ = (x - μ) / √(σ² + ε)   ← 归一化
out = γ × x̂ + β           ← 缩放 + 平移（γ、β 是可学习的参数）

γ 和 β 的作用：让模型保留"不归一化"的能力
```

### 8.3 RMSNorm（LLaMA 用，更快）

```
LayerNorm: 需要算均值 AND 方差 → 两次遍历
RMSNorm:  只算 RMS（均方根）→ 一次遍历

RMS(x) = √(mean(x²))

out = x / RMS(x) × γ

比 LayerNorm 少 50% 的计算量，效果几乎一样
LLaMA 全系列用 RMSNorm，因为：
  1. 更快（只算平方均值，不算普通均值）
  2. 更少的参数（不需要 β）
  3. 实验证明效果同等
```

### 8.4 残差连接（Residual Connection）

> 图解：![[assets/残差连接详解.svg|1000]]


**残差连接的公式只有一行**：

```
output = Layer(input) + input
```

就这么简单——把输入原封不动地加到 Layer 的输出上。

**为什么需要这个？** 看反向传播时的梯度：

```
没有残差：output = Layer(input)
  梯度 ∂L/∂input = ∂L/∂output × ∂Layer/∂input
  每层都要乘一次 ∂Layer/∂input → 乘 N 次 → 梯度消失

有残差：output = Layer(input) + input
  梯度 ∂L/∂input = ∂L/∂output × ∂Layer/∂input + ∂L/∂output × 1
                   ↑ 走 Layer 的那条路径        ↑ 走短路的那条路径
  
  短路路径的导数是常数 1 → 跟层数无关 → 梯度永远至少能传回来 1 倍！
```

**用一个具体数字感受**：

```
假设每层的 ∂Layer/∂input ≈ 0.5（小于 1，这是常态）

没有残差，5 层后的梯度：1.0 → 0.5 → 0.25 → 0.125 → 0.0625 → 0.03
  → 只剩 3%，前几层基本学不到东西

有残差，5 层后的梯度：1.0 → 1.5 → 2.25 → 3.38 → 5.06 → 7.59
  → 梯度不但没消失，还在稳定传播！
```

**类比**：残差连接就像给梯度开了一条"高速公路"。没有它，梯度必须一层一层挤过去（每挤一次就衰减一次）；有了它，梯度可以直接飙到最底层。这就是为什么 LLaMA-70B 的 80 层、GPT-4 的上百层都能训练——没有残差，超过 10 层就训不动了。

**LLaMA 一层里的两个残差**：

```
输入 x
  │
  ├──→ RMSNorm → Attention ──→ [+] ──→ 输出 a    ← 残差 1：x 跳到 Attention 后面
  │                   ↑         ↑
  │                   │    a = Attn(Norm(x)) + x
  │
  │    a ──→ RMSNorm → FFN ──→ [+] ──→ 输出 h    ← 残差 2：a 跳到 FFN 后面
  │                   ↑         ↑
  │                   │    h = FFN(Norm(a)) + a
  └── 残差 1 ────────→ ↑
      残差 2 ──────────────────→ ↑
```

每个 Transformer 层有两个残差连接：一个跨 Attention，一个跨 FFN。两层保护，梯度更稳定。

**那残差把输入直接传过去了，Attention/FFN 还有意义吗？**

> 图解：![[assets/残差与主干的分工.svg|1000]]

这是个常见的误解——残差和主干不是竞争关系，是**分工关系**。

残差的角色是「保存已有的好东西」，Attention/FFN 的角色是「找出需要改进的地方」。输出 = x + F(x)，F(x) 学的永远是**相对于 x 的修正量**，不是完整的新值。

类比写文章：残差是把上一版草稿放旁边，Attention/FFN 在上面做批注——「这里加一句、那里改一下」。不是扔掉旧稿重写，而是在底稿上做增量修改。这也是为什么「F(x)=0 时输出还是 x」是精妙的设计而非缺陷——它让 100 层的网络可以安全地从「什么都不做」开始，一层一层往上叠能力。### 8.5 Pre-Norm vs Post-Norm

```
Post-Norm（原始 Transformer）：
  x → Attention(x) → x + Attn_out → Norm → FFN → x + FFN_out → Norm
  优点：输出稳定
  缺点：深层梯度消失，训练不稳定

Pre-Norm（LLaMA 用）：
  x → Norm → Attention(x) → x + Attn_out → Norm → FFN → x + FFN_out
  优点：梯度传播稳定，深层网络也能训练
  缺点：轻微性能损失（但 Pre-Norm 带来的训练稳定性远超这点损失）

LLaMA 的完整层结构：
  x ──→ RMSNorm ──→ Attention ──→ + ──→ RMSNorm ──→ FFN ──→ + ──→ 输出
  │                                 ↑                         ↑
  └─────────────────────残差────────┘                         │
  └──────────────────────────────────────────残差─────────────┘
```

---

## 9. 位置编码（Positional Encoding）

### 9.1 为什么需要位置编码

Self-Attention 本身是**位置无关**的——"我 爱 你"和"你 爱 我"在注意力机制看来是一样的（只是 token 不同）。位置编码告诉模型每个 token 在序列中的位置。

### 9.2 正弦位置编码（原始 Transformer）

```
PE(pos, 2i)   = sin(pos / 10000^(2i/d))
PE(pos, 2i+1) = cos(pos / 10000^(2i/d))

pos: 位置索引 (0, 1, 2, ...)
i:   维度索引 (0, 1, ..., d/2-1)
d:   嵌入维度

效果：不同位置有不同的编码向量
     位置相近 → 编码相近（cos 和 sin 的连续性质）
```

### 9.3 RoPE（旋转位置编码，LLaMA 全系标配）

> 这是当前最重要、最常用的位置编码方案。

**核心思想**：不把位置编码加到 token 上，而是**旋转** token 的 Q 和 K 向量，让它们的点积结果隐含位置信息。

```
传统：token_embedding + position_embedding → 加性的

RoPE：用旋转矩阵 R(θ, pos) 旋转 Q 和 K → 乘性的

第 i 对维度的旋转：
  [q_2i]   [cos(m·θ_i)  -sin(m·θ_i)] [q_2i  ]
  [q_2i+1] = [sin(m·θ_i)   cos(m·θ_i)] [q_2i+1]

  m: token 位置    θ_i = 10000^(-2i/d)  (与正弦编码相同的频率)

效果解析：
  两个 token 的 Q 和 K 的点积：
    (R_m · Q) · (R_n · K) = Q · R_{n-m} · K
  
  → 点积结果只依赖两个 token 的**相对位置差 n-m**
  → 天然支持相对位置
  → 可以外推到训练时没见过的长度（这是 RoPE 最大的优势！）
```

**为什么 RoPE 是最好的选择**：

```
1. 相对位置：注意力天然依赖相对距离，而非绝对位置
2. 外推能力：训练用 4K 上下文，推理可以无损扩展到 8K/16K
   （配合 NTK-aware scaling 甚至可以到 128K+）
3. 不增加参数：不需要额外学习位置向量
4. 与 Attention 深度融合：位置信息直接编码在 Q·K 计算中
```

**RoPE 外推**：
```
训练时 max_seq_len = 4096，但推理可以用 8192：

标准外推：直接跑 → 位置 5000 的频率 θ 训练时没见过 → 效果差

NTK-aware scaling：
  把 θ_i 乘以缩放因子 → 让高频保持不变，低频更密集
  → 训练时见过的低频模式覆盖更长位置
```

### 9.4 ALiBi（线性偏置注意力）

> GPT-NeoX、BLOOM 等模型使用，比 RoPE 更简单

```
不修改 Q、K，而是直接给注意力分数加上一个线性偏置：

Attention_Score[i][j] = Q_i · K_j - m × |i - j|

m: 每头不同的斜率

效果：越远的 token 越被"惩罚"，鼓励关注近处
优点：极简，零额外参数，天然支持任意长度外推
缺点：表达能力不如 RoPE
```

### 9.5 位置编码方案对比

| 方案 | 原理 | 参数 | 外推 | 用在哪 |
|------|------|:---:|:---:|------|
| **Sinusoidal** | sin/cos 函数 | 无 | 差 | 原始 Transformer |
| **Learned** | 可学习的 Embedding | 有 | 无（定长） | GPT-1/2 |
| **RoPE** | 旋转 Q、K | 无 | ✅ 最好 | LLaMA、Qwen、GLM、DeepSeek |
| **ALiBi** | 线性偏置 | 无 | ✅ 好 | BLOOM、GPT-NeoX |

---

## 10. Decoder-Only 架构

### 10.1 为什么现代 LLM 都是 Decoder-Only

原始 Transformer 有 Encoder 和 Decoder 两部分。但 GPT 之后，所有主流 LLM（GPT、LLaMA、DeepSeek、Gemini）都只用 Decoder。

```
Encoder-Decoder (T5, BART):
  输入 → Encoder → 中间表示 → Decoder → 输出
  适合：翻译、摘要（输入和输出长度不同）

Decoder-Only (GPT, LLaMA):
  输入 → Decoder → 输出
  用 Causal Mask 保证只能看到之前的 token
  
  为什么好：
  1. 更简单：少一半的架构，训练和推理都简单
  2. 更高效：Encoder 和 Decoder 共享参数的话就是一份，不共享就是两份
  3. 因果性：自回归生成天然适配 Decoder
  4. Scaling 好：更多层 → 更好的效果，没有 Encoder 瓶颈
```

### 10.2 Causal Mask（因果掩码）

Decoder-Only 的核心约束：**第 i 个 token 只能看到第 0 到第 i 个 token，不能偷看后面的。**

```
原始注意力矩阵（能看到所有人）：
        我   爱   吃   苹果
  我  [ ✓   ✓   ✓   ✓  ]   ← 能看到未来，作弊了！
  爱  [ ✓   ✓   ✓   ✓  ]
  吃  [ ✓   ✓   ✓   ✓  ]
 苹果 [ ✓   ✓   ✓   ✓  ]

加 Causal Mask 后：
        我   爱   吃   苹果
  我  [ ✓   ✗   ✗   ✗  ]   ← 只能看自己
  爱  [ ✓   ✓   ✗   ✗  ]   ← 能看"我"和"爱"
  吃  [ ✓   ✓   ✓   ✗  ]   ← 能看前面三个
 苹果 [ ✓   ✓   ✓   ✓  ]   ← 能看所有

实现：在 Softmax 前把未来位置的分数设为 -∞
      → Softmax 后变成 0 → 不会关注未来
```

### 10.3 自回归生成

```
Input:  "今天天气"
Step 1: Forward("今天天气")   → predict "真"
Step 2: Forward("今天天气真") → predict "好"
Step 3: Forward("今天天气真好") → predict "<eos>"

每一步的输出只取最后一个 token 的预测，拼到序列后面继续。
```

---

## 11. 一层 Transformer 的完整前向传播

把前面所有组件串起来，看一个 token 如何经过一层 Transformer：

```
输入：h_l ∈ R^(S × d)    ← 上一层输出（或第一层的 Embedding）
                             S = 序列长度, d = 隐藏维度

─────────────────────── Attention Block ───────────────────────

Step 1: RMSNorm
  h_norm = RMSNorm(h_l)

Step 2: 投影到 Q, K, V
  Q = h_norm × W_Q   (S, d) × (d, d) → (S, d)
  K = h_norm × W_K
  V = h_norm × W_V

Step 3: 添加 RoPE
  Q_rope = RoPE(Q)     ← 对每对维度应用旋转
  K_rope = RoPE(K)

Step 4: 拆分为多头
  Q: (S, d) → reshape → (S, num_heads, d_head) → transpose → (num_heads, S, d_head)
  K: 同上
  V: 同上
  例 LLaMA-7B: num_heads=32, d_head=128

Step 5: 计算注意力（每个头独立）
  Scores = Q × K^T / √d_head      → (num_heads, S, S)
  Scores = Scores + Causal_Mask    → 未来位置 → -∞
  Weights = Softmax(Scores)        → 归一化到 [0,1]
  Attn_Out = Weights × V           → (num_heads, S, d_head)

Step 6: 合并多头
  Attn_Out: transpose → (S, num_heads, d_head) → reshape → (S, d)

Step 7: 输出投影
  Attn_Out = Attn_Out × W_O   (S, d) × (d, d) → (S, d)

Step 8: 残差连接
  h_attn = h_l + Attn_Out

─────────────────────── FFN Block ───────────────────────

Step 9: RMSNorm
  h_norm2 = RMSNorm(h_attn)

Step 10: SwiGLU FFN
  gate = h_norm2 × W_gate    (S, d) × (d, d_ff) → (S, d_ff)
  up   = h_norm2 × W_up
  activated = SiLU(gate) ⊙ up    ← ⊙ = 逐元素乘法

Step 11: 降维
  out = activated × W_down    (S, d_ff) × (d_ff, d) → (S, d)

Step 12: 残差连接
  h_{l+1} = h_attn + out

─────────────────────── 一层完成 ───────────────────────

输出 h_{l+1} ∈ R^(S × d) → 作为下一层的输入
```

**每层做两次矩阵乘法的总 FLOPs**：

```
Attention: QKV 投影 3×d×d + 输出投影 1×d×d + S²×d_head × heads
         ≈ 4d² + 2·S²·d     (2 来自 QK^T 和 weights×V)

FFN (SwiGLU): up×d×d_ff + gate×d×d_ff + down×d_ff×d
            ≈ 3·d·d_ff

以 LLaMA-7B (d=4096, d_ff=11008, S=4096):
  Attention: 4×4096² + 2×4096²×4096 ≈ 67M + 137G ≈ 137G FLOPs
  FFN: 3×4096×11008 ≈ 135M FLOPs
  
  Attention 的 S² 项在长序列时主导 → 这就是为什么注意力是瓶颈
```

---

## 12. 训练：损失函数与反向传播

![[assets/反向传播原理.svg|1000]]

反向传播解决一个看似不可能的问题：模型有几亿个参数，每个都对最终预测有贡献，你怎么知道每个该调多少？

思路：沿着前向的计算路径，把误差一层一层往回传。最后一层的误差（预测 vs 真值）通过链式法则逐层分解，最终每个参数都收到一个属于自己的修正信号——这个信号精确量化了「如果你变大/变小一点，Loss 会怎么变」。

对 GPU 运维最重要的是：前向时必须把每层的激活值存下来（反向要用），这就是训练显存远超推理显存的根本原因。

### 12.1 Next-Token Prediction（下一个 Token 预测）

LLM 的训练目标极其简单：**给定前面的 token，预测下一个 token**。

```
训练数据："今天天气真好"
Tokenize → [今天, 天气, 真, 好]

Training samples:
  Input:  [今天]           → Target: 天气
  Input:  [今天, 天气]     → Target: 真
  Input:  [今天, 天气, 真] → Target: 好
```

**为什么这能学到一切**：要准确预测下一个词，模型必须理解语法、语义、常识、逻辑——这些知识都隐含在"什么词应该出现在什么词后面"的统计规律中。

### 12.2 Cross-Entropy Loss（交叉熵损失）

```
模型的最后一层输出是 logits: (S, Vocab_Size)
→ 对每个位置，Vocab_Size 个 logit，表示每个词的可能性

Softmax: 把 logits 变成概率
  P(token_i) = exp(logit_i) / Σ exp(logit_j)

Cross-Entropy Loss:
  L = -1/N × Σ log(P(correct_token_at_position_i))

直观理解：
  如果模型很确定正确答案 → P≈1 → -log(1)≈0 → loss 小
  如果模型完全猜错 → P≈0 → -log(0)→∞ → loss 大
```

**训练的 perplexity**：
```
Perplexity = exp(Loss)
可以理解为：模型在每一步相当于从多少个选项中"猜"

Perplexity=10  → 模型每次平均从 10 个候选中猜，水平不错
Perplexity=50  → 模型每次从 50 个候选中猜，还需要训练
Perplexity=3   → 模型非常确信（但也可能过拟合）
```

### 12.3 梯度反向传播

```
Forward:  h_0 → h_1 → ... → h_L → logits → loss
          ↑ 每层产生激活值（需要存着给反向用）

Backward: ∂L/∂logits → ∂L/∂h_L → ... → ∂L/∂h_0 → ∂L/∂W
          ↑ 链式法则：每层的梯度 = 下一层梯度 × 本层导数

对 Attention 的反向：
  ∂L/∂Q = ∂L/∂Attn_Out × ∂Attn_Out/∂Weights × ∂Weights/∂Scores × ∂Scores/∂Q
  ↑ 需要存着 Weights (= Softmax(QK^T/√d)) → 这就是 O(n²) 的激活值！

对 FFN 的反向：
  ∂L/∂W_up = ∂L/∂activated × ∂activated/∂W_up
  ↑ 只需要存 activated，大小约 S × d_ff → 比 Attention 的 S×S 小得多
```

**这就是为什么激活值显存大头在 Attention——反向传播时需要存 S×S 的注意力权重矩阵，而 FFN 只需要 S×d_ff。**

---

## 关联知识

- [[显存计算详解]]
- [[大模型架构对比]]
- [[混合精度训练]]
- [[Tokenization 与 Embedding 详解]]
- [[LLM 训练与推理流程]]

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 骨架创建 | 2026-06-30 | 第一次学习 |
| 完整笔记 | 2026-06-30 | 重新整理，面向 GPU 运维视角 |
| 大幅扩充 | 2026-06-30 | 新增 Norm/Residual、RoPE、Decoder-Only、完整前向传播、训练 Loss |

## 状态标记

📖 已掌握 — Transformer 完整架构、Self-Attention/QKV、Multi-Head、FFN/SwiGLU、参数分布、Norm/残差、RoPE 位置编码、Decoder-Only 因果掩码、完整前向传播流程、Cross-Entropy Loss、反向传播
📝 待补充 — vLLM PagedAttention 实现细节、GQA/MQA 压缩方案、MoE 架构深入

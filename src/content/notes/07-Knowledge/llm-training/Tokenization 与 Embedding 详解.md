---
date: 2026-06-30
tags:
  - llm
  - tokenization
  - embedding
  - bpe
  - vocabulary
type: 学习笔记
category: 大模型训练/基础
source: 个人整理
difficulty: 入门
title: "Tokenization 与 Embedding 详解"
---

# Tokenization 与 Embedding 详解

> 📖 已掌握：BPE 算法原理、词表大小权衡、Embedding 矩阵结构、Special Tokens 用途
> 📝 待补充：SentencePiece 训练细节、mega-batch 下的 tokenization 加速、多语言 tokenizer 公平性评估

---

## 1. Token 是什么，为什么重要

### 1.1 定义

**Token** 是大语言模型的最小语义单元——可以把它理解为 LLM 世界的"原子"。模型不会直接处理原始文本，而是先把文本切分成一个个 token，再把每个 token 映射为一个整数 ID，最后查表得到向量送入模型。

```
原始文本 → Tokenizer → [token IDs] → Embedding 查表 → [向量序列] → Transformer
```

### 1.2 中英文 Tokenization 差异

英文天然有空格分隔，中文则没有。这导致两者的 token 数量差异巨大：

| 文本 | Token 数 (GPT-2 tokenizer) | 说明 |
|------|--------------------------|------|
| `hello world` | 2 | `hello`, ` world`（前导空格） |
| `你好世界` | 4 | `你`, `好`, `世`, `界` |
| `I love machine learning` | 4 | `I`, ` love`, ` machine`, ` learning` |
| `我喜欢机器学习` | 6 | `我`, `喜欢`, `机器`, `学习`（可能更多） |

**关键启示**：同样的语义信息，中文需要 1.5-3 倍的 token 数。这直接影响：
- **上下文窗口成本**：100K 中文 token 能表达的信息远少于 100K 英文 token
- **推理成本**：APIs 通常按 token 计费，中文用户天然付出更多
- **训练数据**：中文语料的"有效密度"低于英文

### 1.3 为什么 Tokenization 如此关键

1. **决定了模型看到的世界**：如果 tokenizer 把 `transformer` 拆成 `trans` + `form` + `er`，三个 token 之间需要通过 attention 重新建立联系——增加了模型的学习难度
2. **影响推理速度**：token 越少 → forward pass 次数越少 → 推理越快。一个 128K 词表比 32K 词表平均少 10-20% 的 token 数
3. **影响训练效率**：分词速度往往是数据管线的瓶颈。一个慢的 tokenizer 可能吃掉一整张 GPU 的时间
4. **决定 OOV（Out-of-Vocabulary）行为**：基于词表的 tokenizer 如何处理未见过的词

---

## 2. BPE（Byte-Pair Encoding）深入剖析

### 2.1 核心思想

BPE 是当前最主流的 tokenization 算法，GPT-2/3/4, RoBERTa, BART 等都在使用。它的思路出奇简单：

> 从字符级别出发，反复**合并出现频率最高**的相邻 token 对，直到达到目标词表大小。

### 2.2 完整示例：以 `"aaabdaaabac"` 为例

假设我们要训练一个 BPE tokenizer，目标词表大小 = 7。

**Step 0 — 字符级初始化**

```
输入: aaabdaaabac
初始 token 序列: a a a b d a a a b a c
初始词表: {a, b, c, d}  (4 个 token)
词表大小: 4
```

统计相邻对的频次：

```
(a,a): 出现了 4 次  → 位置 [0,1], [5,6], [6,7], [7,8]? 
```

仔细数一遍序列 `a a a b d a a a b a c`：
- 位置 (0,1) = (a,a) ✓
- 位置 (1,2) = (a,a) ✓（第一个 a 与第二个 a）
- 位置 (5,6) = (a,a) ✓
- 位置 (6,7) = (a,a) ✓

等等，序列是 `a a a b d a a a b a c`：

```
索引:  0 1 2 3 4 5 6 7 8 9 10
token: a a a b d a a a b a c
```

(a,a) 出现在: (0,1), (1,2), (5,6), (6,7) → 4 次
(a,b) 出现在: (2,3), (7,8) → 2 次
(b,d) 出现在: (3,4) → 1 次
(d,a) 出现在: (4,5) → 1 次
(a,c) 出现在: (9,10) → 1 次
(b,a) 出现在: (8,9) → 1 次
(a,a) 出现在: ???

重新核实 `a a a b d a a a b a c`：

位置 (0,1): a, a → (a,a) ✓
位置 (1,2): a, a → (a,a) ✓
位置 (2,3): a, b → (a,b)
位置 (3,4): b, d → (b,d)
位置 (4,5): d, a → (d,a)
位置 (5,6): a, a → (a,a) ✓
位置 (6,7): a, a → (a,a) ✓
位置 (7,8): a, b → (a,b)
位置 (8,9): b, a → (b,a)
位置 (9,10): a, c → (a,c)

(a,a): 4 次 ← 最高频，合并它！

**Step 1 — 合并 (a,a) → `aa`**

```
新 token 序列: aa aa b d aa aa b a c
新 token: aa
词表: {a, b, c, d, aa}  (5 个)
```

**Step 2 — 统计新一轮频率**

```
(aa, aa): 出现在 (0,1)? → aa=位置0, aa=位置1 → 不对
序列: aa, aa, b, d, aa, aa, b, a, c
      → (aa,aa) 出现在 (0,1) 和 (4,5) → 2 次
(aa, b): 出现在 (2,3)? → 不对
         位置 1=aa, 位置 2=b → (aa,b) 1 次
         位置 5=aa, 位置 6=b → (aa,b) 1 次
(b, d): 1 次
(d, aa): 1 次 (位置 3=d, 位置 4=aa)
(b, a): 1 次
(a, c): 1 次
```

最高频是 (aa,aa): 2 次 和 (aa,b): 2 次。选第一个 (aa,aa) 合并。

**Step 3 — 合并 (aa, aa) → `aaaa`**

```
新序列: aaaa b d aaaa b a c
词表: {a, b, c, d, aa, aaaa}  (6 个)
```

**Step 4 — 再统计**

```
(aaaa, b): 2 次 (位置 0-1, 3-4)
(b, d): 1 次
(d, aaaa): 1 次
(b, a): 1 次
(a, c): 1 次
```

合并 (aaaa, b) → `aaaab`

```
新序列: aaaab d aaaab a c
词表: {a, b, c, d, aa, aaaa, aaaab}  (7 个)
```

**达到目标词表大小 7，停止！**

最终词表：`{a, b, c, d, aa, aaaa, aaaab}`

### 2.3 BPE 如何处理 OOV

BPE 的优雅之处在于：**永远不会有真的 OOV**。因为词表总是包含所有单字节/单字符，任何新词都可以退化为字符序列。

例如测试词 `"xdym"`（未见过的词）：
```
x → d → y → m → 全部分解为字符
如果需要合并 (x,d) 或 (d,y)，但词表中没有，就保持字符级别
```

这种 **子词拆分 + 字符回退** 的机制保证了 BPE 能够表示任何输入。

### 2.4 BPE 的局限性

1. **贪婪合并不可逆**：早期合并决策影响全部后续结果，不保证全局最优
2. **形态不敏感**：`run`, `running`, `runs` 各是独立的子词，没有共享词根 `run`
3. **跨语言不均衡**：高频语言（英语）获得更多合并 → 更紧凑的表示；低频语言退化为单字符 → token 效率低下
4. **Token 边界不一定语义合理**：`ing` 是一个 token，`##tion` 也是一个——但 `transformer` 可能被拆成 `trans` + `form` + `er`

---

## 3. Byte-level BPE（BBPE）—— GPT 的选择

### 3.1 为什么需要 Byte-level

传统 BPE 以 Unicode 字符为基础，但 Unicode 有 149,186 个码点（Unicode 15.1）。如果用字符级初始化，词表初始大小就上万，太浪费。

**BBPE 的思路**：把一切退回到字节（0-255）。

```
Unicode 字符 → UTF-8 字节序列 → BPE 在字节上操作
```

### 3.2 一个中文例子

```
"你" → UTF-8 → [0xE4, 0xBD, 0xA0] → 3 个字节
```

BBPE 的初始词表只有 **256 个 token**（0x00-0xFF），然后在这 256 个基础 token 上进行 BPE 合并。

### 3.3 核心优势

| 特性 | 字符级 BPE | Byte-level BPE |
|------|-----------|----------------|
| 初始词表 | ~150K (全部 Unicode) | 256 |
| OOV 问题 | 基本不存在 | **100% 不存在** |
| 多语言友好 | 需要预分词（语言相关） | 语言无关 |
| 生僻字符编码 | 1 个 token | 可能多个 token（按 UTF-8 字节） |
| 使用方 | 早期模型 | GPT-2/3/4, GPT-Neo, Bloom |

### 3.4 实际例子：GPT-2 tokenizer

```python
# GPT-2 tokenizer 对特殊 Unicode 字符的处理
"🔥"  → 2 tokens: [9468, 236]
"你好" → 4 tokens: [19526, 254, 25001, 121]
```

BBPE 的保证：**所有文本都能被 tokenize，没有 UNK token**。这是 GPT 系列不需要 UNK 的根本原因。

### 3.5 BBPE + 正则预分词

GPT-2 的完整流程还包括一步正则预分词：

```python
# 用正则强制拆分：字母/数字/标点/空格不同类别之间必须切开
pattern = r"""'(?i:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?+\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]++[\r\n]*|\s*[\r\n]|\s+(?!\S)|\s+"""
```

这一步保证了标点符号不会被和被它粘在一起的单词合并成一个奇怪的 token（尽管 `tiktoken` 中已经简化了这一步）。

---

## 4. SentencePiece —— LLaMA 的选择

### 4.1 SentencePiece 是什么

SentencePiece 是一个**语言无关的 tokenization 库**，由 Google 开发。它的核心理念是：

> 把空格也当作一个普通字符来对待。

传统 tokenizer：
```
"hello world" → ["hello", "world"]  // 空格被丢掉，需要加回来
```

SentencePiece：
```
"hello world" → ["▁hello", "▁world"]  // "▁" 就是空格，保留在 token 里
```

这样 decode 时直接拼接即可，不需要额外的还原逻辑——**真正无损**的往返转换。

### 4.2 SentencePiece 集成的三种算法

| 算法 | 原理 | 使用方 | 特点 |
|------|------|--------|------|
| **BPE** | 合并最高频对 | GPT-2, RoBERTa | 确定性的，可预知的合并顺序 |
| **Unigram** | 从大词表逐步剪枝，用 EM 估计每个 token 的贡献 | **LLaMA** (SentencePiece + BPE 变体), T5, XLNet | 概率化，更灵活 |
| **WordPiece** | 类似 BPE，但用"似然增益"而非频率选合并对 | BERT | 训练更慢，但 token 质量通常更好 |

### 4.3 BPE vs Unigram 核心区别

**BPE**：自底向上（从字符开始，不断合并）
**Unigram**：自顶向下（从大词表开始，不断删除低贡献 token）

```text
BPE:
  字符级 → 合并 → 合并 → ... → 达到目标词表

Unigram:
  大初始词表 → 计算每个 token 的损失贡献 → 删除最差的 X% → 重新训练 → ... → 达到目标词表
```

Unigram 每一步都要跑完整训练集的概率估计，计算量更大，但最终词表更"精炼"。

### 4.4 LLaMA 的实际实现

LLaMA 使用的是 SentencePiece 的 BPE 模式（注意不是 Unigram），但做了关键改进：

- **Byte-fallback 机制**：LLaMA 3+ 中，对于不在词表中的字符，直接使用其 UTF-8 字节值作为 token（0-255），不引入 UNK
- **词表大小选择**：LLaMA 1-2 使用 32K，LLaMA 3 扩大到 128K
- **数字拆分**：所有数字被强制拆成单个数字（`2024` → `2`, `0`, `2`, `4`），保证任意数字都能表示

### 4.5 LLaMA vs GPT tokenizer 对比

```python
# LLaMA tokenizer
"你好世界" → 4 tokens: ["▁你好", "▁世界"] 或更多取决于词表

# GPT tokenizer  
"你好世界" → 4 tokens: [57668, 25001, 19526, 254]
```

核心差异：
- LLaMA 的 token 更"可读"——每个 token 通常对应一个语义单元
- GPT 的 token 由 BPE 在字节层面生成，可读性较差
- LLaMA 在中文和多语言上 token 效率通常更高

---

## 5. 词表大小（Vocabulary Size）的权衡

这是 tokenization 设计的核心决策之一，牵一发而动全身。

### 5.1 主流模型的词表大小

| 模型 | 词表大小 | tokenizer | 备注 |
|------|---------|-----------|------|
| GPT-2 | 50,257 | BPE (bbpe) | 因 BPE 合并 bug 实际使用 50,257 |
| LLaMA 1/2 | 32,000 | SentencePiece BPE | 相对偏小 |
| LLaMA 3 | 128,000 | SentencePiece BPE + byte fallback | 大幅扩展 |
| GPT-4 | ~100,000 | tiktoken (cl100k_base) | 优化多语言 |
| DeepSeek-V2 | 128,000 | BBPE | 中文优化 |
| Qwen 2.5 | 152,064 | BBPE | 超大词表 |
| Mistral | 32,000 | SentencePiece BPE | 同 LLaMA 级别 |

### 5.2 词表大小对模型的影响

#### A. Embedding 矩阵大小

这是**最直接的内存影响**。以 d_model = 4096 为例：

```
32K 词表: 32,000 × 4096 = 131M 参数 (~524 MB in fp32)
128K 词表: 128,000 × 4096 = 524M 参数 (~2.0 GB in fp32)
```

对于大型模型：
```
DeepSeek-V3 (d_model=7168, vocab=128K):
  128000 × 7168 = 917M 参数 → 约 3.5 GB

如果改用 32K 词表:
  32000 × 7168 = 229M 参数 → 约 878 MB
```

#### B. LM Head 输出矩阵

LM Head 也是 `vocab_size × d_model` 的矩阵（用于从 hidden state 投影到词表空间）：

```
每次生成一个 token，需要计算:
  output = hidden_state[1, d_model] × W_lm_head[d_model, vocab_size]
  → 得到一个 vocab_size 维的 logits 向量
  → 再做 softmax 取 argmax

计算量: d_model × vocab_size 次乘法 + softmax
```

vocab_size 越大，这步越贵。对于推理，**LM Head 的最后一次矩阵乘法占整体计算量的 5-15%**（取决于 seq_len 和 vocab_size）。

#### C. Token 效率

更大的词表 = 更少的 token 数：

```
文本: "The quick brown fox jumps over the lazy dog"

32K 词表: ~9 tokens (大概率所有词都在词表中)
50K 词表: ~9 tokens
128K 词表: ~9 tokens

但中文文本差异明显：
"人工智能正在深刻改变我们的生活方式"

32K 词表: ~14 tokens (字符+部分词)
128K 词表: ~8 tokens (更多复合词在词表中)
```

**规则**：词表加倍，token 数大约减少 10-20%（递减收益）。

#### D. 训练数据覆盖

- 小词表：高频的细粒度子词（~100 个 token），低频长尾词退化到字符 → **偏差低，方差高**
- 大词表：更多完整词在其中（~1000 个 token），低频词也可能有独立 token → **偏差高（可能不需要这么细），方差低**

#### E. 推理速度

```
同一段文本，token 数不同：

32K 词表: 1000 tokens → 1000 次 forward pass
128K 词表: 850 tokens  → 850 次 forward pass

节省约 15% 的 forward pass 次数

但对于长序列（如 128K 上下文），forward 耗时由 attention (O(n²)) 主导，
token 数减少的收益被 attention 成本稀释。
```

### 5.3 决策总结

```
小词表 (32K): 省显存、省 Embedding 层时间、多语言 token 效率差
大词表 (128K+): 费显存、单 token 效率高、训练收敛略慢（参数多）

现代趋势：偏向大词表 (100K+)
- 原因 1: Embedding 层可以用 int8/int4 量化，大幅缩小开销
- 原因 2: 多语言和代码的需求要求更大覆盖
- 原因 3: 推理时 KV cache 压力才是瓶颈，几个 GB 的 Embedding 不是主要矛盾
```

---

## 6. Embedding 层详解

### 6.1 Embedding 矩阵是什么

在代码层面，Embedding 层就是一个巨大的查找表（lookup table）：

```python
# PyTorch 实现
embedding = nn.Embedding(num_embeddings=vocab_size, embedding_dim=d_model)
#                           ↑ 词表有 vocab_size 行       ↑ 每行 d_model 维

# 实际上是一个矩阵: [vocab_size, d_model]
```

**核心操作**：给定一个 token ID，直接取出矩阵的对应行。

```
token_id = 1234
vector = embedding.weight[1234]  # shape: [d_model]
# GPU 上这是一个 gather 操作，极快
```

### 6.2 完整流程

```text
输入文本: "Hello world"
    ↓
Tokenizer → [15496, 995]    # token IDs
    ↓
Embedding lookup:
  15496 → W[15496, :]  → vec₁ [4096]
  995   → W[995, :]    → vec₂ [4096]
    ↓
结果: [[vec₁], [vec₂]]   # shape: [2, 4096]
    ↓
送入 Transformer 层
```

### 6.3 Weight Tying（权重绑定）

这是一个关键的内存优化技术。

**没有 Weight Tying**：
```text
Embedding:  W_emb  [vocab_size, d_model]  →  vocab × d 参数
LM Head:    W_lm   [d_model, vocab_size]  →  vocab × d 参数

总计: 2 × vocab × d 参数
```

**有 Weight Tying**（共享权重）：
```text
Embedding + LM Head = 同一块矩阵 W [vocab_size, d_model]

前向: x_emb = W[token_id, :]
反向: logits = hidden @ W.T

总计: vocab × d 参数（节省一半！）
```

```python
# Weight Tying 在代码中的实现
self.embed_tokens = nn.Embedding(vocab_size, d_model)
self.lm_head = nn.Linear(d_model, vocab_size, bias=False)

# Tie weights
self.lm_head.weight = self.embed_tokens.weight  # 共享同一个 tensor
```

**实际效果**（LLaMA-7B, vocab=32K, d=4096）：
```
无 Tying: 32K × 4096 × 2 = 262M 参数 → ~1 GB
有 Tying: 32K × 4096     = 131M 参数 → ~524 MB
节省: 131M 参数, ~500 MB 显存
```

对于 128K 词表（如 GPT-4 级别, d=4096）：
```
无 Tying: 128K × 4096 × 2 = 1,048M 参数 → ~4 GB
有 Tying: 128K × 4096     = 524M 参数   → ~2 GB
节省: 524M 参数, ~2 GB 显存 ← 非常显著
```

### 6.4 是否所有模型都用 Weight Tying？

| 模型 | 是否使用 Weight Tying | 原因 |
|------|----------------------|------|
| GPT-2 | ✅ 是 | 最早推广这种做法的模型之一 |
| LLaMA 系列 | ✅ 是 | 标准配置 |
| PaLM | ❌ 否 | 使用独立 Embedding 和 LM Head |
| BERT | ✅ 是 | MLM head 与 embedding 共享 |

不使用的理由：独立权重给 LM Head 更大的灵活性来学习输出分布，代价是更大的参数量和显存。

### 6.5 Embedding 层的梯度特点

Embedding 层是**极度稀疏**的更新：

```
一个 batch 有 2048 个 token
词表有 128,000 个 token

只有 2048 / 128000 ≈ 1.6% 的 embedding 向量需要更新
```

这导致：
- 优化器状态（如 Adam 的 m, v）大部分为零，浪费显存
- 可以针对性使用 sparse optimizer 或 sparse embedding table（如推荐系统中常用的）

---

## 7. GPU 运算中的实践启示

### 7.1 Embedding 层的"隐藏"开销

很多人以为大模型的参数都在 Transformer 层里，但实际上 **Embedding 层的参数量可能占到总参数的 10-30%**：

```
LLaMA-7B, vocab=32K, d=4096:
  Embedding: 131M
  LM Head:   131M (tied, 共享)
  Transformer 层: ~6.5B
  Embedding 占比: 131M / 6.7B ≈ 2%  ← 还好

LLaMA-70B, vocab=32K, d=8192:
  Embedding: 262M
  LM Head:   262M (tied)
  Transformer 层: ~69B
  Embedding 占比: 262M / 69.5B ≈ 0.4%  ← 几乎可以忽略

但对于小模型 + 大词表:
  Mini-Model, vocab=152K (Qwen), d=2048:
  Embedding: 311M
  LM Head:   311M (tied)
  Transformer 层: ~2B
  Embedding 占比: 311M / 2.3B ≈ 13.5%  ← 非常高！
```

### 7.2 Tokenization 速度 = 数据管线瓶颈

在实际训练中，tokenization 可能成为瓶颈：

```
一页 GPU（8×A100）的处理能力: ~4M tokens/second
单 CPU 的 tokenization 速度: ~1-3M tokens/second（取决于 tokenizer 和文本复杂度）

如果 CPU tokenizer 跟不上 GPU，GPU 就会空闲等待。
```

**常见优化**：
- 预处理：离线 tokenize 整个数据集，存储为 `.npy` 或二进制文件
- 多进程：`num_workers ≥ 8` 用于并行 tokenization
- Rust/Python 选择：`tiktoken`（Rust 后端）显著快于纯 Python 实现

### 7.3 不同 Tokenizer → 不同 Token 数 → 不同 KV Cache

这是使用不同模型时容易忽略的问题：

```
假设 KV cache 大小 = 4 × num_layers × num_kv_heads × head_dim × seq_len × dtype_bytes

同一个对话历史，使用 LLaMA tokenizer: 50,000 tokens
使用 GPT-4 tokenizer: 42,000 tokens

如果目标 KV cache size 是固定的（如 128K positions），
那么 LLaMA tokenizer 更快填满，有效信息量反而更少。

"看起来"KV cache 大小相同，"实际上"容纳的信息量不同。
```

### 7.4 LM Head 计算量详解

每生成一个 token，必须走过完整的 LM Head：

```
logits = hidden @ W_lm_head.T
# hidden: [batch_size, 1, d_model]  → 推理时 batch=1, 序列维度=1
# W_lm_head.T: [d_model, vocab_size]

FLOPs: 1 × d_model × vocab_size × 2（乘法+加法）

例子 (d=8192, vocab=128K):
  FLOPs = 8192 × 128000 × 2 ≈ 2.1 GFLOPs per token

对比一个 Transformer 层的 FLOPs (以 LLaMA-70B 为例):
  单层: ~1.4 TFLOPs (包含 attention + FFN)

所以 LM Head 的 2.1 GFLOPs 相对不大——但它发生在**每次生成**的最末尾。
对于短序列（如 prompt=50 tokens, generate=10 tokens），LM Head 开销相对更长。
对于长序列（如 prompt=100K tokens, generate=2000 tokens），LM Head 几乎可忽略。
```

### 7.5 减少 Embedding 开销的实用技巧

1. **int8 量化 Embedding**：将 `vocab × d` 矩阵量化为 int8，节省 50-75% 显存，对精度影响很小
2. **Tensor Parallelism（张量并行）**：将 Embedding 矩阵沿 vocab 维度切分到多张 GPU
3. **Pipeline Parallelism（流水线并行）**：Embedding 层在第一张 GPU 上，不参与中间层的模型并行
4. **weight tying**：如上所述，共享 Embedding 和 LM Head 权重

---

## 8. Special Tokens 专题

### 8.1 核心 Special Tokens

| Token | 全称 | 用途 | 常见 ID |
|-------|------|------|---------|
| `<bos>` | Beginning of Sequence | 标记序列开始 | 1 (LLaMA), 50256 (GPT-2) |
| `<eos>` | End of Sequence | 标记序列结束，**训练时作为停止信号** | 2 (LLaMA), 50256 (GPT-2 中与 bos 相同) |
| `<pad>` | Padding | 填充到相同长度（batch 内） | 0 或特殊 ID |
| `<unk>` | Unknown | 未知 token（BBPE 中不需要） | 0 |
| `<s>` / `</s>` | SentencePiece 的开始/结束 | 等价于 bos/eos | 1 / 2 |

### 8.2 Chat Template Tokens

现代对话模型引入了大量**特殊格式 token** 来区分角色和结构：

```text
LLaMA 3 的 chat template:
<|begin_of_text|>                      # 文档开始
<|start_header_id|>system<|end_header_id|>
You are a helpful assistant.
<|eot_id|>                             # end of turn
<|start_header_id|>user<|end_header_id|>
What is the capital of France?
<|eot_id|>
<|start_header_id|>assistant<|end_header_id|>
The capital of France is Paris.
<|eot_id|>
```

这些 token 在训练时被加入词表，并有独立的 embedding 向量。

### 8.3 EOS 的特殊重要性

**EOS 是 LLM 知道"何时停止"的唯一信号**。训练时：

```python
# 简化版训练逻辑
for token in sequence:
    loss += cross_entropy(model(token), target_next_token)
    if token == eos_token:
        # 后续 token 不参与 loss 计算（被 masked out）
        break
```

如果 EOS 没有被正确学习：
- 模型会**一直生成下去**，直到达到 max_new_tokens
- 或者在不应停止的地方提前停止

实际训练中，通常用 attention mask 处理 padding 和 EOS 之后的部分，而非实际 break。

### 8.4 PAD Token 的注意点

在 batch 训练中，不同长度的序列需要 padding：

```text
Batch with padding:
[
  [bos, tok1, tok2, tok3, eos]          → 5 tokens
  [bos, tok1, eos, pad, pad]            → 5 tokens (padded)
  [bos, tok1, tok2, tok3, tok4, eos]    → 6 tokens → padded to 6
]
```

关键约束：
- **PAD token 不参与 loss 计算**（通过 attention mask 排除）
- **PAD token 不参与 attention**（attention mask 设为 -inf）
- PAD embedding 理论上不会被学习到有意义的信息——但有些实现用特殊的初始化

### 8.5 用户不可见的 Special Tokens

部分 tokenizer 会静默插入特殊 token：

```python
# LLaMA tokenizer 自动行为
tokenizer.encode("Hello")  
# → [1, 15043]  # 自动加了 BOS token!

tokenizer.encode("Hello", add_special_tokens=False)
# → [15043]     # 不加
```

这在使用 API 时是个常见的坑——手动拼接 token 时容易漏掉或重复这些自动插入的特殊 token。

---

## 附录：快速参考

### 各模型 Tokenizer 对应关系

| 模型 | tokenizer 实现 | Python 库 | 加载方式 |
|------|---------------|-----------|---------|
| GPT-2/3/4 | tiktoken | `tiktoken` | `tiktoken.get_encoding("cl100k_base")` |
| LLaMA 1/2/3 | SentencePiece | `sentencepiece` | `AutoTokenizer.from_pretrained()` |
| Mistral | SentencePiece | `sentencepiece` | `AutoTokenizer.from_pretrained()` |
| Qwen | BBPE (类 GPT) | `tiktoken` 或自定义 | `AutoTokenizer.from_pretrained()` |
| BERT | WordPiece | `tokenizers` | `AutoTokenizer.from_pretrained()` |

### 常用操作速查

```python
from transformers import AutoTokenizer

tokenizer = AutoTokenizer.from_pretrained("meta-llama/Meta-Llama-3-8B")

# Encode
ids = tokenizer.encode("Hello world")
# → [128000, 15339, 1917]  (LLaMA 3: bos + 2 tokens)

# Decode
text = tokenizer.decode([15339, 1917])
# → "Hello world"

# 查看 token 数
count = len(tokenizer.encode(text))

# 查看词表大小
vocab_size = tokenizer.vocab_size

# Chat template
messages = [
    {"role": "system", "content": "You are helpful."},
    {"role": "user", "content": "Hi!"}
]
formatted = tokenizer.apply_chat_template(messages, tokenize=False)
```

---

## 相关笔记

- [[Transformer 架构基础]] — Tokenization 之后的处理流程
- [[显存计算详解]] — Embedding 层和 LM Head 的显存计算
- [[LLM 训练与推理流程]] — Tokenization 在整个 pipeline 中的位置
- [[混合精度训练]] — Embedding 层的 fp16/bf16 训练细节
- [[大模型架构对比]] — 各模型 tokenizer 横向对比

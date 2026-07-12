---
date: 2026-06-30
tags:
  - llm
  - training
  - transformer
  - memory
type: 学习笔记
category: 大模型训练
source: 个人整理
difficulty: 进阶
title: "LLM 训练知识总览"
---

# LLM 训练知识总览

> 大模型训练的核心知识点：显存怎么算、Transformer 怎么工作、混合精度怎么省资源、主流模型架构有什么区别。

## 知识结构

```
07-Knowledge/llm-training/
├── LLM 训练知识总览.md              ← 你在这里
├── 显存计算详解.md                   # 训练的显存到底用在哪
├── Tokenization 与 Embedding 详解.md # ★ Token 怎么来的、词表怎么选
├── Transformer 架构基础.md           # Attention/Norm/FFN/RoPE 底层原理
├── 混合精度训练.md                   # FP16/BF16/FP8 原理和坑
├── 大模型架构对比.md                 # GPT vs LLaMA vs MoE 架构差异
├── LLM 训练与推理流程.md             # ★ 预训练→SFT→RLHF→推理部署全流程
├── 2025-2026 前沿模型技术解析.md     # 七大实验室最新模型全貌
└── 2025-2026 好用新技术全景.md       # 这两年 20+ 项核心技术拆解
```

## 和 GPU 集群运维知识库的关系

```
GPU 集群运维知识库 (gpu-cluster-ops)     LLM 训练知识库 (llm-training)
─────────────────────────────────────     ─────────────────────────────
关注「怎么跑」                               关注「跑的什么东西」
  - GPU 硬件怎么工作                           - 模型参数怎么算
  - 集群怎么调度 GPU                           - 训练时显存怎么分配
  - 网络怎么优化 NCCL                          - Attention 怎么计算
  - 监控怎么搭 DCGM                            - FP16/BF16 为什么能用
  - 驱动怎么管理                               - GPT 和 LLaMA 架构区别

两者互补：知道模型的显存需求 → 才能算出来要多少 GPU → 才能设计集群
```

## 学习路线

### 阶段 1：显存怎么算（先看这个）
- [[显存计算详解]] — 训练显存的四笔账：参数、梯度、优化器、激活值
- 搞清楚为什么训练比推理吃显存 8 倍多

### 阶段 2：模型怎么算
- [[Transformer 架构基础]] — Self-Attention/Multi-Head/FFN/Norm/残差/RoPE/Decoder-Only
- [[Tokenization 与 Embedding 详解]] — BPE/SentencePiece/词表大小/Embedding 矩阵
- 理解显存里存的东西到底是什么

### 阶段 3：训练怎么省资源
- [[混合精度训练]] — FP16 前向、FP32 累加、loss scaling
- 为什么 BF16 比 FP16 更好用

### 阶段 4：训练和推理全流程
- [[LLM 训练与推理流程]] — 预训练→SFT→RLHF→采样策略→Batch Inference
- 从裸模型到产品部署的完整链路

### 阶段 4：架构怎么选
- [[大模型架构对比]] — GPT decoder-only、LLaMA 改进、MoE 混合专家
- 不同架构对 GPU 集群的显存/通信需求差异

### 阶段 5：前沿模型怎么做的
- [[2025-2026 前沿模型技术解析]] — DeepSeek-V4/K2.7/Fable 5/GLM-5.2/GPT-5.6
- 七大实验室的最新技术路线和 2026 H1 密集发布潮

### 阶段 6：这些技术怎么实现的
- [[2025-2026 好用新技术全景]] — MLA/CSA+HCA/GRPO/Muon/FP4/OPD 逐个拆解
- 怎么选、什么时候用、谁已经验证过

## 学习时间

| 阶段 | 预计时间 | 备注 |
|------|----------|------|
| 框架创建 | 2026-06-30 | 初始搭建 |

## 状态标记

🌱 学习中 | 📖 已掌握 | 🔁 需复习 | 📝 待补充

---
date: 2026-04-09
tags: [学习, 知识, Multi-Agent, 多模态, 视觉模型, vCoT, Base64, CrewAI]
type: 学习笔记
category: 体系课
source: https://b.geekbang.org/member/course/detail/948519
difficulty: 进阶
parent: "[[企业级多智能体设计实战]]"
title: "10-多模态模型-让你的Agent拥有眼睛"
---

# 10｜多模态模型：让你的 Agent 拥有"眼睛"

> 企业级多智能体设计实战 · 模块一第4讲 | 时长 30:28 | 讲师：晓寒

## 概述

本讲聚焦**多模态文本生成模型**（Image-to-Text），而非文生图。核心公式为**视觉任务 = 图片 + Prompt**。通过自定义 `AddImageToolLocal` 工具，让 Agent 具备读取本地图片、Base64 编码、注入上下文的能力，并结合 vCoT（视觉思维链）和漏斗过滤架构实现企业级落地的正确姿势。

## 核心概念

### 多模态文本生成 vs 文生图

| 方向 | 代表工具 | 输入 → 输出 |
|------|----------|-------------|
| 文生图（Text-to-Image） | Midjourney, Stable Diffusion | 文字 → 图片 |
| **图生文（Image-to-Text）** | **本讲重点** | **图片 → 结构化文字/数据** |

### 底层原理：模型如何"看懂"图片

```
图片 → 视觉编码器 → 视觉 Token 序列 → 与文本 Prompt 拼接 → 大模型联合推理 → 文字输出
```

图片的像素特征被视觉编码器切分并映射到大模型能理解的语义空间，与文本 Prompt 一起拼接成超长上下文。

### 核心公式：视觉任务 = 图片 + Prompt

- **图片**：提供具象的信息描述
- **Prompt**：提供任务的分析逻辑（重点看什么、提取什么特征、按什么格式输出）
- 常见误区：直接扔图片不给 Prompt，模型无法返回想要的结果

### AddImageToolLocal 的作用

原生 CrewAI 只支持网络 URL 的多模态请求。自定义工具的核心功能：

1. 读取本地 JPG/PNG 文件
2. 压缩图片至合适分辨率（控制 Token 消耗）
3. 转换为 Base64 Data URL 格式
4. 注入到 Agent 的上下文中

### vCoT（Visual Chain of Thought）

类似文本模型的 CoT，图片分析也需强制分步思考：

| 步骤 | 动作 | 说明 |
|------|------|------|
| 1 | **Describe**（描述） | 陈述图片中客观看到的物体、颜色 |
| 2 | **Reason**（推理） | 基于事实，结合业务背景进行推导 |
| 3 | **Conclude**（结论） | 给出最终分析结论或输出 JSON |

### 漏斗过滤架构（低成本批量处理）

```
海量图片 → [第一层] 低分辨率粗筛（廉价快速） → 命中图片 → [第二层] 高分辨率精筛（深度提取） → 结果
```

## 关键要点

1. **图片必须压缩**：大模型不需要 4K/8K 极限高清，限制长边在 1024-2048 像素即可
2. **Pydantic 强制结构化输出**：`output_pydantic=ImageAnalysis` 确保视觉分析结果可被下游消费
3. **multimodal=True 是关键配置**：开启框架的多模态支持，Agent 才能处理图片输入
4. **不要用大模型纯做 OCR**：除非文档有强语义的排版格式（复杂表格、架构图），此时多模态模型有降维打击优势

## 实践示例

### 多模态 Agent + 结构化输出的完整代码

```python
from crewai import Agent, Task, Crew
from pydantic import BaseModel, Field
from tools.add_image_tool_local import AddImageToolLocal

# 1. 定义结构化输出模型
class ImageAnalysis(BaseModel):
    file_name: str = Field(..., description="图片文件名")
    subject_description: str = Field(..., description="图片中主要物品、人物或场景的客观描述")
    atmosphere_vibe: str = Field(..., description="图片传递的整体氛围感和情绪价值")
    visual_details: list[str] = Field(..., description="至少 3 个关键的视觉细节亮点")

# 2. 定义多模态 Agent
visual_analyst = Agent(
    role="资深视觉分析师",
    goal="准确解析图片内容，提取核心视觉卖点和氛围感",
    backstory="你是一位拥有多年经验的产品视觉分析师...",
    llm=aliyun_vl_llm,         # 绑定支持多模态的 LLM
    multimodal=True,            # 💡 开启多模态支持
    tools=[AddImageToolLocal()], # 💡 赋予读取本地图片的工具
)

# 3. 定义任务
analysis_task = Task(
    description="请使用工具加载本地图片 {image_path}，对图片进行整体与细节的多维度观察...",
    expected_output="结构化的视觉分析结果",
    agent=visual_analyst,
    output_pydantic=ImageAnalysis,  # 强制结构化输出
)
```

## 常见问题 / 坑点

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| Token 账单飙升、请求超时 | 像素倾倒——直接扔 4K/8K 原图给模型 | 代码层压缩图片，长边限制在 1024-2048 像素 |
| 纯文字提取准确率低 | 用大模型做 OCR——不经济且不如专业 OCR 引擎 | 纯文字场景用传统 OCR；复杂排版/表格/架构图才用多模态 |
| 视觉幻觉（分析不准确） | 没有引导模型分步思考 | 使用 vCoT：Describe → Reason → Conclude |
| 批量图片处理太慢太贵 | 逐张高分辨率处理 | 漏斗架构：低清粗筛 → 高清精筛 |
| 原生 CrewAI 不支持本地图片 | 框架只支持网络 URL | 自定义 AddImageToolLocal 工具 |

## 最佳实践

1. **Prompt 引导视觉分析方向**：告诉模型重点看什么、提取什么特征
2. **图片预处理是必修课**：压缩 + 分辨率限制，平衡精度与成本
3. **vCoT 降低视觉幻觉**：强制三步走（描述 → 推理 → 结论）
4. **结构化输出贯穿始终**：Pydantic 定义输出结构，便于下游任务消费

## 关联知识

- [[09-定义Process-任务调度与信息传递]]（上一讲流程编排）
- [[11-项目实践一-小红书爆款笔记生成项目]]（综合实战）
- [[07-定义Agent-从提示词工程到人设工程]]（Agent RGB 模型）

## 参考资源

- 课程链接：https://b.geekbang.org/member/course/detail/948519
- 示例代码：https://github.com/kid0317/crewai_mas_demo/blob/main/m2l6/m2l6_agent.py

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 初次学习 | 2026-04-09 | 视频观看 + 笔记整理 |
| 深入理解 | | |
| 实战应用 | | |
| 复习回顾 | | |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-04-16

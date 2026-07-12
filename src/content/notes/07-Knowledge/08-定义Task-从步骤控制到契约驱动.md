---
date: 2026-04-09
tags: [学习, 知识, Multi-Agent, Task设计, 契约驱动, Pydantic, CrewAI]
type: 学习笔记
category: 体系课
source: https://b.geekbang.org/member/course/detail/948519
difficulty: 进阶
parent: "[[企业级多智能体设计实战]]"
title: "08-定义Task-从步骤控制到契约驱动"
---

# 08｜定义Task——从"步骤控制"到"契约驱动"

> 企业级多智能体设计实战 · 模块一第2讲 | 时长 33:54 | 讲师：晓寒

## 概述

一切 AI 应用本质上都是在执行任务（Input → 执行 → Output）。本讲提出**"任务定义终点，而非路径"**的核心心法，引入**契约驱动**的任务设计模式，使用 Pydantic 定义结构化交付标准来掌控大模型输出的确定性。

## 核心概念

### 认知原点——一切 AI 应用皆为"Task"

```
Input（用户诉求） → 执行过程（思考、调用工具、协作） → Output（交付物）
```

未来 AI 应用评测的核心依据：对比"输入"和"产出"是否匹配预期标准。

### 火车轨道 vs 里程碑（核心心法）

| 模式 | 思维 | 风险 |
|------|------|------|
| 🚂 火车轨道（传统工作流） | 规定第一步做什么、第二步怎么做 | 中途意外 → 彻底脱轨崩溃 |
| 🏁 里程碑（契约驱动） | 定义阶段交付成果，中间自主决策 | 灵活适应不确定性 |

**核心原则：任务定义终点，而非路径。**

### Pydantic 结构化交付标准

使用 Pydantic 定义任务的目标输出结构，底层作用机制：

1. **提示词注入**：框架将 Pydantic 定义转换为 JSON Schema，硬编码注入 System Prompt
2. **结果提取与验证**：模型倾向于按 JSON 结构输出 → 框架 JSON 提取器抓取 → Pydantic 反向校验
3. **确定性转化**：将不确定的自然语言文本转化为确定性的工程数据字典

## 关键要点

1. **Goal 是罗盘，Task 是终点**：Goal 描述决策偏好，Task 描述具体交付物
2. **结构化交付标准 = 掌控确定性的最强武器**：Pydantic 不仅定义数据类型，更要在字段描述中写清质量标准
3. **底层仍是 Prompt**：框架将 Pydantic schema 拼入 prompt，如 `Ensure your final answer strictly adheres to the following OpenAPI schema: {schema}`
4. **契约驱动体现**：下游任务依赖上游任务的输出格式，`Crew.kickoff(inputs={...})` 将变量替换到 prompt 中

## 实践示例

### CrewAI Task 定义的标准代码

```python
from pydantic import BaseModel, Field
from crewai import Task

class ContentStrategyBrief(BaseModel):
    target_audience: str = Field(..., description="目标人群画像，需包含核心痛点")
    core_angle: str = Field(..., description="内容切入角度，需独特且具争议性/共鸣性")
    hook_design: str = Field(..., description="互动钩子设计，包含争议问题和价值锚点")
    keyword_plan: list[str] = Field(..., description="3个核心长尾关键词")
    emotional_tone: str = Field(..., description="整体情绪基调")

task_content_strategy = Task(
    description="""
    基于用户的原始意图和视觉分析报告，制定小红书内容策略。
    
    用户的原始想法：
    {user_raw_intent}
    
    视觉分析报告：
    {visual_report}
    
    ** 重要提示 **：
    - 必须基于上游任务的视觉分析报告进行分析
    - 策略要符合小红书平台的算法特点
    - 所有输出必须使用中文
    """,
    expected_output="一个完整的 ContentStrategyBrief 结构化输出，包含所有必填字段。",
    agent=content_strategist,
    output_pydantic=ContentStrategyBrief,  # 💡 强约束结构化输出
)
```

## 常见问题 / 坑点

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| Agent 逻辑混乱、什么都做不好 | 注意力涣散的超级任务——多个不相关子目标塞进同一任务 | 每个任务聚焦单一里程碑，一个任务只做一件事 |
| Agent 陷入死循环，不知何时输出 Final Answer | 未设定明确的验收标准（expected_output） | 必须提供清晰的 expected_output 和 output_pydantic |
| Agent 幻觉严重、生搬硬套 | 流程步骤过度微操——规定过细的操作步骤 | 只定义交付标准（里程碑），不规定执行路径 |
| 产出深度不够 | Pydantic 只定义了数据类型，没有质量标准 | 在 Field 的 description 中写清明确的质量判断标准 |

## 最佳实践

1. **Pydantic 中同时明确结构和判断标准**：`Field(..., description="需包含...")` 而非仅 `Field(..., description="标题")`
2. **一个 Task 只做一件事**：搜索归搜索，写代码归写代码，文案归文案
3. **用 expected_output 聚焦注意力**：明确的交付要求能强行聚焦大模型注意力
4. **下游任务显式引用上游输出**：在 description 中用 `{variable}` 引用上游 TaskOutput

## 关联知识

- [[07-定义Agent-从提示词工程到人设工程]]（上一定义 Agent）
- [[09-定义Process-任务调度与信息传递]]（下一讲流程编排）
- [[11-项目实践一-小红书爆款笔记生成项目]]（综合实战）

## 参考资源

- 课程链接：https://b.geekbang.org/member/course/detail/948519
- 示例代码：https://github.com/kid0317/crewai_mas_demo/blob/main/m2l4/m2l4_task.py

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 初次学习 | 2026-04-09 | 视频观看 + 笔记整理 |
| 深入理解 | | |
| 实战应用 | | |
| 复习回顾 | | |

---

**状态**: 📖 已掌握
**下次复习日期**: 2026-04-16

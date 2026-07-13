---
date: 2026-04-09
tags: [学习, 知识, Multi-Agent, Process, 任务调度, Context, DAG, CrewAI]
type: 学习笔记
category: 体系课
source: https://b.geekbang.org/member/course/detail/948519
difficulty: 进阶
parent: "[[企业级多智能体设计实战]]"
title: "09-定义Process-任务调度与信息传递"
---

# 09｜定义 Process——任务调度与信息传递

> 企业级多智能体设计实战 · 模块一第3讲 | 时长 32:50 | 讲师：晓寒

## 概述

Process（流程）的本质是**任务的调度方式（Task Scheduling）**。本讲深度解析顺序执行（Sequential）模式，剖析 TaskOutput 与 Context 的数据传递机制，并揭示了 `crew.kickoff()` 背后的底层运行逻辑——本质上是一个由 Task List 和 TaskOutput List 双向互动的 for 循环。

## 核心概念

### Process 的本质

Process 决定的是：一组 Task 启动后，以什么节奏执行？

```
Agent（数字员工） + Task（里程碑目标） + Process（调度策略） = Multi-Agent 系统
```

### 顺序执行（Sequential Process）

最基础、最稳定、最实用的调度模式：
- 开发者预先为每个 Task 分配好 Agent
- `kickoff()` 后严格按任务列表顺序逐一执行
- 轮到某个任务时，唤醒绑定的 Agent 进行思考、工具调用和结果输出

### 数据传递的两大核心概念

#### TaskOutput（任务输出 / 交接棒）

每个 Task 执行完毕后封装的标准化数据对象，包含：

| 字段 | 说明 |
|------|------|
| `description` | 当前任务的描述信息（回答什么问题） |
| `raw` | 大模型返回的最原始字符串 |
| `pydantic` | 经框架提取和反向校验后的强类型数据字典 |

#### Context（上下文 / 信息依赖）

| 传递方式 | 行为 | 风险 |
|----------|------|------|
| **隐式传递**（不设 context） | 框架将前面所有 TaskOutput 拼接为背景信息 | ❌ 上下文超载、注意力分散 |
| **显式传递**（`context=[task_a]`） | 精准声明依赖，只传递指定任务的输出 | ✅ 推荐：精准、节省 Token |

### kickoff() 底层五大执行步骤

```
1. 遍历 Task List（Task 1, 2, ... n）
2. 分配 Agent（确认当前 Task 绑定的数字员工）
3. 填入 Context（从 TaskOutput List 提取依赖，拼接成 Prompt）
4. Agent 执行（触发 ReAct 循环，思考与行动）
5. 解析 TaskOutput（存入 TaskOutput List，供后续循环调用）
→ 不断循环，直到最后一个任务完成
```

## 关键要点

1. **Process 本质就是调度算法**：将 AI 框架概念还原为传统软件工程的经典问题
2. **显式 Context 构建有向无环图（DAG）**：通过 `context=[task_a, task_b]` 构建清晰的数据依赖
3. **"做减法"是最核心原则**：多余且无关的上下文不仅浪费 Token，更会严重分散注意力
4. **理解底层才能脱离框架**：kickoff() 本质是两个列表的双向 for 循环，完全可以手搓

## 实践示例

### Sequential + 显式 Context 的工程实现

```python
from crewai import Crew, Process, Task

# 1. 初始任务：内容策划（无上游依赖）
task_content_strategy = Task(
    description="基于视觉报告，制定整体的小红书内容策略...",
    expected_output="结构化的内容策略简报",
    agent=content_strategist,
)

# 2. 下游任务：文案撰写（显式依赖内容策划）
task_copywriting = Task(
    description="基于内容策略，撰写小红书笔记文案...",
    expected_output="包含标题和正文的文案",
    agent=content_writer,
    context=[task_content_strategy],  # 💡 显式声明信息依赖
)

# 3. 末端任务：SEO 优化（多依赖）
task_seo_optimization = Task(
    description="对现有文案进行长尾关键词和 SEO 优化...",
    expected_output="优化后的最终笔记",
    agent=seo_optimizer,
    context=[task_content_strategy, task_copywriting],  # 💡 多依赖声明
)

# 4. 组装 Crew
crew = Crew(
    agents=[content_strategist, content_writer, seo_optimizer],
    tasks=[task_content_strategy, task_copywriting, task_seo_optimization],
    process=Process.sequential,  # 顺序执行
    verbose=True,
)
result = crew.kickoff(inputs={"visual_report": "{...}"})
```

## 常见问题 / 坑点

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 产出质量大幅下滑 | 上下文超载（Context Overload）——隐式传递所有上游输出 | 始终显式指定 `context=[...]`，精准控制依赖 |
| Token 成本飙升 | 不设 context，冗杂信息占用上下文窗口 | 做减法，只传递下游真正需要的数据 |
| 系统整体耗时过长 | 任务拆分过细——把微操作拆成独立 Task | 平衡粒度，找到里程碑的合适粗细 |
| 任务失败导致全链路崩溃 | Sequential 流水线的"单点故障" | 设计容错逻辑：Fail-Fast 或有边界重试机制 |
| Agent 陷入死循环 | 任务拆分过粗，Agent 难以处理 | 将大任务拆为可独立验收的小里程碑 |

## 最佳实践

1. **始终显式指定 Context**：`context=[task_a, task_b]` 强制规范，倒逼理清数据流转
2. **平衡任务粒度**：不过粗（死循环）不过细（Token 成本飙升）
3. **构建健壮的错误处理**：API 宕机、模型超时时选择 Fail-Fast 或有边界重试
4. **理解底层后可脱离框架**：两个列表 + for 循环即可实现基础调度引擎

## 关联知识

- [[08-定义Task-从步骤控制到契约驱动]]（上一讲 Task 设计）
- [[10-多模态模型-让你的Agent拥有眼睛]]（下一讲多模态能力）
- [[11-项目实践一-小红书爆款笔记生成项目]]（综合实战）

## 参考资源

- 课程链接：https://b.geekbang.org/member/course/detail/948519
- 示例代码：https://github.com/kid0317/crewai_mas_demo/blob/main/m2l5/m2l5_crew.py

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

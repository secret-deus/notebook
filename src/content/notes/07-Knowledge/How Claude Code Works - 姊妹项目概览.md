---
tags:
  - coding-agent
  - ai
  - architecture
  - claude-code
  - llm
date: 2026-07-01
source: https://github.com/Windy3f3f3f3f/how-claude-code-works
docs: https://windy3f3f3f3f.github.io/how-claude-code-works/
title: "How Claude Code Works - 姊妹项目概览"
---

# How Claude Code Works - 姊妹项目概览

> 15 篇专题，33 万字，**从源码级别深度解析 Claude Code 的 50 万行 TypeScript 源码架构**。姊妹项目 [[Claude Code 从零构建 - 完整架构解析]] 是 ~4300 行的动手教程。

---

## 项目规模

| 指标 | 数值 |
|------|------|
| 源码总行数 | 512,000+ |
| TypeScript 文件 | 1,884 |
| 内置工具 | 66+ |
| 压缩流水线级数 | 4 级 |
| 权限防御层数 | 5 层 |

---

## 系统架构全景

```
用户输入 → QueryEngine(会话管理) → query(主循环) → Claude API
                                                ↓
                                           解析响应
                                         ↙        ↘
                                    文本输出     工具执行引擎
                                  (流式输出)   ↙  ↓  ↘  ↓  ↘
                                          读文件 编辑 Shell 搜索 MCP
                                              ↓
                                          结果回注 → query
```

---

## 15 篇专题

| # | 专题 | 核心内容 |
|---|------|----------|
| 01 | 概述 | 技术选型（Bun/React/Zod）、6 条核心设计原则、9 阶段 235ms 启动 |
| 02 | 系统主循环 | 双层架构、7 种 Continue Sites 故障恢复、StreamingToolExecutor |
| 03 | 上下文工程 | 4 级压缩流水线、压缩后 5 文件恢复+技能重激活、缓存断裂检测 |
| 04 | 工具系统 | 66 工具注册与并发、MCP 7 种传输、OAuth 2.0+PKCE |
| 05 | 代码编辑策略 | search-and-replace 抗幻觉设计、14 步验证、编辑前强制读取 |
| 06 | Hooks 与可扩展性 | 23+ Hook 事件、5 种 Hook 类型、6 阶段执行管道 |
| 07 | 多 Agent 架构 | 子 Agent 4 种执行模式、Worktree 隔离、Coordinator+Swarm |
| 08 | 记忆系统 | 4 种记忆类型、Sonnet 语义召回、后台记忆提取 Agent、记忆漂移防御 |
| 09 | 技能系统 | 6 层来源与优先级、懒加载与 Token 预算分配、Inline/Fork 双模式 |
| 10 | Plan 模式 | 两条进入路径、5 阶段工作流、附件节流、Phase 4 四种实验变体 |
| 11 | 权限与安全 | 5 层纵深防御、tree-sitter AST 23 项检查、竞速确认+200ms 防误触 |
| 12 | 用户体验设计 | 自研 Ink 渲染器、Yoga Flexbox 布局、虚拟滚动、Vim 模式 |
| 13 | 最小必要组件 | 7 个最小组件框架、最小 vs 生产逐项对照、500行→50万行演进路线 |
| 14 | 系统提示词设计 | 7 层递进式架构、反模式接种、爆炸半径框架、7 条 Agent 提示词原则 |
| 15 | 任务管理系统 | 文件级存储+并发锁、三层变更检测、依赖追踪、多 Agent 协调 |

---

## 关键发现

### 为什么 Claude Code 感觉快？

1. **全链路流式输出** — 每生成一个 token 立刻展示
2. **工具预执行** — 模型说"我要读某个文件"时，文件其实已经在读了。利用 5-30 秒流式窗口藏起约 1 秒工具延迟
3. **9 阶段并行启动** — 不相关初始化并行执行，关键路径压到 ~235ms

### 出错了怎么办？— 静默恢复

能恢复的错误用户根本看不到。对话超长→悄悄压缩+自动重试。token 达上限→自动 4K→64K 再重试。7 种不同的"继续"策略对应 7 种故障恢复路径。

### 对话太长？— 4 级渐进式压缩

不是一刀切，分 4 级逐步处理：裁剪→去重→折叠→摘要。每级都可能释放足够空间。压缩后自动恢复最近编辑的 5 个文件内容。

### 安全防护 — 5 层纵深防御

1. 权限模式 → 2. 规则匹配 → 3. **Bash AST 分析（23 项检查）** → 4. 用户确认（200ms 防抖） → 5. Hook 校验。任何一层拦住就不执行。

### 66 工具协同

所有工具遵循同一套接口规范。第三方 MCP 工具和内置工具走完全相同的执行流水线。只读自动并行，写操作自动串行。输出 >100K 自动落盘。

### 多 Agent 协作

三种模式：**子 Agent**（fork-return）、**协调器**（纯编排，不能自己读文件写代码）、**Swarm**（点对点通信）。Git Worktree 给每个 Agent 独立代码副本防冲突。

---

## 阅读建议

- **只有 10 分钟？** → 读快速入门
- **理解核心原理？** → 按顺序：主循环 → 上下文工程 → 工具系统
- **自己造一个 AI Agent？** → 先读最小必要组件，再跟 claude-code-from-scratch 动手
- **定制 Claude Code？** → Hooks + 记忆系统 + 技能系统
- **关注安全？** → 权限与安全 + 代码编辑策略

---

## 相关链接

- GitHub: https://github.com/Windy3f3f3f3f/how-claude-code-works
- 在线文档: https://windy3f3f3f3f.github.io/how-claude-code-works/
- 姊妹教程: https://github.com/Windy3f3f3f3f/claude-code-from-scratch

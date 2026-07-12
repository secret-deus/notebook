---
tags:
  - coding-agent
  - ai
  - architecture
  - claude-code
  - llm
date: 2026-07-01
source: https://diwang.info/claude-code-from-scratch/
github: https://github.com/Windy3f3f3f3f/claude-code-from-scratch
title: "Claude Code 从零构建 - 架构解析"
---

# Claude Code 从零构建 - 架构解析

## 项目概述

**[Claude Code From Scratch](https://github.com/Windy3f3f3f3f/claude-code-from-scratch)** 是一个教学项目，用 **~4300 行代码**（TypeScript + Python 双版本）复现了 Claude Code 的核心架构。不是 demo，而是一份**分步教程**——13 章内容，每步都对照真实源码讲解。

姊妹项目 **[How Claude Code Works](https://github.com/Windy3f3f3f3f/how-claude-code-works)** 有 12 篇专题、33 万字，从源码级别深度解析 Claude Code 架构。

## 核心洞察（7 条）

### 1. Agent 的本质是一个 while 循环

```
while true:
    response = llm.call(messages)
    if no tool_calls in response: break
    for tool_call in response.tool_calls:
        result = execute(tool_call)
        messages.append(result)
```

所有的复杂性——权限、上下文管理、记忆、多 Agent——都是围绕这个循环的增强和防护。

### 2. 提示词是最便宜的代码

系统提示词里的一句话，效果等同于一个 if 语句，实现成本是 0 行代码。Agent 开发中很多行为问题的最优解不是写更多代码，而是写更好的提示词。

### 3. 工具设计决定能力上限

让模型做它擅长的（理解意图、生成代码），让工具做模型不擅长的（精确字符串匹配、文件系统操作、进程管理）。`edit_file` 是典型：模型生成要替换的内容，工具负责精确定位和替换。

### 4. 上下文管理是 Agent 的"记忆力"

上下文管理之于 agent，就像内存管理之于操作系统——用有限资源提供"无限"错觉。4 层压缩流水线让 agent 在有限窗口中保持对长对话的记忆。

### 5. 安全不是事后补丁

权限检查是 agent 循环的一个步骤，不是外挂的 middleware。**fail-closed 设计**：新工具如果忘记声明权限级别，被自动当作"需要确认"处理。

### 6. 从 3000 行到 50 万行的差距在于边缘情况

Claude Code 多出来的代码大多是：各运行环境兼容性、网络和 API 不可靠性、用户输入多样性、企业级审计和访问控制。从原型到产品，80% 的距离在这里。

### 7. LLM 与代码的协作边界

模型决定"做什么"，代码确保"安全地做"。边界划得好，agent 既灵活又可靠。

## 13 章教程结构

### Phase 1: 构建可用的 Coding Agent

| 章节 | 内容 | 对应源码 |
|------|------|----------|
| 1. Agent Loop | 核心循环：调用 LLM → 执行工具 → 重复 | query.ts |
| 2. 工具系统 | 13 个工具 + mtime 防护 + 延迟加载 | Tool.ts + 66 工具 |
| 3. System Prompt | 提示词工程 + @include 语法 | prompts.ts |
| 4. CLI 与会话 | REPL、Ctrl+C、会话持久化 | cli.tsx |
| 5. 流式输出 | 双后端 + 流式工具执行 + 并行执行 | api/claude.ts |
| 6. 权限与安全 | 5 模式 + 声明式规则 + 危险检测 | permissions/ |
| 7. 上下文管理 | 4 层压缩 + 大结果持久化 | compact/ |

### Phase 2: 进阶能力

| 章节 | 内容 | 对应源码 |
|------|------|----------|
| 8. 记忆系统 | 4 类型记忆 + 语义召回 + 异步预取 | memory.ts |
| 9. 技能系统 | 技能发现 + inline/fork 双模式 | SkillTool/ |
| 10. Plan Mode | 只读规划 + 4 选项审批工作流 | EnterPlanMode |
| 11. 多 Agent | Sub-Agent fork-return 架构 | AgentTool/ |
| 12. MCP 集成 | JSON-RPC over stdio 连接外部工具 | mcpClient.ts |
| 13. 架构对比 | 完整对比 + 扩展方向 | 全局 |
| 14. 功能测试 | 19 项手动测试覆盖全部功能 | test/ |

## 项目结构（TypeScript 版，共 ~4291 行）

```
src/
├── agent.ts        # Agent 循环：流式、并行、4 层压缩、预算 (1501 行)
├── tools.ts        # 工具：13 工具 + mtime 防护 + 延迟加载 (858 行)
├── cli.ts          # CLI 入口：参数解析、REPL、预算 flags (371 行)
├── memory.ts       # 记忆系统：4 类型 + 语义召回 + 异步预取 (376 行)
├── mcp.ts          # MCP 客户端：JSON-RPC over stdio (266 行)
├── prompt.ts       # System Prompt：@include + 模板 + 注入 (230 行)
├── ui.ts           # 终端输出：彩色显示、格式化、子 Agent 显示 (211 行)
├── subagent.ts     # 子 Agent：3 内置 + 自定义 Agent 发现 (199 行)
├── skills.ts       # 技能系统：目录发现 + inline/fork 双模式 (175 行)
├── session.ts      # 会话持久化：保存/恢复/列表 (63 行)
└── frontmatter.ts  # 共享 YAML frontmatter 解析器 (41 行)
```

Python 版功能一致，~3811 行。

## Agent Loop 核心设计

### 双层架构

- **QueryEngine**（~1155 行）：会话级，管整个对话生命周期——用户输入处理、USD 预算检查、Token 统计、会话恢复
- **queryLoop**（~1728 行）：单轮级，管一次查询的执行——消息压缩、API 调用、工具执行、错误恢复

设计意图：关注点分离——QueryEngine 不需要知道"PTL 错误怎么恢复"，queryLoop 不需要知道"用户输入怎么解析"。

### queryLoop 设计选择

签名是 `async function*`（异步生成器），原因：
1. **背压控制**：消费端不处理完，生产端不继续
2. **线性控制流**：所有循环分支用普通 `continue`/`break` 表达，不需要状态机

### 七种 Continue Reason

| # | 名称 | 触发场景 | 处理策略 |
|---|------|----------|----------|
| 1 | next_turn | 模型调用了工具 | 执行工具，结果推入消息，继续 |
| 2 | collapse_drain_retry | PTL 错误，有暂存的折叠操作 | 提交折叠释放空间，重试 |
| 3 | reactive_compact_retry | PTL 错误，折叠空间不够 | 强制全量摘要压缩，重试 |
| 4 | max_output_tokens_escalate | 输出 Token 截断，首次 | 升级到更高 Token 限制（16K→64K），重试 |
| 5 | max_output_tokens_recovery | 输出 Token 截断，升级不可用 | 注入续写提示，最多重试 3 次 |
| 6 | stop_hook_blocking | 任务完成但 Stop Hook 拦截 | 继续执行循环 |
| 7 | token_budget_continuation | API 侧 Token 预算耗尽 | 继续生成 |

简化实现只处理第 1 种：有 tool_use 就继续，否则停。

### 错误扣留策略

可恢复的错误不立即暴露给上层。当输出 Token 被截断时，如果直接 yield 错误，UI 会显示报错——但 queryLoop 后续的恢复逻辑其实能自动处理。所以先"扣留"错误，执行恢复逻辑，成功了用户完全无感知，失败了才最终暴露。大多数 `max_output_tokens` 和 `prompt_too_long` 错误都被这样静默处理掉了。

### 并行工具执行

```
串行：[========= API 流式响应 =========][tool1][tool2][tool3]
并行：[========= API 流式响应 =========]
      ↑ tool1 JSON 完成 → 立即执行
           ↑ tool2 JSON 完成 → 立即执行
```

Claude Code 用 `StreamingToolExecutor` 在 API 流式响应期间并行执行工具。一个典型 API 响应有 5-30 秒的流式窗口，在这个时间里多个工具可以并发完成，2-3x 加速。

## 消息数组增长方式

理解 Agent Loop 的关键——每轮循环消息数组增长两条（一条 assistant，一条 user 工具结果）：

```
第 1 轮:
  messages = [
    { role: "user",      content: "帮我修复 bug" }
    { role: "assistant", content: [text + tool_use(read_file)] }
    { role: "user",      content: [tool_result("文件内容...")] }
  ]

第 2 轮（LLM 看到文件内容后决定编辑）:
  messages = [
    ...前 3 条,
    { role: "assistant", content: [text + tool_use(edit_file)] }
    { role: "user",      content: [tool_result("编辑成功")] }
  ]

第 3 轮（LLM 认为任务完成）:
  messages = [
    ...前 5 条,
    { role: "assistant", content: [text("已修复!")] }  ← 无 tool_use → break
  ]
```

工具结果用 `role: "user"` 推入是 Anthropic API 的协议要求，必须通过 `tool_use_id` 关联回对应的调用。

## AbortController：优雅中断

```typescript
async chat(userMessage: string): Promise<void> {
  this.abortController = new AbortController();
  try {
    await this.chatAnthropic(userMessage);
  } finally {
    this.abortController = null;
  }
  printDivider();
  this.autoSave();
}

abort() {
  this.abortController?.abort();
}
```

`abort()` 被调用后 signal 变为 `aborted`，循环在下一个检查点退出。signal 同时传给 API 调用，确保网络请求也能被取消。

## 与 Claude Code 完整对比

| 维度 | Claude Code | Mini Claude Code |
|------|-------------|------------------|
| 定位 | 生产级编程智能体 | 教学 / 最小可用实现 |
| 工具数量 | 66+ 内置工具 | 13 个工具（6 核心 + web_fetch + tool_search + skill + agent + plan mode） |
| 工具执行 | 并发 + streaming 早期启动 | 并行执行 + streaming 早期启动 |
| 上下文管理 | 4 级压缩流水线 | 4 层压缩 + 大结果持久化（>30KB） |
| 权限系统 | 7 层 + AST 分析 | 5 种模式 + 声明式规则 + 正则检测 |
| 编辑验证 | 14 步流水线 | 引号容错 + 唯一性 + mtime 防护 + diff 输出 |
| 记忆系统 | 4 类型 + 语义召回 | 4 类型 + 语义召回 + 异步预取 |
| 技能系统 | 6 源 + inline/fork | 2 源 + inline/fork |
| 多 Agent | Sub-Agent + Coordinator + Swarm | Sub-Agent（3 内置 + 自定义） |
| MCP 集成 | mcpClient.ts + 动态工具发现 | McpManager + JSON-RPC over stdio |
| 代码量 | 50 万+ 行 | ~4300 行（TS）/ ~3800 行（Python） |

## 核心能力清单

- **Agent 循环**：自动调用工具、处理结果、持续迭代
- **13 个工具**：读写编辑文件（mtime 防护）、搜索、Shell、WebFetch、ToolSearch（延迟加载）、技能、子 Agent、Plan Mode
- **流式输出**：逐字实时显示，Anthropic + OpenAI 双后端，streaming 工具早期执行
- **并行工具执行**：只读工具自动并发，2-3x 加速
- **4 层上下文压缩**：budget 截断 → stale snip → microcompact → auto-compact + 大结果持久化（>30KB 写磁盘）
- **权限系统**：5 种模式 + `.claude/settings.json` 声明式 allow/deny 规则 + 16 个危险命令正则
- **记忆系统**：4 类型记忆 + 语义召回（sideQuery 调模型选择相关记忆）+ 异步预取
- **技能系统**：`.claude/skills/` 目录加载，支持 inline 注入和 fork 子 Agent 两种执行模式
- **多 Agent**：Sub-Agent fork-return 模式（3 内置类型 + `.claude/agents/` 自定义类型）
- **MCP 集成**：JSON-RPC over stdio 连接外部工具服务器
- **System Prompt**：@include 语法递归引入、.claude/rules/ 自动加载
- **Extended Thinking**：支持 adaptive/enabled/disabled 三模式
- **预算控制**：`--max-cost` 费用限制 + `--max-turns` 轮次限制
- **会话持久化**：自动保存对话，`--resume` 恢复
- **错误恢复**：API 限流/过载时指数退避 + 随机抖动重试（最多 3 次），Ctrl+C 优雅中断
- **跨平台**：Windows / macOS / Linux，自动检测 shell

## 未实现的能力与原因

| 能力 | 预计代码量 | 未实现原因 |
|------|-----------|-----------|
| **Hooks 系统** | ~300 行 | 核心挑战在发现/加载/错误隔离/JSON 数据协议，非 Agent 原理问题 |
| **Coordinator/Swarm** | ~500-600 行 | 更多是 prompt engineering 问题而非代码架构问题 |
| **LSP 集成** | ~1000 行 | 需要管理 LSP 服务器进程、客户端协议实现，环境障碍高 |
| **Prompt Caching** | ~30 行 | 投入产出比最高，上线应第一个加，但需仔细设计分区策略 |
| **Bash AST 安全分析** | ~600 行 | tree-sitter 是 C/C++ 原生库，需 node-gyp 编译环境 |

## 渐进式增强路线图

### 第一阶段：性能与成本优化（1-2 天）
- **Prompt Caching**（~30 行）：给系统提示词静态部分加 `cache_control: { type: "ephemeral" }` 标记，多轮对话节省 50%+ 输入 token 成本

### 第二阶段：可扩展性（3-5 天）
- **Hook 系统**（~300 行）：command hook，spawn 子进程传 JSON，根据 `{"action": "allow"}` / `{"action": "deny"}` 决定
- **Tool 类型系统**（~200 行）：从硬编码 switch/case 到插件化 Tool 接口/Protocol

### 第三阶段：可靠性与安全（1-2 周）
- **7 种错误恢复策略**（~400 行）：PTL 自动压缩重试、API 过载指数退避、工具失败反馈模型自修复
- **Bash AST 安全分析**（~600 行）：tree-sitter 解析 23 项静态检查

### 第四阶段：高级 Agent 能力（2-4 周）
- **Coordinator 模式**（~500 行）：大任务拆分给多个专业 Agent
- **Swarm 模式**（~600 行）：多 Agent 对等通信、并行探索
- **LSP 集成**（~1000 行）：毫秒级类型错误反馈

## 运行命令速查

```bash
# TypeScript
npm start                    # 交互式 REPL
npm start -- --resume        # 恢复上次会话
npm start -- --yolo          # 跳过安全确认
npm start -- --plan          # Plan 模式：只分析不修改
npm start -- --accept-edits  # 自动批准文件编辑
npm start -- --dont-ask      # CI 模式
npm start -- --max-cost 0.50 # 费用限制（美元）
npm start -- --max-turns 20  # 轮次限制

# Python
mini-claude-py               # 交互式 REPL
mini-claude-py --resume      # 恢复上次会话
mini-claude-py --yolo        # 跳过安全确认
```

## REPL 命令

| 命令 | 功能 |
|------|------|
| `/clear` | 清空对话历史 |
| `/cost` | 显示累计 token 用量和费用估算 |
| `/compact` | 手动触发对话压缩 |
| `/memory` | 列出所有已保存的记忆 |
| `/skills` | 列出可用的技能 |
| `/<skill>` | 调用已注册的技能（如 `/commit`） |

## 配置 API

```bash
# Anthropic 格式（推荐）
export ANTHROPIC_API_KEY="sk-ant-xxx"
export ANTHROPIC_BASE_URL="https://aihubmix.com"  # 可选代理

# OpenAI 兼容格式
export OPENAI_API_KEY="sk-xxx"
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

## 相关链接

- GitHub: https://github.com/Windy3f3f3f3f/claude-code-from-scratch
- 在线文档: https://diwang.info/claude-code-from-scratch/
- 姊妹项目: https://github.com/Windy3f3f3f3f/how-claude-code-works

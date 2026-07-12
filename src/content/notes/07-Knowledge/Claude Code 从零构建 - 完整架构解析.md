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
title: "Claude Code 从零构建 - 完整架构解析"
---

# Claude Code 从零构建 - 完整架构解析

> 用 ~4300 行代码（TypeScript + Python 双版本）复现 Claude Code 核心架构的分布教程。姊妹项目 [[How Claude Code Works - 姊妹项目概览]] 有 15 篇专题、33 万字源码级深度解析。

---

## 7 条核心洞察

### 1. Agent 的本质是一个 while 循环

```
while true:
    response = llm.call(messages)
    if no tool_calls in response: break
    for tool_call in response.tool_calls:
        result = execute(tool_call)
        messages.append(result)
```

所有复杂性——权限、上下文管理、记忆、多 Agent——都是围绕这个循环的增强和防护。

### 2. 提示词是最便宜的代码

系统提示词里的一句话，效果等同于一个 if 语句，实现成本是 0 行代码。很多行为问题的最优解不是写更多代码，而是写更好的提示词。

### 3. 工具设计决定能力上限

模型做它擅长的（理解意图、生成代码），工具做模型不擅长的（精确字符串匹配、文件系统操作、进程管理）。`edit_file` 是典型：模型生成要替换的内容，工具负责精确定位和替换。

### 4. 上下文管理是 Agent 的"记忆力"

上下文管理之于 agent，就像内存管理之于操作系统——用有限资源提供"无限"错觉。4 层压缩流水线让 agent 在有限窗口中保持对长对话的记忆。

### 5. 安全不是事后补丁

权限检查是 agent 循环的一个步骤，不是外挂的 middleware。**fail-closed 设计**：新工具如果忘记声明权限级别，被自动当作"需要确认"处理。

### 6. 从 3000 行到 50 万行的差距在于边缘情况

Claude Code 多出来的代码大多是：各运行环境兼容性、网络和 API 不可靠性、用户输入多样性、企业级审计和访问控制。从原型到产品，80% 的距离在这里。

### 7. LLM 与代码的协作边界

模型决定"做什么"，代码确保"安全地做"。边界划得好，agent 既灵活又可靠。

---

## 项目结构

```
src/                    # TypeScript 版 (~4291 行)
├── agent.ts            # Agent 循环：流式、并行、4层压缩、预算 (1501 行)
├── tools.ts            # 工具：13工具 + mtime防护 + 延迟加载 (858 行)
├── cli.ts              # CLI 入口：参数解析、REPL、预算 flags (371 行)
├── memory.ts           # 记忆系统：4类型 + 语义召回 + 异步预取 (376 行)
├── mcp.ts              # MCP 客户端：JSON-RPC over stdio (266 行)
├── prompt.ts           # System Prompt：@include + 模板 + 注入 (230 行)
├── ui.ts               # 终端输出：彩色显示、格式化、子Agent显示 (211 行)
├── subagent.ts         # 子Agent：3内置 + 自定义Agent发现 (199 行)
├── skills.ts           # 技能系统：目录发现 + inline/fork双模式 (175 行)
├── session.ts          # 会话持久化：保存/恢复/列表 (63 行)
└── frontmatter.ts      # 共享 YAML frontmatter 解析器 (41 行)

python/                 # Python 版 (~3811 行，功能一致)
```

---

## 第 1 章：Agent Loop — 核心循环

### 双层架构

Claude Code 把 Agent Loop 拆成两层：

- **QueryEngine**（~1155 行）：会话级，管整个对话生命周期——用户输入处理、USD 预算检查、Token 统计、会话恢复
- **queryLoop**（~1728 行）：单轮级，管一次查询的执行——消息压缩、API 调用、工具执行、错误恢复

queryLoop 签名是 `async function*`——异步生成器，选择原因：
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

简化实现只处理第 1 种。

### 错误扣留策略

可恢复的错误不立即暴露给上层。当输出 Token 被截断时，先"扣留"错误，执行恢复逻辑，成功了用户完全无感知，失败了才最终暴露。大多数 `max_output_tokens` 和 `prompt_too_long` 错误都被这样静默处理。

### 并行工具执行

```
串行：[========= API 流式响应 =========][tool1][tool2][tool3]
并行：[========= API 流式响应 =========]
      ↑ tool1 JSON 完成 → 立即执行
           ↑ tool2 JSON 完成 → 立即执行
```

一个典型 API 响应有 5-30 秒的流式窗口，多个工具并发完成。

### 消息数组增长方式

每轮循环消息数组增长两条（一条 assistant，一条 user 工具结果）。工具结果用 `role: "user"` 推入是 Anthropic API 的协议要求。

### 核心代码

```typescript
// agent.ts — 核心 Agent Loop
private async chatAnthropic(userMessage: string): Promise<void> {
  this.anthropicMessages.push({ role: "user", content: userMessage });
  await this.checkAndCompact();

  while (true) {
    if (this.abortController?.signal.aborted) break;
    const response = await this.callAnthropicStream();
    this.totalInputTokens += response.usage.input_tokens;
    this.totalOutputTokens += response.usage.output_tokens;

    const toolUses = response.content.filter(b => b.type === "tool_use");
    this.anthropicMessages.push({ role: "assistant", content: response.content });

    if (toolUses.length === 0) break;  // 任务完成

    const toolResults = [];
    for (const toolUse of toolUses) {
      const perm = checkPermission(toolUse.name, input, this.permissionMode);
      if (perm.action === "deny") { toolResults.push(...); continue; }
      if (perm.action === "confirm") {
        const confirmed = await this.confirmDangerous(perm.message);
        if (!confirmed) { toolResults.push(...); continue; }
      }
      const result = await executeTool(toolUse.name, input);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }
    this.anthropicMessages.push({ role: "user", content: toolResults });
  }
}
```

Python 版本逻辑完全一致，使用 `asyncio` 替代 Promise。

---

## 第 2 章：工具系统

### 6 个核心工具 + 7 个扩展工具

| 工具 | 类型 | 说明 |
|------|------|------|
| read_file | 核心 | 读取文件，带行号 |
| write_file | 核心 | 写文件，自动创建父目录 |
| edit_file | 核心 | 字符串替换编辑，唯一性检查 + 引号容错 |
| list_files | 核心 | 文件列表（glob 模式） |
| grep_search | 核心 | 内容搜索（系统 grep） |
| run_shell | 核心 | 执行 shell 命令，30s 超时 |
| web_fetch | 扩展 | HTTP 请求，去标签 + 超时 |
| tool_search | 扩展 | 延迟工具发现 |
| skill | 扩展 | 技能系统入口 |
| agent | 扩展 | 子 Agent 启动 |
| enter_plan_mode | 扩展 | 进入规划模式（deferred） |
| exit_plan_mode | 扩展 | 退出规划模式（deferred） |

### Claude Code 的 Tool 接口

```typescript
type Tool<Input, Output, P> = {
  name: string
  aliases?: string[]
  maxResultSizeChars: number
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  description(input, options): Promise<string>
  prompt(options): Promise<string>
  inputSchema: Input  // Zod Schema（运行时验证 + 类型推导）
  isConcurrencySafe(input): boolean   // 接收input：同工具不同参数可有不同安全语义
  isReadOnly(input): boolean
  checkPermissions(input, context): Promise<PermissionResult>
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(content, progress, options): React.ReactNode
}
```

**设计要点**：
- `isConcurrencySafe(input)` 接收参数——BashTool 对 `ls` 返回只读，对 `rm` 返回非安全
- `prompt()` 方法——每个工具向 system prompt 注入使用指南
- FAIL-CLOSED 默认值：`isConcurrencySafe: () => false`（默认不可并发），`isReadOnly: () => false`

### edit_file 的核心设计

**为什么用 search-and-replace 而非其他方案？**

| 方案 | 致命缺陷 |
|------|----------|
| 行号编辑 | 第一次插入 3 行后，后续所有行号偏移 |
| AST 编辑 | 语法错误的文件 AST 解析直接报错 |
| Unified diff | LLM 生成严格格式时表现很差 |
| 全文件重写 | 浪费 Token；可能遗漏未修改代码 |
| **字符串替换** | ✅ 无上述缺陷。幻觉安全：字符串不存在直接失败 |

### 引号容错 + Diff 输出

LLM 的 tokenization 可能将直引号映射为弯引号（`" → "`），没有容错这类编辑会 100% 失败。

```typescript
function normalizeQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"');
}
```

### Read-before-edit + mtime 防护

编辑文件前必须先读取。通过 `readFileState` Map（key=绝对路径，value=mtimeMs）检测外部修改。三个关键点：
- 新文件跳过检查（创建新文件不需要先读）
- mtime 比较：不一致说明被外部修改，返回警告而非静默覆盖
- 写入后更新 mtime

### ToolSearch 延迟加载

不常用的工具标记 `deferred: true`，只发名称不发完整 schema。模型需要时通过 `tool_search` 按需激活。教程只有 2 个 deferred 工具（plan mode），但机制对扩展至关重要。

### 大结果处理

两层防线：`persistLargeResult`（>30KB 先写磁盘保留完整内容）→ `truncateResult`（>50KB 截断保留头尾）。与 truncateResult 的根本区别是 persistLargeResult 可恢复——模型随时可用 read_file 取回完整内容。

---

## 第 3 章：System Prompt 工程

### 7 层递进结构

```
1. Identity     → 我是谁？
2. System       → 运行环境的基本事实
3. Doing Tasks  → 怎么写代码？（反模式接种）
4. Actions      → 哪些操作需要确认？（爆炸半径框架）
5. Using Tools  → 怎么用工具？（偏好映射表）
6. Tone & Style → 输出什么格式？
7. Output Efficiency → 怎么更简洁？
```

### 反模式接种

明确告诉模型"不要做什么"比只描述"要做什么"有效得多。Claude Code 的三条精确"不要"：
- **不要扩大范围**：修 bug 不需要顺手重构
- **不要防御性编程**：不为不可能的场景加 try-catch
- **不要过早抽象**："Three similar lines > premature abstraction"

### 爆炸半径框架

不罗列"不能做 X、Y、Z"，而是教模型二维评估：**可逆性 × 影响范围**。高风险 = 不可逆 + 影响共享环境（force push、删除云资源）。这比穷举规则扩展性强得多。

### 工具偏好映射表

模型默认会用训练数据中出现最多的方式（bash 命令），所以必须在提示词中明确引导：
- Use `read_file` instead of `cat/head/tail`
- Use `edit_file` instead of `sed/awk`
- Use `list_files` instead of `find/ls`
- Use `grep_search` instead of `grep/rg`

### @include 语法与 Rules 自动加载

CLAUDE.md 支持 `@` 语法引用外部文件：`@./relative` / `@~/path` / `@/absolute`。`.claude/rules/*.md` 自动加载。防护：visited Set 防循环、MAX_INCLUDE_DEPTH=5、找不到文件留注释不报错。

### 模板变量

```
{{cwd}} — 工作目录    {{date}} — 当前日期    {{platform}} — 操作系统
{{shell}} — Shell路径  {{git_context}} — Git状态  {{claude_md}} — CLAUDE.md
{{memory}} — 记忆索引  {{skills}} — 技能列表    {{agents}} — Agent类型
```

`{{memory}}`、`{{skills}}`、`{{agents}}` 放在末尾利用近因效应。

---

## 第 5 章：流式输出与双后端

### Anthropic 后端：SDK 内置 stream

`stream.on("text")` 直接给文本增量，`stream.finalMessage()` 返回和非流式完全一样的 Message 对象。thinking blocks 过滤掉不存入历史——可能长达数千 token，对后续对话没有参考价值。

### OpenAI 后端：手动 chunk 累积

OpenAI tool_calls 的 `id` 和 `name` 只在第一个 chunk 出现，后续 chunk 只有 `arguments` 的增量片段。多个 tool_call 的 chunk 会交错到达，用 `index` 字段区分。

### 流式工具执行（Anthropic）

当 `content_block_stop` 事件触发时，并发安全的工具（read_file、list_files、grep_search、web_fetch）立即启动——不必等整个 API 响应完成。工具执行藏在模型生成的流式窗口内。

### 并行工具执行（OpenAI）

OpenAI 不支持下流式工具 block 事件，采用显式批量并行：将连续的安全工具分组，用 `Promise.all` / `asyncio.gather` 一次性执行。混合序列 `[read, read, write, read]` 分为三个批次：`[read||read]`、`[write]`、`[read]`。

### 重试机制

指数退避 + 随机抖动：`min(1000 * 2^attempt, 30000) + random(0, 1000)`。可重试：429/503/529 和网络瞬断；不可重试：400/401/404。

### Extended Thinking

三种模式：`adaptive`（claude-4.x 自动开启，budget 10000 tokens）、`enabled`（`--thinking` 显式开启，budget 最大化）、`disabled`（不支持 thinking 的模型）。

---

## 第 6 章：权限与安全

### Claude Code 的 7 层纵深防御

| 层 | 机制 | 核心作用 |
|---|------|----------|
| 1 | Trust Dialog | 首次进入目录确认信任 |
| 2 | 权限模式 | 全局策略开关 |
| 3 | 权限规则匹配 | allow/deny 规则，8 个来源 |
| 4 | Bash AST 分析 | tree-sitter 解析，23 项安全检查 |
| 5 | 工具级验证 | 危险文件路径和路径边界保护 |
| 6 | 沙箱隔离 | macOS Seatbelt / Linux namespace |
| 7 | 用户确认交互 | 对话框 + Hook + ML 分类器竞速 |

### mini-claude 的 4 层简化

**Layer 1：危险命令检测**（16 个正则，10 个 Unix + 6 个 Windows）

- `\brm\s`、`\bgit\s+(push|reset|clean)`、`\bsudo\b`、`\bmkfs\b`、`\bdd\s`
- `\bkill\b`、`\bpkill\b`、`\breboot\b`、`\bshutdown\b`、`>\s*\/dev\/`
- Windows: `\bdel\s`、`\brmdir\s`、`\bformat\s`、`\bRemove-Item\s` 等

**Layer 2：权限规则系统**（allow/deny，两个来源：用户级 + 项目级）

规则格式：`"run_shell(npm test*)"` （尾部 `*` 前缀匹配）、`"read_file"` （裸工具名匹配所有调用）。deny 先于 allow 遍历——"先放开，再收紧"的配置方式因此成立。

**Layer 3：统一权限检查**（`checkPermission`）

优先级：deny 规则 > allow 规则 > 模式逻辑 > 内置危险检测 > 默认允许。
触发确认的条件：run_shell + 危险命令、write_file/edit_file + 目标不存在。
read_file、list_files、grep_search 永远安全。

**Layer 4：会话级白名单**（`confirmedPaths` Set）

用户确认一次后同一操作不再重复询问。拒绝时把 `"User denied this action."` 作为工具结果返回——LLM 看到后会调整策略。

### 5 种权限模式

| 模式 | 读工具 | 编辑工具 | Shell(安全) | Shell(危险) | 适用场景 |
|------|--------|----------|-------------|-------------|----------|
| default | ✅ | ⚠️ confirm(新文件) | ✅ | ⚠️ confirm | 日常使用 |
| plan | ✅ | ❌ deny | ❌ deny | ❌ deny | 只规划不执行 |
| acceptEdits | ✅ | ✅ | ✅ | ⚠️ confirm | 信任编辑 |
| bypassPermissions | ✅ | ✅ | ✅ | ✅ | --yolo |
| dontAsk | ✅ | ❌ deny | ✅ | ❌ deny | CI/非交互 |

### 配置文件格式

```json
// ~/.claude/settings.json（用户级）或 .claude/settings.json（项目级）
{
  "permissions": {
    "allow": ["read_file", "run_shell(npm test*)", "run_shell(git status)"],
    "deny": ["run_shell(rm -rf*)", "run_shell(git push --force*)"]
  }
}
```

---

## 第 7 章：上下文管理

### 4 层渐进式压缩管道

**第 0 层：执行时截断** — `truncateResult`，50K 硬限制，保留头尾。

**第 0.5 层：大结果持久化** — `persistLargeResult`，>30KB 写磁盘保留完整内容，上下文只留 200 行预览。可恢复 vs 不可恢复的根本区别。

**第 1 层：Budget** — 动态缩减历史中工具结果大小。双阈值（50%/70%）而非单阈值，利用率越高预算越紧。

**第 2 层：Snip** — 替换过时的工具结果。利用率 > 60% 触发：
- 同一文件多次 read_file → 只保留最新
- 同类搜索结果超过 3 个 → snip 最旧
- 最近 3 个 tool_result 永远保留
- **只清 content 保留 tool_use**——模型仍知执行过什么操作

**第 3 层：Microcompact** — 空闲 > 5 分钟触发，除最近 3 个外所有旧 tool_result → `"[Old result cleared]"`。基于 prompt cache TTL 到期判断。

**第 4 层：Auto-compact** — 利用率 > 85% 触发，fork 子 Agent 生成摘要。必须在 turn boundary 调用（不能在 tool 循环中间），否则会破坏 tool_use/tool_result 配对。

### 调用顺序

Tier 1-3 在每次 API 调用**前**运行（零 API 成本），Tier 4 在 **turn boundary** 触发（用户输入 push 后、while 主循环前）。顺序也有意义：Budget 先压缩大结果，让 Snip 的去重判断更准确。

---

## 第 8 章：记忆系统

### 核心约束

**只记忆不可从当前项目状态推导的信息。** 代码模式、架构、文件路径——读代码和 `git log` 就能获得，记忆中的版本只会制造漂移。

### 四种记忆类型

| 类型 | 记什么 | 触发时机 |
|------|--------|----------|
| user | 用户身份、偏好、知识背景 | 了解到用户角色/偏好时 |
| feedback | 对 Agent 行为的纠正**和肯定** | 用户纠正或肯定某行为时 |
| project | 项目进展、决策、截止日期 | 了解到项目动态时 |
| reference | 外部系统的定位信息 | 了解到外部系统位置时 |

feedback 类型特别记录肯定——只记录"错误"会让模型避免重蹈覆辙，但也可能放弃已验证的好做法。project 类型相对日期必须转绝对日期。

### 存储结构

```
~/.mini-claude/projects/{sha256}/memory/
├── MEMORY.md                          # 索引文件
├── user_prefers_concise_output.md
├── feedback_no_summary_at_end.md
└── project_auth_migration_q2.md
```

### 语义召回（sideQuery）

用同一模型做语义选择（发送记忆清单：文件名 + 描述），比关键词匹配强得多——"部署流程"能匹配到"CI/CD 注意事项"。

### 异步预取（startMemoryPrefetch）

用户提交输入瞬间就启动召回，与第一次模型 API 调用并行。三个门控：多词查询（单次跳过）、会话预算（>60KB 停止）、记忆存在性。非阻塞轮询：settled 标志用 `.then()` 设置，每次循环迭代检查。

### Freshness Warning

超过 1 天的记忆附带警告："此记忆已过时 X 天，记忆是时间点观察而非实时状态——关于代码行为的断言可能已过时，对照当前代码验证后再执行。"

### 设计决策

为什么用文件系统而非数据库？用户可直接编辑器读写、模型用已有 write_file/read_file 就能操作、可纳入 git 版本控制。

---

## 第 9 章：技能系统

### SKILL.md 格式

```markdown
---
name: commit
description: Create a git commit with a descriptive message
when_to_use: When the user asks to commit changes
allowed-tools: run_shell, read_file
user-invocable: true
---
Look at the current git diff and staged changes...
The user's request: $ARGUMENTS
Project skill directory: ${CLAUDE_SKILL_DIR}
```

### 双重调用路径

**路径 1：用户手动** — REPL 中 `/commit` → `resolveSkillPrompt()` → `agent.chat()`
**路径 2：模型程序化** — 调用 `skill` 工具 → 得到展开后的 prompt 文本 → 在下一回合按此执行

本质上 skill 工具是**元工具**——返回值不是数据而是指令。

### 执行模式

- **inline**（默认）：prompt 直接注入当前对话
- **fork**：创建独立子 Agent（`isSubAgent: true, permissionMode: "bypassPermissions"`），工具受 `allowedTools` 白名单约束

fork 适合需要大量工具调用的技能（如代码审查读多个文件），避免污染主对话上下文。

### 发现与加载

从 `.claude/skills/`（用户级 + 项目级）加载，用 Map 去重实现"项目级覆盖用户级"。

---

## 第 10 章：Plan Mode

### 状态变量

`prePlanMode`（进入前模式，用于恢复）、`planFilePath`（plan 文件路径）、`baseSystemPrompt`（不含 plan 注入）、`contextCleared`。

### Plan 系统提示

约束行为（明确禁止编辑和 shell）、声明 plan 文件（唯一可写路径）、规定工作流（Explore → Design → Write → Exit）。最后一句"Do NOT ask the user to approve"是关键——否则模型常问"这个计划可以吗？"而不调用 `exit_plan_mode`。

### 权限集成

Plan Mode 的 read-only 通过 `checkPermission()` 强制执行。**精巧设计**：plan 文件路径作为参数传入，只有完全匹配才放行——系统提示词说"只能写 plan 文件"不只是建议，是代码强制约束。**双重保障**：提示词引导（减少无效调用）+ 权限拦截（即使模型无视提示词）。

### 4 选项审批工作流

| 选项 | 权限切换 | 上下文 | 适用场景 |
|------|----------|--------|----------|
| 1. Clear + Execute | → acceptEdits | 清空 | 计划完善，上下文已长 |
| 2. Execute | → acceptEdits | 保留 | Agent 已有足够上下文 |
| 3. Manual | → 恢复原模式 | 保留 | 逐步审批每修改 |
| 4. Keep Planning | 不变 | 保留 | 给反馈让 Agent 继续调整 |

### CLI 三个入口

`--plan` 启动时进入、`/plan` 会话中途切换、`enter_plan_mode` 工具 Agent 自主判断。

---

## 第 11 章：多 Agent 架构

### Sub-Agent（fork-return）模式

用 ~199 行的 `subagent.ts` 实现。核心洞察：**子 Agent 本质上就是一个配置不同的 Agent 实例**——同一套 agent loop 同时服务主 Agent 和子 Agent。

### 三种内置类型

| 类型 | 工具集 | System Prompt |
|------|--------|---------------|
| Explore | read_file, list_files, grep_search, run_shell | 只读约束，快速代码探索 |
| Plan | read_file, list_files, grep_search | 结构化规划输出 |
| General | 全工具（排除 agent） | 通用独立任务 |

### 关键实现细节

- **outputBuffer** 三态：`null`=主Agent（直接打印）、`[]`=子Agent（开始收集）、`[...]`=积累中
- **runOnce**：开启 buffer → chat() → 收集 → 关闭 buffer，生命周期边界清晰
- **权限继承**：子 Agent 默认 bypassPermissions，但 Plan Mode 必须继承（否则安全漏洞）
- **子 Agent 不能创建子 Agent**：General Agent 工具列表过滤掉 agent，防止递归嵌套

### 自定义 Agent 类型

`.claude/agents/*.md` 文件定义，frontmatter 复用 `parseFrontmatter()`。项目级（`.claude/agents/`）覆盖用户级（`~/.claude/agents/`）。

---

## 第 12 章：MCP 集成

### 核心思路

**spawn 子进程 → JSON-RPC 握手 → 发现工具 → 前缀注册 → 透明路由**。对 Agent Loop 来说，MCP 工具和内置工具没有区别——都是名字 + schema + 执行函数。

### ~266 行实现，无 SDK 依赖

| 组件 | 职责 |
|------|------|
| McpConnection | 子进程管理 + JSON-RPC 通信 |
| McpManager | 多连接生命周期 + 配置加载 + 工具路由 |

### 三段式前缀命名

`mcp__serverName__toolName` — 一个名字同时解决冲突（不同服务器同名工具）和路由（从名字提取服务器名）。

### 关键设计

- **JSON-RPC over stdio**：零配置，进程生命周期自动绑定父进程
- **15 秒超时**：MCP 服务器常用 npx 启动，首次需下载包
- **懒连接**：首次 chat 时而非启动时——用户可能只想问快问题
- **配置来源**：settings.json（用户级） + settings.json（项目级） + .mcp.json
- **失败静默**：MCP 连接失败只输出日志，Agent 继续用内置工具

### Agent 集成（仅两处改动）

1. 首次 chat 时 `mcpManager.loadAndConnect()`，MCP 工具追加到 `this.tools`
2. 工具调用路由：`if (this.mcpManager.isMcpTool(name)) return this.mcpManager.callTool(name, input)`

---

## 与 Claude Code 完整对比

| 维度 | Claude Code | Mini Claude Code |
|------|-------------|------------------|
| 定位 | 生产级编程智能体 | 教学/最小可用实现 |
| 工具数量 | 66+ 内置工具 | 13 个 |
| 工具执行 | 并发 + streaming 早期启动 | 并行 + streaming 早期启动 |
| API 后端 | 仅 Anthropic | Anthropic + OpenAI 兼容 |
| 上下文管理 | 5 级压缩流水线 | 4 层 + 大结果持久化 |
| 权限系统 | 7 层 + AST 分析 | 5 模式 + 声明式规则 + 正则 |
| 编辑验证 | 14 步流水线 | 引号容错 + 唯一性 + mtime + diff |
| 记忆系统 | 4 类型 + 语义召回 | 4 类型 + 语义召回 + 异步预取 |
| 技能系统 | 6 源 + inline/fork | 2 源 + inline/fork |
| 多 Agent | Sub-Agent + Coordinator + Swarm | Sub-Agent（3 内置 + 自定义） |
| MCP 集成 | mcpClient.ts + 动态工具发现 | JSON-RPC over stdio |
| 代码量 | 50 万+ 行 | ~4300 行（TS）/ ~3800 行（Python） |

---

## 未实现的能力

| 能力 | 预计代码量 | 未实现原因 |
|------|-----------|-----------|
| Hooks 系统 | ~300 行 | 核心挑战在发现/加载/错误隔离，非 Agent 原理问题 |
| Coordinator/Swarm | ~500-600 行 | 更多是 prompt engineering 问题 |
| LSP 集成 | ~1000 行 | 需管理 LSP 服务器进程，环境障碍高 |
| Prompt Caching | ~30 行 | 上线应第一个加，投入产出比最高 |
| Bash AST 安全分析 | ~600 行 | tree-sitter 是 C/C++ 原生库 |

---

## 渐进式增强路线图

### 第一阶段（1-2 天）：性能优化
- **Prompt Caching**（~30 行）：给系统提示词静态部分加 `cache_control` 标记

### 第二阶段（3-5 天）：可扩展性
- **Hook 系统**（~300 行）：command hook，spawn 子进程传 JSON
- **Tool 类型系统**（~200 行）：从 switch/case 到插件化 Tool 接口

### 第三阶段（1-2 周）：可靠性与安全
- **7 种错误恢复**（~400 行）：PTL 自动压缩重试、API 过载指数退避
- **Bash AST 安全分析**（~600 行）：tree-sitter 解析 23 项检查

### 第四阶段（2-4 周）：高级能力
- **Coordinator**（~500 行）、**Swarm**（~600 行）、**LSP 集成**（~1000 行）

---

## 运行命令速查

```bash
npm start                    # 交互式 REPL
npm start -- --resume        # 恢复上次会话
npm start -- --yolo          # 跳过安全确认
npm start -- --plan          # Plan 模式
npm start -- --accept-edits  # 自动批准编辑
npm start -- --dont-ask      # CI 模式
npm start -- --max-cost 0.50 # 费用限制
npm start -- --max-turns 20  # 轮次限制
```

## REPL 命令

| 命令 | 功能 |
|------|------|
| `/clear` | 清空对话历史 |
| `/cost` | 显示累计 token 用量和费用 |
| `/compact` | 手动触发对话压缩 |
| `/memory` | 列出所有已保存的记忆 |
| `/skills` | 列出可用的技能 |
| `/<skill>` | 调用已注册的技能 |

## 相关链接

- GitHub: https://github.com/Windy3f3f3f3f/claude-code-from-scratch
- 在线文档: https://diwang.info/claude-code-from-scratch/

---
date: 2026-04-13
tags: [学习, AI, 开发流程, 自动化, OpenClaw]
type: 学习笔记
category: AI工具
source: dev-workflow-kit-main.zip
difficulty: 高级
title: "Dev-Workflow Kit 学习笔记"
---

# Dev-Workflow Kit 学习笔记

## 概述

Dev-Workflow Kit 是一个基于 OpenClaw 实现的 **AI 辅助开发工作流套件**，将软件开发全流程（需求分析 → 技术方案 → 编码 → 审查 → 部署）自动化编排。包含 17 个独立 skills，按需求复杂度自动匹配 L1/L2/L3 三级流程。

## 核心概念

### 1. 架构设计

#### 三层加载机制
1. **元数据层**（常驻上下文）：每个 skill 的 `name` + `description`（约 100 词）
2. **指令层**（触发时加载）：SKILL.md 正文，包含完整的执行步骤和流程定义
3. **资源层**（按需读取）：`references/` 目录下的参考文档和 `scripts/` 目录下的脚本

#### 设计原则
- **松耦合**：每个 skill 独立可用，dev-workflow 只是编排层
- **文件驱动**：skill 间仅通过文件的**本地绝对路径**流转，禁止传递摘要
- **质量内建**：规格设计阶段并行产出，编码阶段同步写单测
- **最少卡点**：只在真正需要人工判断的节点暂停
- **凭证安全**：产出物中禁止写入密码/Token/密钥

### 2. 三级流程

#### L1 快速修复（5-10 分钟）
```
IF 改动点 ≤ 3 且行数 ≤ 10:
    → L1-Lite（主 Agent 直接改代码，沙盒初始化豁免）
ELSE:
    → L1-Standard（委派 coding-agent subagent）
```

**流程**：分支检查 → 编码 → code-review → 部署 → 自测 → 提测交接 → 知识沉淀（轻量）

**卡点**：1 个（提测确认）

#### L2 标准功能
```
1. 需求分析（requirement-analysis）
2. 规格设计（tech-spec + test-spec 并行）→ [规格确认卡点]
3. 编码与测试（coding-agent）
4. 代码审查（code-review，不通过则 bugfix 循环）
5. 部署到测试环境
6. 自测验证（test-executor）
7. 提测交接（qa-handoff）→ [提测确认卡点]
8. 知识沉淀
9. 上线收尾
```

**卡点**：2 个（规格确认、提测确认）

#### L3 复杂功能
与 L2 相同，但：
- 知识沉淀更完整（含 ADR 架构决策记录）
- 增加 **需求澄清卡点**（requirement-clarification）

**卡点**：3 个（需求澄清、规格确认、提测确认）

### 3. 核心 Skills（17 个）

#### 编排层
- **using-dev-workflow**：入口 skill，必须在任何开发任务前调用
- **dev-workflow**：总编排器，按需求复杂度自动分派 L1/L2/L3 流程

#### 需求阶段
- **requirement-analysis**：将原始需求转换为结构化需求文档
- **confluence**：拉取 Confluence/Wiki 文档内容

#### 规格设计阶段
- **tech-spec**：基于结构化需求生成技术方案
- **test-spec**：基于结构化需求生成测试用例
- **yapi**：YAPI 接口文档管理

#### 编码阶段
- **coding-agent**：基于技术方案生成功能代码并同步编写单元测试

#### 审查阶段
- **code-review**：代码审查，不通过则触发 bugfix 循环

#### 测试阶段
- **test-executor**：执行自测（API 测试/远程 API 测试/联调测试）

#### 部署阶段
- **jenkins**：触发 Jenkins 构建

#### 提测阶段
- **qa-handoff**：提测交接（YAPI 同步、提测单生成、邮件通知）

#### 知识管理
- **knowledge-init**：为项目生成知识库（概述、代码地图、库表摘要、业务流程）
- **knowledge-deposit**：需求完成后增量沉淀开发经验

#### 其他
- **git-commit**：生成符合 Conventional Commits 规范的提交信息
- **send-email**：发送邮件（支持 SMTP）
- **retro**：生成复盘报告

### 4. 状态管理

#### 状态文件
位置：`{需求目录}/.workflow-state.json`

核心字段：
- `level`：流程级别（L1/L2/L3）
- `currentPhase`：当前阶段
- `phases`：各阶段状态（pending/in_progress/completed/failed/rolled_back）
- `checkpoints`：卡点确认状态
- `services`：涉及的服务列表
- `auditLog`：审计日志

#### 状态更新命令
```bash
# 通过脚本更新，禁止直接编辑 JSON
STATE_CMD="python3 scripts/sandbox_state.py --sandbox-dir {sandboxDir}"

# 阶段流转
$STATE_CMD update-phase --phase requirement-analysis --status in_progress
$STATE_CMD update-phase --phase requirement-analysis --status completed --output "specs/结构化需求.md"

# 添加服务
$STATE_CMD add-service serviceId=finance-trade serviceName=finance-trade \
  gitUrl=https://code.qschou.com/finance/finance-trade.git \
  localPath=/path/to/repo branch=feature/xxx

# 设置卡点
$STATE_CMD set-checkpoint --name spec-confirmation --status confirmed
```

### 5. 编码阶段的三层降级策略

```
Layer 1: tmux + CLI（可监控、可纠偏）
  ↓ tmux 不可用
Layer 2: exec 后台 + CLI（可看日志、不能纠偏）
  ↓ 所有 CLI 都不可用
Layer 3: Native 模式（subagent 用 read/write/exec 直接改代码）
```

**CLI 优先级**：`claude` → `codex` → `cursor-agent` → `gemini` → `opencode`

### 6. 需求分析质量把控

#### 风险预判 Checklist（6 项必检）
1. **新增字段全链路**：从数据入口到最终展示/导出，每个环节都覆盖了吗？
2. **新旧兼容性**：旧数据、旧模板、旧接口的用户怎么办？
3. **工具方法兼容性**：现有的掩码、校验、格式化等通用方法是否能正确处理新值？
4. **数据时间偏移**：定时任务的执行时间和数据的实际落表时间是否一致？
5. **多通道互斥**：同一业务对象的多种处理路径之间是否互斥？
6. **跨系统字段语义**：同名或相似字段在不同系统中含义是否一致？

#### 歧义检测 Checklist（8 项必检）
1. 多对多关系不明确
2. 回调/通信机制未定义
3. 异常场景未覆盖
4. 边界条件未定义
5. 状态转移不完整
6. 数据来源不明确
7. 触发时机不明确
8. 权限与隔离不明确

#### 待确认项质量红线
- **必须带决策选项**：给出 2-3 个具体方案供选择
- **必须标明不确认的后果**：说清楚不确认会导致什么
- **必须关联下游影响**：标注影响技术方案的哪个模块
- **P0 必须当场确认**：P0 问题不确认则停止流程

## 关键要点

### 1. 核心执行规则
1. **code-review 不通过时触发 bugfix 循环，不跳过**
2. **状态更新必须通过 `sandbox_state.py`，禁止直接编辑 `.workflow-state.json`**
3. **角色分离**：编排层禁止直接编码（L1-Lite 除外），所有编码委派给 coding-agent subagent
4. **沙盒强制**：流程入口必须通过 `sandbox_init.py` + `sandbox_verify.py` 初始化并校验沙盒
5. **执行隔离**：tech-spec、test-spec、coding-agent、code-review 作为 subagent 执行（上下文隔离）
6. **验证优先**：任何声称"完成"前，必须先运行验证命令并展示输出

### 2. 文件流转规则
| 文件 | 谁写 | 谁读 |
|------|------|------|
| 结构化需求.md | requirement-analysis | 所有下游 |
| 技术方案.md | tech-spec | coding-agent、code-review、qa-handoff |
| 测试用例.md | test-spec | coding-agent、test-executor |
| ddl.sql | tech-spec | DBA、部署阶段 |

**传递规则**：禁止传递文件内容摘要，只传本地绝对路径。子任务自行 `read` 读取完整文件。

### 3. 本地验证门禁
code-review 通过后、git commit 前执行：
```
Java:  mvn compile -q -DskipTests && mvn test
Go:    go build ./... && go test ./...
Vue:   npm run build && npm test
```

### 4. 编码权限边界
| 允许 | 禁止 |
|------|------|
| 读写 `code/<项目名>` 下 Worktree 代码 | 修改主工作区代码 |
| 执行单元测试、代码格式化 | 执行数据库变更、安装新依赖 |
| 在 feature 分支提交代码 | 在 test/master/main 分支写操作 |
| `git rebase master` | `git merge test`（反向合并） |

## 实践示例

### 1. 初始化需求沙盒
```bash
# 初始化沙盒
python3 scripts/sandbox_init.py \
  --name "jd-chargeback-alert" \
  --jira-id FINANCE-1475 \
  --level L2 \
  --knowledge-root /path/to/dev-knowledge

# 校验沙盒完整性
python3 scripts/sandbox_verify.py \
  --sandbox-dir ~/dev-workspace/feature-20260413-jd-chargeback-alert
```

### 2. 断点续跑
```bash
# 读取状态文件
cat ~/dev-workspace/feature-xxx/.workflow-state.json

# 恢复流程
# 1. 检查 currentPhase
# 2. 检查该阶段 status：
#    - completed → 进入下一阶段
#    - in_progress → 检查产出物完整性，决定续跑或重做
#    - failed → 检查 retryLog，决定重试或等人工
#    - rolled_back → 检查 changeHistory，从回退目标阶段开始
```

### 3. 触发开发流程
```
用户输入："开始需求开发，需求文档在 /path/to/需求.docx"

AI 动作：
1. 调用 using-dev-workflow skill
2. 调用 dev-workflow skill
3. 判定流程级别（L1/L2/L3）
4. 初始化沙盒
5. 进入需求分析阶段
```

## 常见问题 / 坑点

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| AI 跳过了某个阶段 | 认为任务太简单 | 强制指定级别：`--level L2` |
| 编码跑偏 | AI 自行决策架构 | 偏离检测：`drift_detect.py` |
| CLI 启动失败 | tmux 未安装 | 自动降级到 Layer 2 或 Layer 3 |
| 状态文件损坏 | 直接编辑 JSON | 使用 `sandbox_state.py` 更新 |
| 知识库找不到 | 路径配置错误 | 设置 `DEV_KNOWLEDGE_ROOT` 环境变量 |
| 多服务并行冲突 | 改动有交叉引用 | 自动合并为串行任务 |

## 适用场景分析

### ✅ 适合的场景
1. **中大型企业**：有完善的研发流程、CI/CD、测试环境
2. **成熟团队**：团队成员有丰富的软件工程经验
3. **复杂业务系统**：需要严格的需求分析、技术方案、代码审查
4. **长期维护项目**：需要知识沉淀和经验复用

### ❌ 不适合的场景
1. **初创团队**：流程太重，影响快速迭代
2. **小项目/原型开发**：过度工程化
3. **非技术团队**：需要理解完整的软件工程流程
4. **快速试错场景**：流程卡点会拖慢节奏

## 关联知识

- [[AI 编程工具对比]]
- [[软件工程最佳实践]]
- [[Git 工作流]]
- [[CI/CD 流程设计]]

## 参考资源

- 项目来源：dev-workflow-kit-main.zip
- 相关文档：
  - `README.md` - 项目介绍
  - `docs/faq.md` - 常见问题
  - `skills/*/SKILL.md` - 各 skill 详细说明
  - `skills/*/references/` - 参考文档和模板

## 学习时间

| 阶段   | 时间         | 备注          |
| ---- | ---------- | ----------- |
| 初次学习 | 2026-04-13 | 解压并详细阅读项目文档 |
| 深入理解 |            |             |
| 实战应用 |            |             |
| 复习回顾 |            |             |

---

**状态**: 📖 已掌握  
**下次复习日期**: 2026-05-13

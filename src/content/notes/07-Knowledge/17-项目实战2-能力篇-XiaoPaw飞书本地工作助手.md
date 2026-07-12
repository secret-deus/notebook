---
date: 2026-04-10
tags: ["XiaoPaw", "飞书", "工作助手", "Multi-Agent", "企业级应用"]
type: 学习笔记
category: AI工程
source: 极客时间《企业级多智能体设计实战》第17讲
difficulty: 高级
title: "17-项目实战2-能力篇-XiaoPaw飞书本地工作助手"
---

# 17｜项目实战2：能力篇——XiaoPaw飞书本地工作助手

## 概述

XiaoPaw（小爪子）是一个部署在飞书的企业级AI工作助手，能够接收文件、调度定时任务、通过沙盒执行代码。它是第12-16课工具设计经验的完整落地。

**项目地址**：https://github.com/kid0317/xiaopow

## 核心概念

### 1. 两个真实场景演示

**场景一：Excel数据分析报告**
- 用户在飞书给XiaoPaw发Excel文件+一句话："帮我分析这份饮食数据，写成报告发到飞书文档"
- XiaoPaw自动保存文件到沙盒 → 激活xlsx Skill → AI用pandas分析 → 生成图表和洞察 → 调用feishu_ops Skill写入飞书文档
- 几十秒后，飞书文档链接出现在对话框

**场景二：每日股票分析推送**
- 用户说："每天早上九点，帮我分析茅台和腾讯的股价走势，发消息给我"
- XiaoPaw理解这是定时任务 → 写入`cron/tasks.json` → 注册cron表达式`0 9 * * *`
- 每天上午九点自动触发分析并推送结果

### 2. 为什么选择飞书？

**企业级生态复利效应**：
- **数据闭环**：IM + 文档 + 表格 + 日历 + 审批，工作流不跳平台
- **开放平台成熟**：完整的RESTful API + WebSocket推送
- **用户习惯**：用户已在飞书工作，无需切换工具

### 3. 两层MAS架构

| 层级 | 职责 | 特点 |
|------|------|------|
| **主Crew** | 极简路由Agent | 理解用户意图，路由到对应Skill，不执行具体任务 |
| **Sub-Crew** | 按需创建执行 | 每个Skill独立创建，上下文隔离，执行完即销毁 |

**上下文隔离**：第3课理论的实际落地，主Agent上下文始终保持精简。

### 4. 集成的9个Skills

| Skill | 能力 | 场景 |
|-------|------|------|
| xlsx | Excel数据处理分析 | 数据分析报告 |
| pdf | PDF解析与提取 | 文档处理 |
| docx | Word文档操作 | 报告生成 |
| feishu_ops | 飞书文档/表格/消息操作 | 结果输出 |
| web_search | 网络搜索 | 信息获取 |
| stock_analysis | 股票数据分析 | 投资分析 |
| email | 邮件收发 | 邮件通知 |
| calendar | 日历管理 | 日程安排 |
| code_exec | 代码执行（沙盒） | 复杂计算 |

### 5. Runner + Session设计

**per-routing_key串行**：
- 每个飞书会话（单聊/群聊）有独立的Session
- 同一会话内消息串行处理，保证上下文连续性
- 不同会话之间完全隔离

**Session状态管理**：
- Session文件：`{session_id}_ctx.json`（压缩快照）
- 原始历史：`{session_id}_raw.jsonl`（append-only）

### 6. Cron定时任务系统

**设计特点**：
- 支持三种调度模式：固定时间点、固定间隔、cron表达式
- 热重载：检测`tasks.json`变化自动重新加载
- 复用Runner管道：定时任务和用户消息走相同处理链路

```python
# Cron调度示例
{"schedule": {"kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Shanghai"}}
```

**触发流程**：
1. CronService构造`is_cron=True`的InboundMessage
2. 调用`runner.dispatch()`进入处理管道
3. Agent执行分析任务 → 调用feishu_ops发送结果

### 7. 进程启动与依赖注入

**启动序列**（main.py）：
1. 读取config.yaml配置
2. 初始化日志 + Prometheus指标
3. 构建飞书HTTP Client
4. 初始化SessionManager、FeishuSender等
5. **安全关键**：凭证写入沙盒.config目录，LLM永远看不到
6. 构建agent_fn工厂
7. 构建Runner（注入agent_fn）
8. 启动CronService（注入runner.dispatch）
9. 并行启动所有服务

**依赖链**：
```
agent_fn → sender
runner → agent_fn
cron_svc → runner.dispatch
```

## 关键要点

1. **极简主Crew**：主Agent只做路由，不执行具体任务
2. **Skill即服务**：每个Skill是独立的Sub-Crew，按需创建
3. **飞书生态闭环**：IM、文档、表格一体化，数据不跳出平台
4. **安全设计**：敏感凭证写沙盒，AI接触不到
5. **热重载定时任务**：无需重启进程即可添加/修改定时任务

## 实践示例

### 飞书消息处理流程
```python
# 1. 接收飞书消息
inbound = InboundMessage(
    routing_key=chat_id,  # 单聊/群聊ID
    content=user_message,
    msg_id=msg_id,
)

# 2. Runner路由到主Agent
response = await runner.dispatch(inbound)

# 3. 主Agent判断需要xlsx Skill
skill_task = SkillTask(
    skill_name="xlsx",
    task_context="分析饮食数据并生成报告"
)

# 4. 创建Sub-Crew执行
sub_crew = build_skill_crew("xlsx", skill_instructions)
result = await sub_crew.kickoff(skill_task)

# 5. Sub-Crew调用feishu_ops输出
feishu_task = FeishuTask(
    operation="create_doc",
    title="饮食数据分析报告",
    content=result
)
```

### Cron任务定义
```json
{
  "tasks": [
    {
      "id": "morning_stock_report",
      "schedule": {
        "kind": "cron",
        "expr": "0 9 * * *",
        "tz": "Asia/Shanghai"
      },
      "payload": {
        "routing_key": "user_123",
        "message": "分析茅台和腾讯股价"
      }
    }
  ]
}
```

## 常见问题/坑点

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| Session上下文混乱 | 多个会话消息混在一起 | per-routing_key串行，会话完全隔离 |
| 定时任务不触发 | CronService未正确加载 | 检查tasks.json格式，查看日志 |
| 沙盒执行失败 | 依赖包未预装 | Docker镜像预装常用包，Skill文档明确说明 |
| 飞书API限流 | 调用频率过高 | 添加限流和重试机制 |
| 敏感信息泄露 | API Key写在代码里 | 写入沙盒.config，AI接触不到 |

## 关联知识

- [[14-MCP协议-标准化定义工具接口]]：MCP集成
- [[15-王牌超能力-代码解释器与无头浏览器]]：沙盒使用
- [[16-Skills生态-让Agent接入大量工具]]：Skill设计与执行
- [[18-从Prompt到Harness-记忆与上下文的设计范式]]：上下文管理

## 参考资源

- XiaoPaw项目：https://github.com/kid0317/xiaopow
- 飞书开放平台：https://open.feishu.cn/
- FastAPI基础框架：https://github.com/kid0317/fastapi_base

## 学习时间

- 课程时长：40:09
- 笔记整理：2026-04-10

## 状态

- [x] 课程学习
- [ ] 项目部署
- [ ] Skill定制开发

## 下次复习日期

2026-04-17

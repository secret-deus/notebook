---
date: 2026-04-10
tags: ["Skills", "Agent能力", "MCP", "Claude Code", "工具生态"]
type: 学习笔记
category: AI工程
source: 极客时间《企业级多智能体设计实战》第16讲
difficulty: 高级
title: "16-Skills生态-让Agent接入大量工具"
---

# 16｜Skills生态：让Agent接入大量工具

## 概述

Skills的出现是为了让Agent不光能用工具，还能"按说明书用工具"。将高阶能力模块化，让Agent团队不仅有武器，还有一套传承的"武功秘籍"。

## 核心概念

### 1. Skills的本质

**不是**：API、MCP Server、插件格式
**是**：给LLM读的结构化操作手册

**类比**：就像新员工入职时HR给的操作手册——"处理客户退款时，第一步先核实订单状态，第二步……"

**底层哲学：Bash is All You Need**

Claude Code底层只有4个工具：
- read：读文件
- write：写文件  
- edit：编辑文件
- bash：执行命令行

**Skills vs MCP的区别**：
- MCP：预先封装能力成API → Agent调用 → 执行
- Skills+Shell：把"怎么做"写成操作手册 → Agent按手册自己写代码 → bash执行

### 2. 一个完整的Skill组成

```
skill-name/
├── SKILL.md              # 操作手册（必须）
├── scripts/              # 执行脚本（可选）
│   ├── extract.py
│   └── utils.py
├── references/           # 参考资料（可选）
│   └── advanced-guide.md
└── tests/                # 测试用例（可选）
    └── test_skill.py
```

**SKILL.md结构**：
- Overview：适用场景、核心能力
- 操作流程：步骤1、步骤2……
- 边界条件：能做什么、不能做什么
- 异常处理：报错时怎么办
- 示例：输入 → 处理 → 输出

### 3. 两类Skill

| 类型 | 说明 | 执行方式 |
|------|------|---------|
| **参考型** | 给主Agent读的参考资料，类似RAG | 直接读取内容 |
| **任务型** | 需要单独执行的能力，创建Sub-Crew | 创建独立Agent执行 |

### 4. 渐进式披露机制

**问题**：Skills库很大（100+ Skills），全部塞进主Agent上下文会爆炸

**解决方案**：
1. **启动时**：只加载`load_skills.yaml`元数据（名称+一句话描述）
2. **调用时**：主Agent判断需要哪个Skill，只加载该Skill的完整内容
3. **执行时**：任务型Skill创建Sub-Crew，在隔离上下文中执行

### 5. Skill工具实现

**核心代码位置**：https://github.com/kid0317/crewai_mas_demo

**SkillTool设计**：
- 继承`BaseTool`，暴露`_run`和`_arun`
- 用`PrivateAttr`声明`_skill_registry`（Pydantic V2兼容）
- 用`field_validator`处理LLM传来的JSON对象
- 约束放在Field description而非backstory

**Sub-Crew工厂**：
```python
def build_skill_crew(skill_name: str, skill_instructions: str) -> Crew:
    """工厂函数，每次调用返回全新实例"""
    sandbox_mcp = MCPServerHTTP(
        url=SANDBOX_MCP_URL,
        tool_filter=SANDBOX_TOOL_FILTER,  # 白名单过滤
    )
    
    skill_agent = Agent(
        role=f"{skill_name.upper()} Skill 执行专家",
        backstory=f"你掌握以下操作规范：\n\n{skill_instructions}",
        mcp_servers=[sandbox_mcp],
    )
    
    return Crew(agents=[skill_agent], tasks=[...])
```

### 6. Skill与MCP的关系

| 维度 | Skill | MCP |
|------|-------|-----|
| 定位 | 知识层（说明书） | 能力层（工具实现） |
| 内容 | 操作流程、经验、约束 | 具体工具API |
| 灵活性 | 自然语言描述复杂逻辑 | JSON Schema限制 |
| 代码生成 | 现场写代码 | 预封装好的API |

**协作模式**：
- Skill负责"按什么步骤、用什么工具"
- MCP负责"提供可用的原子能力"
- Skill调用MCP工具完成复杂任务

### 7. 企业级Skill管理

**四要素**：
1. **命名规范**：`{动词}-{名词}`，如`parse-pdf`、`generate-report`
2. **Review流程**：新Skill提PR，工程师+安全工程师双Review
3. **版本管理**：`load_skills.yaml`进Git，可回滚
4. **使用统计**：埋点记录调用次数、成功率，定期清理僵尸Skill

## 关键要点

1. **Skill是操作手册**：不是API，是给LLM读的结构化文档
2. **渐进式披露**：启动只加载元数据，调用时才加载完整内容
3. **Sub-Crew隔离**：任务型Skill在独立上下文中执行，不影响主Agent
4. **Skill+MCP协作**：Skill负责知识，MCP负责能力
5. **严格命名规范**：避免相似Skill并存导致路由混乱

## 实践示例

### SKILL.md示例（parse-pdf）
```markdown
# parse-pdf Skill

## Overview
解析PDF文件，提取文字内容。支持文字层直接提取和OCR扫描识别。

## 操作流程
1. 检测PDF是否有文字层（用PyPDF2快速检测）
2. 有文字层：使用pypdf提取
3. 无文字层：使用OCR（Tesseract）识别
4. 中文内容注意编码问题，优先用pdfplumber

## 边界条件
- 支持：PDF、扫描PDF
- 不支持：加密PDF（需先解密）、损坏PDF

## 异常处理
- 乱码：尝试pdfplumber替代pypdf
- OCR失败：检查图片清晰度，提示用户

## 示例
输入：data/report.pdf（扫描件）
处理：检测到无文字层 → OCR识别
输出：{"content": "提取的文字内容..."}
```

### load_skills.yaml
```yaml
skills:
  parse-pdf:
    enabled: true
    type: task  # task 或 reference
    description: 解析PDF文件，支持文字层提取和OCR识别
    
  generate-report:
    enabled: true
    type: task
    description: 基于数据生成结构化报告
```

## 常见问题/坑点

| 反模式 | 后果 | 解决方案 |
|--------|------|---------|
| 大量相似Skill并存 | 主Agent路由随机化，行为不一致 | 统一命名规范，定期清理 |
| 不加审查信任外部Skill | 恶意SKILL.md劫持路由，脚本外传数据 | Review流程，检查scripts/权限 |
| SKILL.md超过500行 | LLM注意力衰减，底部约束被忽略 | 按类型拆分，每个200行以内 |
| 引用链超过两层 | 第三层文件永远不会被读取 | 扁平化引用结构 |
| 让模型动态生成所有代码 | 结果不稳定、Token消耗大 | 能沉淀成脚本的优先预制 |

## 关联知识

- [[14-MCP协议-标准化定义工具接口]]：MCP与Skills的协作
- [[15-王牌超能力-代码解释器与无头浏览器]]：沙盒工具的使用
- [[17-项目实战2-能力篇-XiaoPaw飞书本地工作助手]]：Skills在实战中的应用

## 参考资源

- 课程源码：https://github.com/kid0317/crewai_mas_demo
- XiaoPaw项目：https://github.com/kid0317/xiaopaw
- Claude Code Skills：https://docs.anthropic.com/en/docs/skills

## 学习时间

- 课程时长：66:26
- 笔记整理：2026-04-10

## 状态

- [x] 课程学习
- [ ] Skill开发实践
- [ ] Skills库管理

## 下次复习日期

2026-04-17

---
date: 2026-04-10
tags: ["Bootstrap", "剪枝", "压缩", "上下文生命周期", "CrewAI Hook"]
type: 学习笔记
category: AI工程
source: 极客时间《企业级多智能体设计实战》第19讲
difficulty: 高级
title: "19-上下文的生命周期-Bootstrap剪枝与压缩"
---

# 19｜上下文的生命周期：Bootstrap、剪枝与压缩

## 概述

Agent的上下文在运行过程中有哪些时刻可以干预？这些时刻就是上下文的生命周期节点。用CrewAI的backstory注入做Bootstrap，用`@before_llm_call` Hook在模型调用前实现剪枝和压缩。

## 核心概念

### 1. 上下文生命周期的本质

**Workflow vs Agent的区别**：
- **Workflow**：上下文直接写的，每一步message list在代码里显式构建，完全可控
- **Agent**：上下文是"生长"出来的，ReAct循环中模型自己决定调什么工具，工具返回自动塞进message list

**生命周期的本质**：在ReAct循环中能够干预上下文的**时机窗口**

**六个节点**：
1. **Bootstrap**（启动时）：通过Agent的backstory注入system prompt
2. **剪枝/压缩**（每次LLM调用前）：通过`@before_llm_call` Hook拦截messages
3. 工具调用前（③）：CrewAI暂未细粒度支持
4. 工具返回后（④）：CrewAI暂未细粒度支持
5. Task开始前（⑤）：CrewAI暂未细粒度支持
6. Task结束后（⑥）：CrewAI暂未细粒度支持

### 2. 不干预会怎样？

**三种生产级崩溃**：

| 崩溃类型 | 表现 | 根因 |
|---------|------|------|
| **上下文溢出** | Token超限，API报错 | 只加不减，无限增长 |
| **注意力稀释** | 回答质量下降，关键信息被忽略 | Context Rot，超过40%警戒线 |
| **成本失控** | 账单暴涨 | O(n²)复杂度，上下文翻倍成本翻4倍 |

### 3. Bootstrap预加载

**实现方式**：Agent的`backstory`参数

```python
agent = Agent(
    role="助手",
    goal="帮助用户完成任务",
    backstory="""
    你是XiaoPaw，飞书工作助手。
    
    用户画像：
    - 职位：产品经理
    - 偏好：周报格式先汇总再列计划
    
    工作规范：
    1. 收到文件先保存到沙盒
    2. 分析前先确认数据格式
    """  # Bootstrap内容
)
```

**关键设计**：backstory内容会在Agent启动时自动注入为system prompt。

### 4. 剪枝与压缩（@before_llm_call Hook）

**Hook注册**：
```python
from crewai.hooks import before_llm_call
from crewai import CrewBase

@CrewBase
class ContextManagedCrew:
    @before_llm_call
    def manage_context(self, context: LLMCallHookContext) -> None:
        """每次LLM调用前执行"""
        messages = context.messages  # 直接引用，in-place修改
        
        # 1. 检查上下文长度
        total_tokens = estimate_tokens(messages)
        threshold = context.llm.context_window_size * 0.4  # 40%警戒线
        
        if total_tokens > threshold:
            # 2. 执行压缩
            self._compress_messages(messages)
```

**三大操作实现**：

| 操作 | 时机 | 实现方式 |
|------|------|---------|
| **剪枝** | 单次调用前 | 截断中间历史，保留system+最近N轮 |
| **压缩** | 超阈值时 | 用LLM将旧对话摘要成一句话 |
| **快照恢复** | session恢复时 | 加载历史ctx + 追加新消息 |

### 5. 代码实战：ContextManager

**核心实现位置**：`m3l19/m3l19_context_mgmt.py`

**压缩策略**：
```python
def _compress_messages(self, messages: List[Dict]) -> None:
    """压缩旧消息，保留system和最近2轮"""
    # 保留system消息
    system_msgs = [m for m in messages if m.get("role") == "system"]
    
    # 保留最近2轮对话（4条消息：user-assistant-user-assistant）
    recent = messages[-4:] if len(messages) >= 4 else messages
    
    # 中间部分压缩成摘要
    middle = messages[len(system_msgs):-4]
    if middle:
        summary = self._summarize_with_llm(middle)
        middle_compressed = [{"role": "system", "content": f"历史摘要：{summary}"}]
    
    # 替换messages（in-place）
    messages.clear()
    messages.extend(system_msgs + middle_compressed + recent)
```

**Session恢复**：
```python
def _restore_session(self, context: LLMCallHookContext) -> None:
    """用历史ctx替换context.messages + 追加新user消息"""
    history = load_session_ctx(self.session_id)
    self._history_len = len(history)
    
    # 提取当前轮user消息
    current_user_msg = next(
        (m for m in reversed(context.messages) if m.get("role") == "user"),
        {},
    )
    
    # 替换：历史 + 新user消息 → Agent看到连续上下文
    context.messages.clear()
    context.messages.extend(history)
    if current_user_msg:
        context.messages.append(current_user_msg)
```

### 6. @before_llm_call Hook底层机制

**注册流程**：
1. **标记检测**：装饰器在方法上打`is_before_llm_call_hook`标记
2. **自动注册**：`@CrewBase`的`_register_crew_hooks()`扫描并注册
3. **作用域绑定**：绑定到当前Crew实例，天然隔离
4. **触发执行**：executor调用LLM前遍历执行，传入`LLMCallHookContext`
5. **in-place生效**：`context.messages`是executor内部列表的直接引用

**LLMCallHookContext可用信息**：
```python
context.messages    # List[dict], mutable, in-place修改
context.agent       # 当前Agent对象
context.task        # 当前Task
context.crew        # Crew实例
context.llm         # LLM实例（可读context_window_size）
context.iterations  # 当前迭代次数
```

## 关键要点

1. **六个生命周期节点**：Bootstrap→剪枝/压缩→工具前→工具后→Task前→Task后
2. **CrewAI支持两个关键节点**：Bootstrap（backstory）、剪枝/压缩（@before_llm_call）
3. **in-place修改**：Hook里直接修改`context.messages`，立即对框架可见
4. **40%警戒线**：超过时触发压缩，不要等到快满才处理
5. **Session恢复**：用历史ctx替换messages + 追加新消息，Agent感知不到中断

## 实践示例

### 完整ContextManager实现
```python
from crewai import CrewBase
from crewai.hooks import before_llm_call
from crewai.hooks.types import LLMCallHookContext

@CrewBase
class ManagedCrew:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self._history_len = 0
    
    @before_llm_call
    def context_hook(self, context: LLMCallHookContext) -> None:
        """每次LLM调用前的上下文管理"""
        # 1. Session恢复（首次）
        if self._history_len == 0:
            self._restore_session(context)
        
        # 2. 检查长度
        total_tokens = estimate_tokens(context.messages)
        threshold = context.llm.context_window_size * 0.4
        
        # 3. 超阈值则压缩
        if total_tokens > threshold:
            self._compress_messages(context.messages)
            # 保存压缩后的快照
            save_session_ctx(self.session_id, context.messages)
```

### 运行方式
```bash
cd m3l19 && python3 m3l19_context_mgmt.py

# Session文件（自动生成）：
# ctx  → workspace/sessions/{SESSION_ID}_ctx.json   （压缩快照）
# raw  → workspace/sessions/{SESSION_ID}_raw.jsonl  （原始完整历史）
```

## 常见问题/坑点

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| Hook不生效 | 忘记加`@CrewBase`或方法未标记 | 确保装饰器和基类正确 |
| messages修改不生效 | 不是in-place修改 | 用`clear()`+`extend()`，不要赋值 |
| 压缩后丢失关键信息 | 摘要不够精准 | 保留system和最近N轮，只压缩中间 |
| Session恢复后上下文不连续 | 没有正确追加新消息 | 先提取当前user消息，再替换+追加 |
| 压缩太频繁 | 阈值设置过低 | 40%是经验值，可根据实际情况调整 |

## 关联知识

- [[18-从Prompt到Harness-记忆与上下文的设计范式]]：上下文工程理论框架
- [[17-项目实战2-能力篇-XiaoPaw飞书本地工作助手]]：Session管理实践

## 参考资源

- 课程源码：https://github.com/kid0317/crewai_mas_demo/tree/main/m3l19
- CrewAI Hooks文档：https://docs.crewai.com/concepts/hooks

## 学习时间

- 课程时长：39:19
- 笔记整理：2026-04-10

## 状态

- [x] 课程学习
- [ ] Bootstrap实践
- [ ] 剪枝压缩Hook实现
- [ ] Session管理

## 下次复习日期

2026-04-17

---
date: 2026-04-10
tags: [AI, Agent, Tools, 工具封装, SOP, API改造, 企业级]
type: 学习笔记
category: AI工程
source: 极客时间「企业级多智能体设计实战」第13讲
difficulty: 高级
概述: 从传统API到Agent Tools封装的五步标准SOP，手把手实战百度搜索API的改造
核心概念: [五步SOP, 语义重构, I/O瘦身, Pydantic描述, 建设性异常, 黑盒映射, 搜索结果格式化]
关键要点:
  - 五步SOP：语义重构→I/O瘦身→参数Prompt化→建设性异常→黑盒映射
  - 语义重构：组合原子API，提供目标导向的闭环能力
  - I/O瘦身：剔除冗余字段，保护Token上下文
  - Pydantic描述：用Field充当使用说明书
  - 建设性异常：自然语言包裹错误，激活自我纠错
  - 黑盒映射：极简输入到复杂请求的暗中转换
  - 结果格式化：清晰结构化输出帮助模型理解
实践示例:
  - BaiduSearchTool完整封装
  - Pydantic模型定义搜索参数
  - 错误码映射为自然语言提示
  - 搜索结果格式化输出
常见问题/坑点:
  - 不要将复杂API直接暴露给大模型
  - 避免返回原始JSON让模型自己解析
  - 错误码必须转换为自然语言
关联知识:
  - [[12-工具设计哲学-从API到Agent-Native的范式跃迁]]
  - [[14-MCP协议-标准化定义工具接口]]
参考资源:
  - 课程代码: https://github.com/kid0317/crewai_mas_demo/tree/main/m2l9
学习时间: 34分钟
状态: 已完成
下次复习日期: 2026-04-17
title: "13-自定义工具封装-构建Tools的五步标准SOP"
---

# 13｜自定义工具封装：构建 Tools 的五步标准 SOP

> 讲师：晓寒（前百度资深架构师）
> 课程进度：66%

## 一、课程目标

将成百上千个历史遗留的传统API，平滑改造成大模型能轻松驾驭的**Agent Tools**。

**核心交付物**：五步标准 SOP（Standard Operating Procedure）

---

## 二、五步标准 SOP 全景图

### Step 1：语义完整性重构（聚合与拆解）

**问题所在**：
- 传统后端API是数据驱动、原子化的（CRUD）
- 大模型是目标驱动的

**反例**：
```
❌ 让大模型自己规划：
   1. get_user_by_name(name) → 获取ID
   2. check_permission(id) → 校验权限  
   3. update_user_info(id, info) → 更新信息
```

**SOP动作**：在工具层进行接口聚合

```
✅ 提供语义完整的单一工具：
   update_user_info_by_name(name, info)
   
   内部用Python代码依次调用那三个底层API
```

**原则**：让大模型做它擅长的「意图理解」，让代码做「确定性流转」。

---

### Step 2：I/O 瘦身（降噪增信）

**问题所在**：传统API输入输出包含大量对大模型无意义的元数据

**反例（臃肿的API输入）**：
```json
{
    "messages": [{"content": "北京有哪些旅游景区", "role": "user"}],
    "search_source": "baidu_search_v2",
    "resource_type_filter": [{"type": "web", "top_k": 20}],
    "search_filter": {
        "match": {"site": ["www.weather.com.cn"]},
        "query": {"filter": {"range": {"date": {"gte": "2026-01-01"}}}}
    },
    "search_strategy": "standard_search_v2",
    "top_k": 5
}
```

**SOP动作**：剔除冗余，保留精华

```python
✅ # Agent Tool 极简参数
class BaiduSearchInput(BaseModel):
    """百度搜索工具的输入参数"""
    query: str = Field(
        description="搜索关键词，需要清晰、准确地描述你想要查找的信息"
    )
    top_n: int = Field(
        default=5,
        description="期望返回的搜索结果数量（1-10），默认5条"
    )
```

**要点**：
- 剔除前端无关的元数据（messages, search_source等）
- 核心参数：`query`（关键词）+ `top_n`（数量）
- 其余复杂配置在**黑盒中静默处理**

---

### Step 3：参数 Prompt 化（Pydantic描述）

**核心原则**：参数的`description`不是给程序员看的，是**给大模型看的使用说明书**。

**实战代码**：
```python
from pydantic import BaseModel, Field

class BaiduSearchInput(BaseModel):
    """百度搜索工具的输入参数"""
    
    query: str = Field(
        description="""
        搜索关键词，需要清晰、准确地描述你想要查找的信息。
        如果查询涉及时间、地点等上下文，建议显式包含在查询中。
        例如："2026年北京春节期间的旅游景点推荐" 比 "旅游景点" 效果更好。
        """
    )
    
    top_n: int = Field(
        default=5,
        description="期望返回的搜索结果数量（1-10），默认5条。如果问题较复杂，可适当增加。"
    )
```

**关键技巧**：
- `Field`的`description`要包含**使用场景**和**最佳实践**
- 给出**具体示例**（如"2026年北京春节期间..."）
- 说明**参数约束**（如范围1-10）

---

### Step 4：建设性异常处理（Constructive Error）

**反例（糟糕的错误返回）**：
```
❌ 错误码1001
❌ NullPointerException堆栈
❌ 空字符串""
```
→ 大模型直接懵圈，陷入死循环

**SOP动作**：用自然语言包裹错误，激活自我纠错

**实战代码**：
```python
class BaiduSearchTool(BaseTool):
    def _run(self, query: str, top_n: int = 5) -> str:
        try:
            # ... 调用API ...
            result = call_baidu_api(query, top_n)
            
        except APITimeoutError:
            return """
            错误：搜索服务响应超时。
            原因：可能是网络问题或搜索服务器繁忙。
            解决提示：1) 稍后重试；2) 尝试使用更短、更具体的搜索词。
            """
            
        except Exception as e:
            return f"""
            错误：搜索服务调用失败。
            原因：{str(e)}
            解决提示：检查网络连接，或稍后重试。如果问题持续，请尝试其他工具。
            """
```

**错误码映射示例**：
```python
error_descriptions = {
    "500": "服务调用超时，可能是服务器处理时间过长，请稍后重试或减少请求复杂度",
    "502": "服务响应超时，可能是服务器响应时间过长，请稍后重试或尝试其它工具",
    "216003": "API Key 认证失败，请检查 API Key 是否正确、是否已过期或是否有足够的权限",
}
```

**输出格式**：`错误：xxx
原因：xxx
解决提示：xxx`

---

### Step 5：黑盒映射（极简→复杂）

**核心机制**：在工具内部代码中，完成从极简输入到复杂API请求的暗中转换。

**实战代码（BaiduSearchTool完整示例）**：
```python
from crewai.tools import BaseTool
from pydantic import BaseModel, Field
import requests

class BaiduSearchInput(BaseModel):
    """百度搜索工具的输入参数"""
    query: str = Field(description="搜索关键词，需要清晰、准确地描述你想要查找的信息")
    top_n: int = Field(default=5, description="期望返回的搜索结果数量（1-10），默认5条")

class BaiduSearchTool(BaseTool):
    """百度搜索工具，用于在互联网上搜索信息"""
    name: str = "baidu_search"
    description: str = """
    使用百度搜索引擎在互联网上查找相关信息。
    当你需要获取最新资讯、查找特定知识或验证信息时，请使用此工具。
    输入关键词和期望返回的结果数量，将返回搜索结果的标题、链接和内容摘要。
    """
    args_schema: type[BaseModel] = BaiduSearchInput
    
    def _run(self, query: str, top_n: int = 5) -> str:
        """执行搜索"""
        # ========== 黑盒映射开始 ==========
        
        # 1. 极简输入 → 复杂API请求体
        payload = {
            "messages": [{"content": query, "role": "user"}],
            "search_source": "baidu_search_v2",
            "resource_type_filter": [{"type": "web", "top_k": top_n}],
            "search_strategy": "standard_search_v2",
            "top_k": top_n
        }
        
        # 2. 调用底层复杂API
        headers = {"Authorization": f"Bearer {API_KEY}"}
        response = requests.post(API_URL, json=payload, headers=headers, timeout=30)
        
        # 3. 处理响应
        if response.status_code != 200:
            return f"错误：API返回HTTP {response.status_code}..."
            
        result = response.json()
        
        if result.get("error_code"):
            error_code = result["error_code"]
            error_msg = result.get("error_msg", "未知错误")
            # ... 映射为自然语言提示 ...
            
        # 4. 格式化输出（结构化、易读）
        references = result.get("references", [])
        if not references:
            return "未找到相关结果，建议尝试不同的关键词..."
            
        results = [f"找到 {len(references)} 条搜索结果\n"]
        for i, ref in enumerate(references[:top_n], 1):
            results.append(f"结果{i}: [{ref['title']}] ({ref['url']})\n  内容摘要: {ref['content'][:200]}...\n")
            
        return "\n".join(results)
        # ========== 黑盒映射结束 ==========
```

---

## 三、课程总结

### 五步SOP速记

| 步骤 | 核心动作 | 目的 |
|------|---------|------|
| 1. 语义重构 | 组合原子接口 | 提供目标导向的闭环能力 |
| 2. I/O 瘦身 | 剔除冗余字段 | 保护珍贵的Token上下文 |
| 3. 参数Prompt化 | Pydantic详尽描述 | 手把手教模型使用工具 |
| 4. 建设性异常 | 自然语言包裹错误 | 激活模型的自我纠错能力 |
| 5. 黑盒映射 | 极简→复杂的暗中转换 | 隐藏底层复杂性 |

### 关键收获

1. **任何企业遗留API都能被改造**：ERP、CRM、工单系统的API都能变成大模型的超级武器库
2. **description是关键**：参数的描述质量直接决定工具调用成功率
3. **错误处理必须人话化**：机器错误码对大模型是天书

---

## 四、关联知识

- [[12-工具设计哲学-从API到Agent-Native的范式跃迁]] - 工具设计的底层哲学
- [[14-MCP协议-标准化定义工具接口]] - 业界工具生态标准

---

## 五、参考资源

- **课程代码**: https://github.com/kid0317/crewai_mas_demo/tree/main/m2l9
- **工具基类**: `BaseTool` from `crewai.tools`
- **参数建模**: `BaseModel`, `Field` from `pydantic`

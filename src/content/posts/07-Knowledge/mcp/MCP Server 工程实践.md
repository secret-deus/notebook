---
date: 2026-07-01
tags:
  - mcp
  - ai-agent
  - 协议
  - 工具开发
type: 学习笔记
category: AI工程/MCP
source: https://modelcontextprotocol.io/
difficulty: 高级
title: "MCP Server 工程实践"
---

# MCP Server 工程实践

## 概述

MCP（Model Context Protocol）是 Anthropic 于 2024 年底发布的开放协议，标准化了 AI Agent 与外部工具/资源之间的通信接口。它不是一个框架，而是一份 **JSON-RPC 2.0 协议规范**。kagent 的 Agent 通过 MCP 协议调用工具，Cursor 和 Claude Code 都原生支持 MCP。

> 一句话：MCP 是 AI Agent 的"USB-C 接口"——任何实现 MCP 的 Server 都可以被任何实现 MCP 的 Client 调用。

## 协议核心概念

### 三大原语

| 原语 | 用途 | 类比 |
|------|------|------|
| **Tools** | Agent 可调用的函数 | REST API 的一个 endpoint |
| **Resources** | Agent 可读取的静态数据 | 文件系统中的文件 |
| **Prompts** | 预定义的提示模板 | `/help` 斜杠命令 |

### 传输层

MCP 协议层与传输层解耦，目前支持两种传输方式：

| 传输方式 | 通信模式 | 适用场景 |
|------|------|------|
| **stdio** | 子进程 stdin/stdout | 本地 MCP Server（Cursor/Claude Code 直接启动） |
| **SSE over HTTP** | HTTP POST + SSE 事件流 | 远程 MCP Server（kagent、多租户） |

```
# stdio 模式
Client → spawn → Server Process (stdin/stdout) → JSON-RPC messages

# SSE 模式  
Client → POST → http://mcp-server:8000/message    (请求)
Client ← GET  ← http://mcp-server:8000/sse        (事件流)
```

### 协议生命周期

```
1. Initialize    → Client: 我是谁，支持什么能力
                   Server: 我是谁，提供什么能力
2. List Tools    → Client: 列出所有工具
                   Server: [ {name, description, inputSchema}, ... ]
3. Call Tool     → Client: 调用 tool X，参数 Y
                   Server: 返回结果（或流式返回）
4. List Resources → Client: 列出可读取的资源
5. Read Resource → Client: 读取资源内容
```

### JSON-RPC 消息格式

```json
// 客户端 → 服务端：列出工具
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}

// 服务端 → 客户端：返回工具列表
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "get_pod_logs",
        "description": "Get logs from a Kubernetes pod",
        "inputSchema": {
          "type": "object",
          "properties": {
            "namespace": { "type": "string", "description": "K8s namespace" },
            "pod_name": { "type": "string", "description": "Pod name" },
            "tail_lines": { "type": "integer", "description": "Number of lines", "default": 100 }
          },
          "required": ["namespace", "pod_name"]
        }
      }
    ]
  }
}

// 客户端 → 服务端：调用工具
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_pod_logs",
    "arguments": {
      "namespace": "health",
      "pod_name": "health-ack-7d8f9-abcde",
      "tail_lines": 200
    }
  }
}

// 服务端 → 客户端：返回结果
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "2026-07-01 12:00:00 INFO  Starting application...\n..."
      }
    ]
  }
}
```

## 建造生产级 MCP Server

### Python 最小实现

```python
# server.py
import json
import sys
import subprocess
from typing import Any

def handle_tools_list() -> dict:
    """返回工具列表"""
    return {
        "tools": [
            {
                "name": "get_pod_logs",
                "description": "Get logs from a Kubernetes pod",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "namespace": {"type": "string"},
                        "pod_name": {"type": "string"},
                        "tail_lines": {"type": "integer", "default": 100}
                    },
                    "required": ["namespace", "pod_name"]
                }
            },
            {
                "name": "list_pods",
                "description": "List pods in a namespace",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "namespace": {"type": "string"}
                    },
                    "required": ["namespace"]
                }
            }
        ]
    }

def handle_tools_call(params: dict) -> dict:
    """调用工具"""
    tool_name = params["name"]
    args = params.get("arguments", {})

    if tool_name == "get_pod_logs":
        cmd = [
            "kubectl", "logs",
            "-n", args["namespace"],
            args["pod_name"],
            "--tail", str(args.get("tail_lines", 100))
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return {
            "content": [{"type": "text", "text": result.stdout or result.stderr}],
            "isError": result.returncode != 0
        }

    elif tool_name == "list_pods":
        cmd = ["kubectl", "get", "pods", "-n", args["namespace"], "-o", "wide"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return {
            "content": [{"type": "text", "text": result.stdout or result.stderr}],
            "isError": result.returncode != 0
        }

    else:
        return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}


def main():
    """stdio 传输 MCP Server 主循环"""
    for line in sys.stdin:
        try:
            request = json.loads(line.strip())
        except json.JSONDecodeError:
            continue

        method = request.get("method")
        req_id = request.get("id")

        if method == "initialize":
            response = {
                "jsonrpc": "2.0", "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {"name": "k8s-mcp-server", "version": "1.0.0"},
                    "capabilities": {"tools": {}}
                }
            }
        elif method == "tools/list":
            response = {"jsonrpc": "2.0", "id": req_id, "result": handle_tools_list()}
        elif method == "tools/call":
            response = {"jsonrpc": "2.0", "id": req_id, "result": handle_tools_call(request.get("params", {}))}
        else:
            response = {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "Method not found"}}

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
```

### SSE 传输的生产实现

```python
# sse_server.py —— 生产级 SSE MCP Server
import asyncio
import json
from aiohttp import web

routes = web.RouteTableDef()

# 保存活跃的 SSE 连接
sse_clients = set()

@routes.get("/sse")
async def sse_endpoint(request):
    """SSE 事件流端点"""
    response = web.StreamResponse()
    response.headers["Content-Type"] = "text/event-stream"
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Connection"] = "keep-alive"
    await response.prepare(request)

    sse_clients.add(response)
    try:
        while True:
            # 发送心跳，保持连接
            await response.write(b": heartbeat\n\n")
            await asyncio.sleep(15)
    except ConnectionResetError:
        pass
    finally:
        sse_clients.discard(response)
    return response

@routes.post("/message")
async def message_endpoint(request):
    """处理 JSON-RPC 请求"""
    body = await request.json()
    method = body.get("method")
    req_id = body.get("id")

    if method == "tools/list":
        result = {"tools": [...]}
    elif method == "tools/call":
        result = await execute_tool(body.get("params", {}))
    else:
        result = None
        error = {"code": -32601, "message": "Unknown method"}
        # 通过 SSE 推送错误
        for client in sse_clients:
            await client.write(
                f"data: {json.dumps({'jsonrpc': '2.0', 'id': req_id, 'error': error})}\n\n".encode()
            )
        return web.json_response({"jsonrpc": "2.0", "id": req_id, "error": error})

    # 通过 SSE 推送结果
    for client in sse_clients:
        await client.write(
            f"data: {json.dumps({'jsonrpc': '2.0', 'id': req_id, 'result': result})}\n\n".encode()
        )

    return web.json_response({"jsonrpc": "2.0", "id": req_id, "result": {"status": "dispatched"}})

async def execute_tool(params):
    """实际执行工具（异步）"""
    try:
        result = await asyncio.wait_for(
            _execute(params), timeout=30
        )
        return result
    except asyncio.TimeoutError:
        return {"content": [{"type": "text", "text": "Tool execution timed out"}], "isError": True}
```

### kagent RemoteMCPServer 声明

部署好 MCP Server 后，在 kagent 中声明它：

```yaml
apiVersion: kagent.dev/v1alpha2
kind: RemoteMCPServer
metadata:
  name: k8s-tool-server
  namespace: kagent
spec:
  description: Produciton K8s tool server (read-only)
  protocol: SSE
  url: http://k8s-mcp-server.kube-system:8000/sse
  sseReadTimeout: 5m0s
  timeout: 30s
```

## 生产级关注点

### 安全

```python
# 1. Authentication —— Token 验证
import hashlib, hmac

def verify_auth(request):
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    expected = os.environ["MCP_AUTH_TOKEN"]
    return hmac.compare_digest(token, expected)  # 防止时序攻击

# 2. Authorization —— 工具级权限
TOOL_PERMISSIONS = {
    "list_pods": ["reader", "admin"],
    "delete_pod": ["admin"],
    "get_pod_logs": ["reader", "admin"],
}

def can_call_tool(tool_name, role):
    return role in TOOL_PERMISSIONS.get(tool_name, [])

# 3. Input validation —— 永远不要信任 Agent 传来的参数
def get_pod_logs(namespace: str, pod_name: str, tail_lines: int = 100):
    # 白名单验证：namespace 和 pod_name 不能包含 shell 元字符
    if not re.match(r'^[a-z0-9]([-a-z0-9]*[a-z0-9])?$', namespace):
        raise ValueError(f"Invalid namespace: {namespace}")
    if not re.match(r'^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$', pod_name):
        raise ValueError(f"Invalid pod name: {pod_name}")
    tail_lines = max(1, min(tail_lines, 10000))  # 夹逼到 [1, 10000]
```

### 限流

```python
import time
from collections import defaultdict

class RateLimiter:
    def __init__(self, max_calls: int = 10, window: float = 1.0):
        self.max_calls = max_calls
        self.window = window
        self.calls = defaultdict(list)

    def allow(self, tool_name: str) -> bool:
        now = time.time()
        self.calls[tool_name] = [t for t in self.calls[tool_name] if now - t < self.window]
        if len(self.calls[tool_name]) >= self.max_calls:
            return False
        self.calls[tool_name].append(now)
        return True
```

### 工具设计的陷阱

| 坑 | 表现 | 正确做法 |
|------|------|------|
| Tool 描述太模糊 | Agent 在多个 tool 间犹豫，频繁"试错" | 每个 tool 的 description 精确描述输入输出和副作用 |
| 一个 Tool 做太多事 | Agent 参数填不对，调用反复失败 | **一个 Tool = 一个明确的动作** |
| Tool 无超时 | Agent 卡住等待 | 所有外部调用（kubectl、API、DB）加超时 |
| 返回值太长 | 撑爆 LLM context window | 支持 `--tail` 等参数来截断，或返回摘要 |
| 无 isError 标记 | Agent 拿错误结果当正反馈继续推理 | `"isError": true` 明确标记失败 |

### 可观测性

```python
import time
import logging

logger = logging.getLogger("mcp-server")

def with_metrics(tool_name: str):
    """装饰器：为工具调用添加日志和指标"""
    def decorator(func):
        def wrapper(*args, **kwargs):
            start = time.time()
            logger.info(f"TOOL_START: {tool_name} args={args} kwargs={kwargs}")
            try:
                result = func(*args, **kwargs)
                duration = time.time() - start
                logger.info(f"TOOL_SUCCESS: {tool_name} duration={duration:.2f}s")
                # TODO: emit Prometheus counter + histogram
                return result
            except Exception as e:
                duration = time.time() - start
                logger.error(f"TOOL_ERROR: {tool_name} duration={duration:.2f}s error={e}")
                raise
        return wrapper
    return decorator
```

## 测试

```python
# 集成测试
import pytest
import json
import subprocess

@pytest.fixture
def mcp_server():
    """启动 MCP Server 作为子进程"""
    proc = subprocess.Popen(
        ["python", "server.py"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        text=True
    )
    # 发送 initialize
    proc.stdin.write(json.dumps({
        "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}}
    }) + "\n")
    proc.stdin.flush()
    response = json.loads(proc.stdout.readline())
    assert response["result"]["serverInfo"]["name"] == "k8s-mcp-server"
    yield proc
    proc.terminate()

def test_tools_list(mcp_server):
    mcp_server.stdin.write(json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}
    }) + "\n")
    mcp_server.stdin.flush()
    response = json.loads(mcp_server.stdout.readline())
    tool_names = [t["name"] for t in response["result"]["tools"]]
    assert "get_pod_logs" in tool_names
    assert "list_pods" in tool_names
```

## 关联知识

- [[../k8s/特性详解/kagent 详解]] — kagent 通过 RemoteMCPServer CRD 集成 MCP
- [[../go/Go 基础速查]] — 生产级 MCP Server 常用 Go 编写（性能 + 并发）
- [[../k8s/特性详解/ArgoCD GitOps 实战]] — MCP Server 的部署通过 ArgoCD 管理
- [[../linux/网络内核参数调优]] — SSE MCP Server 的高并发 TCP 调优

## 参考资源

- MCP 官方规范：https://spec.modelcontextprotocol.io/
- MCP Python SDK：https://github.com/modelcontextprotocol/python-sdk
- MCP 工具列表：https://github.com/modelcontextprotocol/servers
- kagent MCP 集成：https://kagent.dev/docs/kagent/examples/mcp-tools

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 协议与工程实践 | 2026-07-01 | 完成：协议规范、stdio/SSE 实现、安全、限流、可观测性、测试 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-08

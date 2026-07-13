---
date: 2026-06-30
tags:
  - k8s
  - kagent
  - ai-agent
  - cncf
  - mcp
  - a2a
type: 学习笔记
category: 云原生/Kubernetes/AI Agent
source: https://kagent.dev/
difficulty: 高级
title: "kagent 详解"
---

# kagent 详解

## 概述

kagent 是 **CNCF 首个 Kubernetes 原生 AI Agent 框架**（2025.05.22 加入 Sandbox），由 Solo.io（Istio 创始团队）主导开发。它将 AI Agent 定义为 Kubernetes CRD 资源，以「基础设施即代码（IaC）」的方式在生产环境治理 AI Agent 工作负载，让 Agent 像 Pod、Deployment 一样以声明式方式管理。

> 核心理念：**控制面集中代理 + 运行时分布执行**。控制面通过 Controller 协调资源状态，数据面由独立 Pod 执行推理循环。

## 基本信息

| 项目 | 内容 |
|------|------|
| 首次提交 | 2025-01-21 |
| CNCF 等级 | Sandbox（2025-05-22 加入） |
| GitHub Stars | 3,000+ |
| 贡献者 | 100+，贡献组织 900+ |
| 核心语言 | Go（Controller）+ Python（Runtime） |
| 许可证 | Apache 2.0 |
| 仓库 | https://github.com/kagent-dev/kagent |
| 官网 | https://kagent.dev/ |

## 核心理念：Agent = CRD

kagent 的核心创新在于：**把 AI Agent 当作 Kubernetes 一等公民（First-Class Workload）**。这意味着：

- 用 `kubectl apply -f agent.yaml` 创建 Agent
- Agent 自动拥有 Deployment 的副本管理、资源限制、探针检查
- 支持 `kubectl get agents`、`kubectl describe agent` 等原生操作
- 天然继承 K8s 的 RBAC、mTLS、自动扩缩容、故障自愈能力

## 架构总览

```
flowchart TB
  U[用户] --> UI[Web UI（Next.js）]
  UI -->|HTTP + SSE| API[控制器 HTTP Server（Go :8083）]

  subgraph CP[控制面：kagent-controller（Go）]
    API
    CM[Controller Manager（Reconcile CRD）]
    DB[(SQLite / PostgreSQL)]
  end

  API --> DB
  CM -->|Create/Update| K8S[Kubernetes API Server]
  API -->|A2A 代理| SVC[Agent Service]
  SVC --> POD[Agent Pod（Python/Go ADK Runtime）]
  POD -->|MCP tools/call| MCP[MCP Tool Server]
  MCP -->|Result| POD
  POD -->|A2A SSE| API
  API -->|SSE| UI
```

### 组件职责

| 组件 | 运行位置 | 职责 |
|------|---------|------|
| Controller Manager | kagent-controller Pod（Go） | 监听 CRD，将 Agent 翻译为 Deployment/Service/Secret，维护状态与数据库缓存 |
| HTTP Server | kagent-controller Pod（Go） | UI 后端 REST API、A2A 代理转发、MCP 代理转发、认证/授权中间件、可观测性埋点 |
| 数据库层 | kagent-controller Pod 或外部 | SQLite/PostgreSQL 存储会话、对话、工具发现结果，降低对 K8s API 的压力 |
| Agent Runtime | 每个 Agent 独立 Pod（Python/Go） | 启动 A2A Server，管理 Google ADK Runner 生命周期，执行 LLM 循环与工具调用 |
| MCP Tool Server | 独立 Pod | 按 MCP 协议暴露工具发现与调用能力，可被多个 Agent 复用 |
| Web UI | kagent-ui Pod（Next.js） | Agent/模型/工具管理、聊天与流式渲染、HITL 审批交互 |

## 三大核心 CRD 资源模型

kagent 将「模型」、「工具」、「Agent 规格」三者解耦为独立的 CRD，遵循 **"引用优于内联"** 的设计原则。

### Agent（主资源）

定义一个可运行的智能体规格，包含系统提示词、模型引用、工具列表、运行时配置。

**字段路径**：`spec.declarative`

| 参数 | 类型 | 说明 |
|------|------|------|
| `type` | string | `Declarative`（声明式 Agent） |
| `systemMessage` | string | 系统提示词，即 Agent 的行为定义 |
| `modelConfig` | string | 引用 ModelConfig CRD 的名称 |
| `tools` | []ToolBinding | 工具绑定列表，支持 MCP Server 和内置工具 |
| `deployment` | DeploymentSpec | 副本数、资源限制、环境变量等部署配置 |
| `stream` | bool | 是否启用 SSE 流式输出，默认 true |

```yaml
apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: k8s-ops-agent
  namespace: kagent
spec:
  type: Declarative
  description: "Kubernetes 运维助手"
  declarative:
    deployment:
      replicas: 2
      resources:
        requests:
          cpu: "200m"
          memory: "512Mi"
      env:
        - name: OPENAI_API_KEY
          value: placeholder
    modelConfig: gpt4-config
    stream: true
    systemMessage: |-
      # 角色
      你是一个 Kubernetes 运维专家。
      # 规则
      1. 修改集群状态前必须确认
      2. 优先使用只读工具
    tools:
      - type: McpServer
        mcpServer:
          apiGroup: kagent.dev
          kind: RemoteMCPServer
          name: k8s-toolserver
          toolNames:
            - list_pods
            - get_pod_logs
            - describe_resource
```

### ModelConfig

将大模型端点和鉴权凭证从 Agent 规格中抽离，凭证由 Kubernetes Secret 安全管理。

**字段路径**：`spec.openAI`

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | string | 模型名称（如 `gpt-4o`、`qwen-plus`） |
| `provider` | string | 提供商，`OpenAI` / `Anthropic` / `Google` |
| `openAI.baseUrl` | string | API 端点地址 |
| `openAI.apiKey` | string | API Key（直接值或引用 Secret） |

```yaml
apiVersion: kagent.dev/v1alpha2
kind: ModelConfig
metadata:
  name: gpt4-config
  namespace: kagent
spec:
  model: gpt-4o
  provider: OpenAI
  openAI:
    baseUrl: "https://api.openai.com/v1"
    apiKeyRef:
      name: openai-secret
      key: api-key
```

### RemoteMCPServer

定义遵循 MCP（Model Context Protocol）协议的工具服务端点，Controller 自动完成工具发现并缓存。

**字段路径**：`spec`

| 参数 | 类型 | 说明 |
|------|------|------|
| `description` | string | 工具服务器描述 |
| `protocol` | string | 传输协议，`SSE` / `HTTP` |
| `url` | string | MCP Server 端点地址 |
| `sseReadTimeout` | duration | SSE 读取超时 |
| `timeout` | duration | 单次调用超时 |

```yaml
apiVersion: kagent.dev/v1alpha2
kind: RemoteMCPServer
metadata:
  name: k8s-toolserver
  namespace: kagent
spec:
  description: "Kubernetes 只读工具服务"
  protocol: SSE
  url: http://k8s-mcp-server.kube-system:8000/sse
  sseReadTimeout: 5m0s
  timeout: 30s
```

## 关键执行流程：A2A 消息流

1. Web UI 通过 HTTP POST + `Accept: text/event-stream` 请求控制器代理 API
2. 控制器 HTTP Server 将 A2A JSON-RPC 代理转发到对应的 Agent Service
3. Agent Runtime 中的 Executor 接收请求，基于 Google ADK 启动 LLM 循环
4. 若需调用工具，Runtime 主动发起 MCP `tools/call` 请求
5. 获取工具结果 → 注入上下文 → 继续 LLM 推理
6. 中间态和最终结果通过 SSE 事件流回传给控制器 → UI 渲染

## Google ADK：底层执行引擎

Google ADK（Agent Development Kit）是 kagent 每一个独立 Agent Pod 内部的执行引擎，负责真正的「思考与执行」。

### ADK 职责边界

| 层级 | 解决的问题 | 提供的机制 |
|------|-----------|-----------|
| **Google ADK** | Agent 底层执行语义：多轮推理、工具调用、会话/上下文、HITL、A2A 暴露 | Runner 执行引擎、ToolConfirmation 人工确认流、A2A 协议执行器 |
| **kagent** | K8s 原生治理与工程化：CRD 翻译、A2A/MCP 代理、UI/API、持久化缓存 | Controller 管理生命周期，HTTP Server 处理代理转发，Secret 配置注入 |
| **业务 Agent** | 业务方法论与策略：领域提示词、工具选择策略、安全红线 | systemMessage 沉淀经验、toolNames 划定能力边界 |

### ADK 关键能力

- **标准化 Runner 执行器**：自动管理上下文，模型决定工具调用时暂停推理，获取结果后自动注回继续推理
- **原生 MCP 桥接**：将通过 MCP 动态发现的工具转化为 ADK 可识别的函数格式
- **HITL（人工介入）**：通过 `ToolConfirmation` 机制在执行高风险工具前挂起会话，在 UI 上呈现为「审批卡点」
- **A2A 协议暴露**：原生支持将智能体推理能力封装为 A2A 服务

```python
from kagent_adk import Agent, tool
from kagent_adk.models import OpenAIChatModel

@tool(description="查询指定 namespace 下的 Pod 状态")
def get_pod_status(namespace: str) -> str:
    return f"Namespace {namespace} 中的 Pod 均运行正常。"

model = OpenAIChatModel(model_name="gpt-4o")
ops_agent = Agent(
    name="k8s-ops-agent",
    model=model,
    tools=[get_pod_status],
    system_prompt="你是一个 Kubernetes 运维助手。"
)

response = ops_agent.run("default 命名空间的 Pod 状态如何？")
print(response.content)
```

## 技术栈全景

### 协议层

| 协议 | 用途 |
|------|------|
| **MCP**（Model Context Protocol） | Agent 调用外部工具的标准化协议，任何 REST/gRPC/数据库均可通过 MCP Server 暴露 |
| **A2A**（Agent-to-Agent） | Agent 间互相发现、调用、委托的协议，支持多 Agent 级联协作 |
| **OpenTelemetry** | 每个 prompt、每次工具调用、每个 token 均产生 OTel Trace |
| **SSE** | Agent 流式响应的传输协议 |

### 运行时引擎

| 组件 | 语言 | 角色 |
|------|------|------|
| **kagent-controller** | Go | Kubernetes Operator，监听 CRD 并协调资源状态 |
| **kagent-adk** | Python | Agent 运行时，封装 Google ADK，启动 FastAPI HTTP Server |
| **Google ADK** | Python | Agent 执行引擎：多轮推理循环、工具调用编排、HITL 审批 |

### LLM 提供商

支持 OpenAI、Anthropic、Google Gemini、xAI、Azure OpenAI、AWS Bedrock、Vertex AI、Ollama、Hugging Face 等所有主流提供商。

### BYO 框架

可自带框架，kagent 负责编排层：LangGraph、CrewAI、Google ADK、NVIDIA NemoClaw。

### 集成生态

| 类别     | 具体技术                                               |
| ------ | -------------------------------------------------- |
| GitOps | ArgoCD、Flux                                        |
| 服务网格   | Istio、Ambient Mesh（mTLS、策略驱动出口）                    |
| 可观测性   | Prometheus + Grafana、OpenTelemetry、Langfuse        |
| 存储     | PostgreSQL（生产）、SQLite（开发/测试）                       |
| 通信渠道   | Slack、Discord、Telegram、WhatsApp、Claude Code、Cursor |
| 云平台    | GKE、EKS、AKS、OCI                                    |
| 安装方式   | Helm Chart                                         |

## 典型使用场景

### 1. 事件响应 Agent

接 Prometheus 告警 → 关联 OpenTelemetry Trace → 诊断根因 → 撰写 Runbook → 发起回滚 PR。每个高风险步骤通过 HITL 机制阻塞，需人工确认。

### 2. 可观测性 Copilot

自然语言提问「为什么凌晨 3 点 checkout 服务的 P99 延迟飙升到 5 秒」，Agent 自动调用 Prometheus API + 日志查询 → 返回根因和引用。

### 3. 平台自助服务

开发者通过自然语言申请资源：「帮我创建一个 namespace、一个 Aurora RDS 实例和一个 CI 流水线」。Agent 自动生成 Terraform PR + ArgoCD Application YAML。

### 4. 多 Agent 协作

一个 Agent 分诊（triage）→ 另一个诊断（diagnose）→ 第三个修复（remediate），A2A 协议协调，全链路可观测。

### 5. 知识 Agent

对 Runbook、ADR、Slack 历史记录做 RAG，结合 mTLS + RBAC + 审计日志满足企业安全合规。

## 生产落地建议

1. **分层治理**：工具侧在 MCP Server 端点控制只读/写权限，模型端通过 Gateway 统一代理（密钥轮换、并发限流、全局审计）
2. **Prompt as Code**：将 Agent CRD 加入 GitOps 流程，把故障排查思路、工具调用优先级写入 `systemMessage`
3. **A2A 生态**：运维 Agent 可被 ChatOps（Slack/Discord 机器人）或其他高层规划 Agent 远程调用
4. **预置 Chart**：kagent 仓库 `helm/agents/` 下提供 istio、argo-rollouts、observability 等预置 Helm Chart
5. **密钥管理**：生产环境强烈建议使用外部 Secret Store（如 Vault + External Secrets Operator），避免将 API Key 明文存入 K8s Secret

## 快速部署

```bash
# 1. 安装 kagent（需要已有的 K8s 集群）
helm install kagent oci://ghcr.io/kagent-dev/kagent/helm/kagent

# 2. 创建 API Key Secret
kubectl create secret generic openai-secret \
  --from-literal=api-key=sk-xxx \
  -n kagent

# 3. 部署 ModelConfig
kubectl apply -f model-config.yaml

# 4. 部署 MCP Tool Server
kubectl apply -f mcp-server.yaml

# 5. 部署 Agent
kubectl apply -f agent.yaml

# 6. 验证状态
kubectl get agents -n kagent
kubectl get pods -l app=kagent-adk -n kagent
```

## 常见问题 / 坑点

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| Agent 启动后无法连接 LLM | ModelConfig 中 API Key 未正确注入或 baseUrl 无法访问 | 检查 Secret 挂载和 Agent Pod 环境变量，确认网络策略允许出口 |
| MCP 工具不可用 | Controller 未完成工具发现，或 MCP Server 不可达 | `kubectl describe remotemcpserver` 检查状态，确认 SSE 端点连通 |
| HITL 审批后长时间无响应 | 审批超时或 ADK Runner 状态不一致 | 检查 Agent Pod 日志，增加 `sseReadTimeout` |
| 多 Agent 同时调用 MCP Server 导致超载 | MCP Server 无副本扩展 | 增加 MCP Server 副本数，配置 HPA |
| 提示词「不听话」 | systemMessage 中的安全规则不够明确或与模型 safety 冲突 | 在提示词开头用 `# 规则` 声明硬性约束，避免依赖模型自带安全机制 |

## 开发中 / 未来路线

| 能力 | 状态 |
|------|------|
| Agent CRD / ModelConfig / RemoteMCPServer | ✅ GA |
| 多 LLM Provider 支持 | ✅ GA |
| A2A 多 Agent 通信 | ✅ GA |
| HITL 人工审批 | ✅ GA |
| Prometheus 指标 + OTel Tracing | ✅ GA |
| Agent 工作流编排（DAG/Pipeline） | 🔄 开发中 |
| 跨集群 Agent 联邦 | 🔄 开发中 |
| Agent 市场 / 技能仓库 | 🔄 计划中 |
| 成本分析与优化 | 🔄 计划中 |

## 关联知识

- [[Sidecar 容器详解]] — kagent Agent Pod 可能利用 sidecar 模式运行辅助组件
- [[CEL 准入控制详解]] — 可用于对 kagent CRD 的变更做策略校验
- [[../versions/K8s 1.36 Haru 详解]] — kagent 基于 K8s v1.28+ 的 CRD 和 webhook 机制

## 参考资源

- 官网：https://kagent.dev/
- GitHub：https://github.com/kagent-dev/kagent
- CNCF：https://www.cncf.io/projects/kagent/
- Google ADK：https://google.github.io/adk-docs

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 架构理解 | 2026-06-30 | 完成：控制面/数据面架构、CRD 模型、A2A 消息流 |
| 实践操作 | — | 待：实际部署+构建运维 Agent |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-07

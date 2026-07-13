---
date: 2026-07-02
tags:
  - opentelemetry
  - otel
  - observability
  - traces
  - metrics
type: 学习笔记
category: 云原生/Kubernetes/可观测性
source: https://opentelemetry.io/docs/
difficulty: 高级
title: "OpenTelemetry 可观测性实践"
---

# OpenTelemetry 可观测性实践

## 概述

OpenTelemetry（OTel）是 CNCF 中活跃度仅次于 Kubernetes 的项目，提供了一套**厂商中立**的可观测性标准——统一的 SDK、统一的采集协议（OTLP）、统一的 Collector。它不替代 Prometheus / Loki / Tempo，而是**取代它们各自专属的采集器和 agent**，用一个 Collector 统一处理 Trace、Metric、Log 三种信号。

> 一句话：Prometheus 的 "ServiceMonitor → Prometheus → Grafana" 在 OTel 体系里变成 "OTel SDK / Auto-Instrumentation → OTel Collector → 任选后端（Prometheus / Tempo / ClickHouse / Datadog / ...）"。后端是可替换的，采集层是统一的。

## 与 LGTM 栈的本质区别

```
LGTM 路线（三个 Agent 三条管线）:
  Promtail ──→ Loki       （日志）
  Jaeger Agent ─→ Tempo   （链路）
  node-exporter → Prometheus（指标）

OTel 路线（一个 Collector 三条管线）:
  ┌── Receiver (OTLP) ─→ Processor ─→ Exporter → Tempo/Jaeger     (traces)
  │
  │  OTel Collector (DaemonSet + Deployment)
  │
  ├── Receiver (prometheus) ─→ Processor ─→ Exporter → Prometheus
  │
  └── Receiver (filelog) ─→ Processor ─→ Exporter → Loki / ClickHouse
```

| 维度 | LGTM | OpenTelemetry |
|------|------|:---:|
| 接入方式 | 每种信号独立 agent | **统一 Collector** |
| 协议 | 各自协议（Prometheus scrape、Loki push、Jaeger thrift） | **统一 OTLP（gRPC/HTTP）** |
| 厂商锁定 | Grafana 生态绑定 | **无绑定**（后端可热换） |
| 自动探针 | Prometheus exporter / Jaeger client 手动埋点 | **Auto-Instrumentation**（Java/Python/Go/.NET 零代码注入） |
| 应用代码改动 | 需要引入特定库 | OTel SDK 一行不改即可迁移后端 |
| CNCF 地位 | Prometheus 毕业、Loki/Tempo 沙箱 | **毕业（2024）** |
| kagent 集成 | 需额外配置 | **原生 OTel** |

## 三大核心概念

### Signals：三种信号的统一模型

OTel 为三种观测信号定义了统一的数据模型，都用一组标准的 Resource + Attribute 来标记"这个信号从哪来"：

| Signal | 用途 | OTel 数据对象 |
|------|------|------|
| **Trace** | 请求在分布式系统中的传播路径 | Span（含 TraceID、SpanID、ParentSpanID） |
| **Metric** | 聚合的数值指标 | Counter、Histogram、Gauge、UpDownCounter |
| **Log** | 离散的事件记录 | LogRecord（SeverityText、Body、TraceID 关联） |

**关键特性**：三种信号通过 **W3C Trace Context** 自动关联。同一个 TraceID 出现在 Metric 的 Exemplar、Log 的 Attribute 和 Trace 的 Span 中，Grafana / Jaeger 可以一键从 Metric 跳转到对应 Trace。

### OTLP：统一采集协议

OTLP（OpenTelemetry Protocol）是 OTel 定义的标准传输协议，替代了 Prometheus scrape + Jaeger thrift + Fluentd forward 三个协议的拼凑。

```
应用 SDK 侧:
  OTLP exporter (gRPC) → grpc://otel-collector:4317

Collector 侧:
  OTLP receiver (gRPC :4317 / HTTP :4318)
    → processor pipeline
    → OTLP exporter → 另一个 Collector / 后端
```

OTLP 支持 gRPC（高性能二进制）和 HTTP（防火墙友好）两种传输。gRPC 模式下原生支持流式传输（Trace 的 Span 实时推送、Metric 的 Delta 推送）。

### Collector：统一处理管线

Collector 是 OTel 的"中间件"，由三个组件组成：

```
Receiver (收) → Processor (处理) → Exporter (发)
     ↓               ↓                ↓
  接收数据      转换/过滤/采样      发送到后端
  OTLP /        batch /            Prometheus /
  Prometheus /  filter /           Tempo /
  filelog /     memory_limiter /   ClickHouse /
  k8s_events    k8sattributes      Datadog / ...
```

Pipeline 示例（一个 Collector 同时处理三种信号）：

```yaml
# otel-collector-config.yaml
receivers:
  otlp:                          # OTLP 接收（应用 SDK 推送）
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

  prometheus:                    # 抓取 Prometheus exporter
    config:
      scrape_configs:
        - job_name: 'node-exporter'
          scrape_interval: 30s
          static_configs:
            - targets: ['localhost:9100']

  filelog:                       # 收集容器日志
    include: [/var/log/pods/*/*/*.log]
    operators:
      - type: json_parser

  k8s_events:                    # K8s Event 收集
    namespaces: [health, bigdata]

processors:
  batch:                         # 批量发送（减少网络开销）
    send_batch_size: 8192
    timeout: 5s

  memory_limiter:                # 内存保护
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128

  k8sattributes:                 # 自动附加 K8s 元数据
    extract:
      metadata:
        - k8s.pod.name
        - k8s.namespace.name
        - k8s.deployment.name
        - k8s.node.name
    pod_association:
      - sources:
          - from: resource_attribute
            name: k8s.pod.ip

  filter:                        # 丢弃不需要的数据
    metrics:
      metric:
        - 'name == "http_client_duration_ms" and type == HISTOGRAM'

  tail_sampling:                 # 尾采样（只保留错误 + 慢请求的 trace）
    decision_wait: 10s
    policies:
      - name: errors-and-slow
        type: and
        and:
          and_sub_policy:
            - name: status-error
              type: status_code
              status_code: { status_codes: [ERROR] }
            - name: latency
              type: latency
              latency: { threshold_ms: 1000 }

exporters:
  otlp/tempo:
    endpoint: tempo.monitoring:4317
    tls:
      insecure: true

  prometheusremotewrite:         # 写入 Prometheus / VictoriaMetrics
    endpoint: "http://prometheus.monitoring:9090/api/v1/write"

  loki:
    endpoint: "http://loki.monitoring:3100/loki/api/v1/push"

service:
  pipelines:
    traces:                      # trace 管线
      receivers:  [otlp]
      processors: [memory_limiter, k8sattributes, tail_sampling, batch]
      exporters:  [otlp/tempo]

    metrics:                     # metrics 管线
      receivers:  [otlp, prometheus]
      processors: [memory_limiter, k8sattributes, batch]
      exporters:  [prometheusremotewrite]

    logs:                        # logs 管线
      receivers:  [otlp, filelog, k8s_events]
      processors: [memory_limiter, k8sattributes, batch]
      exporters:  [loki]
```

### 关键 Processor 详解

| Processor | 作用 | 推荐 |
|------|------|:---:|
| `batch` | 批量压缩后发送，减少 backend 压力 | 必须 |
| `memory_limiter` | Collector 内存超限时丢弃数据而非 OOM | 必须 |
| `k8sattributes` | 自动附加 Pod/Namespace/Deployment/Node 标签 | 必须（K8s 集群） |
| `tail_sampling` | 只保留错误+慢请求的 trace，砍掉 90% 正常 trace | 高流量必装 |
| `filter` | 丢弃不需要的 metrics（降低高基数） | 按需 |
| `attributes` | 增删改属性（如 mask 敏感字段） | 安全合规场景 |
| `resource` | 修改 resource 属性 | 多集群统一命名时用 |
| `transform` | OTTL（OpenTelemetry Transformation Language）通用数据转换 | 复杂逻辑时用 |

## K8s 部署方案

### 部署模式：DaemonSet + Deployment

OTel Collector 在 K8s 上采用双层部署：

```
模式 1: DaemonSet（节点级）
  每个节点一个 Collector Pod
  → hostNetwork + hostPID
  → 收集宿主机容器日志 (filelog receiver)
  → 收集 kubelet metrics (kubeletstats receiver)
  → 收集节点 metrics (hostmetrics receiver)
  → 高吞吐，本地 network latency 为零

模式 2: Deployment（集群级）
  多副本 Collector Service
  → 接收应用 SDK 推送的 OTLP 数据
  → 做 tail_sampling（需要全局视图）
  → HA：多副本 + gRPC 负载均衡
```

### OpenTelemetry Operator

```bash
# 安装 Operator
kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/latest/download/opentelemetry-operator.yaml

# Operator 管理 Collector CR
# 同时支持 Auto-Instrumentation（自动注入 Java/Python/Go/.NET SDK）
```

```yaml
# OpenTelemetryCollector CR（DaemonSet）
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-daemonset
  namespace: monitoring
spec:
  mode: daemonset
  hostNetwork: true
  env:
    - name: K8S_NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
  config: |
    receivers:
      prometheus:
        config:
          scrape_configs:
            - job_name: kubelet
              kubernetes_sd_configs:
                - role: node
              scheme: https
              tls_config:
                ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
                insecure_skip_verify: true
              bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token

      kubeletstats:
        collection_interval: 30s
        auth_type: serviceAccount
        endpoint: "https://${env:K8S_NODE_NAME}:10250"

      hostmetrics:
        collection_interval: 30s
        scrapers:
          cpu: {}
          memory: {}
          disk: {}
          network: {}
          load: {}

      filelog:
        include: [/var/log/pods/*/*/*.log]
        start_at: beginning
        include_file_path: true
        operators:
          - type: container
            id: container-parser

    processors:
      batch:
        send_batch_size: 8192
        timeout: 10s
      memory_limiter:
        check_interval: 1s
        limit_mib: 1024
      k8sattributes:
        extract:
          metadata: [k8s.namespace.name, k8s.pod.name, k8s.deployment.name, k8s.node.name]

    exporters:
      otlp:
        endpoint: otel-gateway.monitoring:4317
        tls:
          insecure: true

    service:
      pipelines:
        metrics:
          receivers: [prometheus, kubeletstats, hostmetrics]
          processors: [memory_limiter, k8sattributes, batch]
          exporters: [otlp]
        logs:
          receivers: [filelog]
          processors: [memory_limiter, k8sattributes, batch]
          exporters: [otlp]
```

```yaml
# OpenTelemetryCollector CR（Deployment — 集群级 Gateway）
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-gateway
  namespace: monitoring
spec:
  mode: deployment
  replicas: 2
  config: |
    receivers:
      otlp:                     # 从 DaemonSet Collector 接收
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
    processors:
      tail_sampling:            # 全局采样（只在 Gateway 做）
        decision_wait: 10s
        num_traces: 50000
        policies:
          - name: errors
            type: status_code
            status_code: { status_codes: [ERROR] }
          - name: slow
            type: latency
            latency: { threshold_ms: 2000 }
      batch:
        timeout: 5s
    exporters:
      otlp/tempo:
        endpoint: tempo.monitoring:4317
        tls: { insecure: true }
      prometheusremotewrite:
        endpoint: "http://victoriametrics.monitoring:8428/api/v1/write"
      loki:
        endpoint: "http://loki.monitoring:3100/loki/api/v1/push"
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [tail_sampling, batch]
          exporters: [otlp/tempo]
        metrics:
          receivers: [otlp]
          processors: [batch]
          exporters: [prometheusremotewrite]
        logs:
          receivers: [otlp]
          processors: [batch]
          exporters: [loki]
```

### Auto-Instrumentation —— 零代码注入

```yaml
# Instrumentation CR：声明哪些 Pod 自动注入 OTel SDK
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java-auto-instr
  namespace: health
spec:
  exporter:
    endpoint: http://otel-gateway.monitoring:4318
  propagators:
    - tracecontext
    - baggage
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:latest
  sampler:
    type: parentbased_traceidratio
    argument: "0.1"           # 10% 采样率

---
# 目标 Pod 加 annotation 即可注入
apiVersion: apps/v1
kind: Deployment
metadata:
  name: health-ack
spec:
  template:
    metadata:
      annotations:
        instrumentations.opentelemetry.io/inject-java: "health/java-auto-instr"
```

支持的自动探针语言：**Java、Python、Go（eBPF）、.NET、Node.js、Ruby**。

## 后端替换的灵活性

OTel 最大的卖点：**改一行 Exporter 配置，后端全换，应用代码毫不知情**。

```
场景切换示例（只改 Collector 的 exporters 和 pipelines）:

今天是:
  traces → otlp → Tempo
  metrics → prometheusremotewrite → Prometheus
  logs → loki → Loki

明天（成本优化）:
  traces → otlp → ClickHouse（列存，成本降为 1/10）
  metrics → prometheusremotewrite → VictoriaMetrics（单机替代集群）
  logs → otlp → ClickHouse

后天（接入 Datadog）:
  traces → datadog → Datadog
  metrics → datadog → Datadog
  logs → datadog → Datadog
```

这就是 OTel 的统一管线的价值——采集标准统一后，后端随便换。

## kagent + OTel 集成

kagent 原生将 OpenTelemetry 注入到每个 Agent Pod 的生命周期中：

```yaml
# kagent Agent CRD（追踪配置）
apiVersion: kagent.dev/v1alpha2
kind: Agent
spec:
  declarative:
    tracing:
      enabled: true
      endpoint: http://otel-gateway.monitoring:4317
      sampler:
        type: TraceIdRatioBased
        ratio: 0.1
```

kagent 自动为每个 Agent Pod 做：
- Prompt → LLM API 调用的 Span（记 token 数 + 延迟）
- 工具调用 Span（MCP `tools/call` 的延迟和结果）
- HITL 审批 Span（人工等待时间）
- A2A 跨 Agent 通信 Span（W3C Trace Context 透传）

这些 span 全部打到 OTel Collector，在 Tempo/Jaeger 中可以看到一个用户请求 → kagent → LLM → MCP Tool Server 的完整调用链。

## 选型建议

| 场景 | 推荐方案 |
|------|------|
| 新集群、从零搭建 | **OTel Collector（DaemonSet + Gateway）→ VictoriaMetrics + Tempo + Loki** |
| 已有 Prometheus 集群、不想动 | OTel Collector 仅用于 Trace + Log，Metric 保留 Prometheus scrape |
| GPU 训练集群（kagent + NCCL） | OTel Collector + kagent OTel 配置，全链路 Trace 覆盖训练 Job |
| 需要更换后端（成本/合规） | **OTel 是不二之选**（换 Exporter 即可） |
| 团队已熟悉 PromQL / LogQL | 保留 LGTM 后端，用 OTel Collector 替换采集层 |
| 小集群，运维力量有限 | 直接用 kube-prometheus-stack（LGTM 一体化 Helm），等规模上来再引入 OTel |

## 关联知识

- [[K8s 可观测性栈]] — LGTM 栈的 Prometheus/Loki/Tempo 部署（OTel Collector 对接的后端）
- [[Prometheus 存储引擎与高基数治理]] — OTel Collector 的 `prometheus` receiver 抓取和高基数治理
- [[kagent 详解]] — kagent 原生 OTel Trace 集成
- [[../mcp/MCP Server 工程实践]] — MCP Server 自身使用 OTel SDK 产生 Trace
- [[ArgoCD GitOps 实战]] — OTel Collector 通过 ArgoCD 部署管理
- [[OpenTelemetry Instrumentation 实战]] — 本文的埋点层深度补充（Semantic Conventions、Go/Python 代码、Context Propagation、Sampling）
- [[OpenTelemetry Collector 深度运维]] — 本文的 Collector 运维深度补充（OTTL 30 例、Connector 桥接、Scaling、安全、排障）

## 参考资源

- OpenTelemetry 官方文档：https://opentelemetry.io/docs/
- OTel Collector：https://opentelemetry.io/docs/collector/
- OTel Operator：https://github.com/open-telemetry/opentelemetry-operator
- OTel in K8s：https://opentelemetry.io/docs/kubernetes/
- kagent OTel 配置：https://kagent.dev/docs/kagent/reference/tracing

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| OTel 体系 | 2026-07-02 | OTLP 协议、Collector Pipeline、K8s 部署双层模式、Auto-Instrumentation、后端替换、kagent 集成 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-09

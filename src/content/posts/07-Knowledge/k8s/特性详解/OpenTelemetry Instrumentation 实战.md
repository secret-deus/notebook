---
date: 2026-07-02
tags:
  - opentelemetry
  - instrumentation
  - tracing
  - semantic-conventions
  - context-propagation
type: 学习笔记
category: 云原生/Kubernetes/可观测性
source: https://opentelemetry.io/docs/specs/semconv/
difficulty: 高级
title: "OpenTelemetry Instrumentation 实战"
---

# OpenTelemetry Instrumentation 实战

## 概述

OpenTelemetry 的 Collector 解决了「数据怎么收」，而 Instrumentation（埋点）决定了「数据长什么样」。如果不遵循 Semantic Conventions——OTel 最核心的规范之一——即使用了 OTel，每个团队写的 span 属性名都不同，最终在 Grafana 里看到的仍然是「HTTP 请求延迟」有 20 种不同的属性名。

> 一句话：用 OTel 不用 Semantic Conventions，等于用英文写句子但每个单词自己发明拼写。看得懂，搜不了。

## Semantic Conventions —— OTel 的"共同语言"

### 为什么它是 OTel 最重要的规范

Semantic Conventions 定义了一套标准的属性名、类型和语义，覆盖 HTTP、gRPC、数据库、消息队列、K8s、云计算资源等几乎所有场景。它的价值在于：

```
没有 Semantic Conventions:
  App A: "http.status"=200, "http.latency_ms"=15
  App B: "status_code"=200, "duration_ms"=15
  App C: "code"=200,   "elapsed"=15000

  Grafana 中查 "http.request.duration" → 空 → 没人遵循标准

有了 Semantic Conventions:
  App A: "http.request.method"="GET", "http.response.status_code"=200, "http.request.duration"=15ms
  App B: "http.request.method"="POST", "http.response.status_code"=201, "http.request.duration"=8ms
  App C: "http.request.method"="GET", "http.response.status_code"=404, "http.request.duration"=3ms

  Grafana 中查 "http.request.duration" → 全公司所有服务的数据都在这里
```

### HTTP 语义约定速查

```
命名空间：http.

Span 名称: {method} {route}    （如 "GET /api/users/:id"）

通用属性:
  http.request.method           = "GET" | "POST" | ...     ← 必须在 span 上
  http.response.status_code     = 200, 404, 500, ...
  http.request.body.size        = 1024    (bytes)
  http.response.body.size       = 2048
  network.protocol.version      = "1.1" | "2" | "3"
  server.address                = "api.example.com"
  url.path                      = "/users/123"
  url.query                     = "?page=2"
  user_agent.original           = "Mozilla/5.0..."

错误属性（仅非 2xx/3xx 时设置）:
  error.type                    = "404" | "500" | ...
  error.message                 = "Not Found"
```

### RPC / gRPC 语义约定

```
Span 名称: {package}.{Service}/{Method}

  rpc.system                   = "grpc"
  rpc.service                  = "health.v1.HealthService"
  rpc.method                   = "Check"
  rpc.grpc.status_code         = 0 (OK)
  network.peer.address         = "10.0.1.5:50051"
```

### DB 语义约定

```
Span 名称: {db.operation} {db.collection}

  db.system                    = "postgresql" | "mysql" | "redis" | "mongodb"
  db.operation                 = "SELECT" | "INSERT" | "HMGET"
  db.collection.name           = "users"
  db.statement                 = "SELECT * FROM users WHERE ..." (可选，敏感)
  server.address               = "db-primary.internal"
  server.port                  = 5432
```

### Messaging 语义约定

```
  messaging.system             = "kafka" | "rabbitmq" | "sqs"
  messaging.operation          = "receive" | "process" | "publish"
  messaging.destination.name   = "order-events"
  messaging.kafka.partition    = 3
  messaging.kafka.offset       = 12345
```

## 手工埋点实战

### Go —— 完整的 API Server 埋点

```go
package main

import (
    "context"
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.27.0"
)

// 初始化 OTel（main.go 开头调用一次）
func initTracer(ctx context.Context) (*sdktrace.TracerProvider, error) {
    // 1. OTLP Exporter → Collector
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint("otel-gateway:4317"),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return nil, err
    }

    // 2. Resource —— 标识"这些 span 来自哪个服务"
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName("health-ack"),
            semconv.ServiceVersion("v2.3.1"),
            semconv.DeploymentEnvironment("production"),
            semconv.K8SNamespaceName("health"),
            semconv.K8SPodName("health-ack-7d8f9-abcde"),
        ),
    )
    if err != nil {
        return nil, err
    }

    // 3. TracerProvider
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),                    // 异步批量发送
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.AlwaysSample()),    // 生产用 TraceIDRatioBased
    )
    otel.SetTracerProvider(tp)

    // 4. 设置 W3C Propagation（让 trace context 在服务间透传）
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},   // W3C traceparent
        propagation.Baggage{},        // W3C baggage
    ))

    return tp, nil
}

// 中间件：为每个 HTTP 请求创建 Span（使用 otelhttp）
func main() {
    ctx := context.Background()
    tp, err := initTracer(ctx)
    if err != nil {
        panic(err)
    }
    defer tp.Shutdown(ctx)

    mux := http.NewServeMux()
    mux.HandleFunc("/api/health", healthHandler)

    // otelhttp 自动：
    // - 从请求中提取 trace context（traceparent header）
    // - 创建 span（命名规则：{method} {route}）
    // - 设置 HTTP semantic conventions 属性
    // - 捕获 status_code + response_size
    wrapped := otelhttp.NewHandler(mux, "health-ack",
        otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
            return r.Method + " " + r.URL.Path
        }),
    )
    http.ListenAndServe(":8080", wrapped)
}

// 业务逻辑：手动创建子 Span + 添加业务属性
func healthHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    tracer := otel.Tracer("health-ack")

    // 创建子 Span（自动继承父 Span 的 TraceID）
    ctx, span := tracer.Start(ctx, "check-database")
    defer span.End()

    // 设置业务属性（遵循 DB semantic conventions）
    span.SetAttributes(
        semconv.DBSystemPostgreSQL,
        semconv.DBOperation("SELECT"),
        semconv.DBCollectionName("health_checks"),
        attribute.String("db.instance", "db-primary"),
    )

    // 模拟数据库查询
    status := checkDatabase(ctx)

    // 记录事件（带时间戳的注释）
    span.AddEvent("cache-hit", attribute.Bool("cache.hit", false))

    // 记录状态
    if status != "healthy" {
        span.SetStatus(semconv.Error, "database unhealthy")
    }

    w.Write([]byte(`{"status":"healthy"}`))
}

// 把 TraceID 注入到返回的 Header（方便调试时关联）
func injectTraceID(w http.ResponseWriter, ctx context.Context) {
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        w.Header().Set("X-Trace-Id", span.SpanContext().TraceID().String())
    }
}
```

### Go 生成 Metric 埋点

```go
import "go.opentelemetry.io/otel/metric"

var (
    meter = otel.Meter("health-ack")

    // Counter：请求总数（适合 rate() 计算 QPS）
    requestCounter, _ = meter.Int64Counter("http.server.requests",
        metric.WithDescription("Total HTTP requests"),
        metric.WithUnit("{request}"),
    )

    // Histogram：请求延迟分布（适合 histogram_quantile 计算 p99）
    requestDuration, _ = meter.Float64Histogram("http.server.request.duration",
        metric.WithDescription("HTTP request duration"),
        metric.WithUnit("ms"),
    )
)

func healthHandler(w http.ResponseWriter, r *http.Request) {
    start := time.Now()

    // ... 业务逻辑 ...

    duration := float64(time.Since(start).Milliseconds())

    // 登记 metrics（资源属性从 TracerProvider 沿袭）
    attrs := []attribute.KeyValue{
        semconv.HTTPResponseStatusCode(200),
        semconv.HTTPRequestMethodGet,
        attribute.String("route", "/api/health"),
    }
    requestCounter.Add(r.Context(), 1, metric.WithAttributes(attrs...))
    requestDuration.Record(r.Context(), duration, metric.WithAttributes(attrs...))
}
```

### Python —— FastAPI 埋点

```python
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource, SERVICE_NAME
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from fastapi import FastAPI

# 初始化
resource = Resource(attributes={
    SERVICE_NAME: "api-tpa",
    "deployment.environment": "production",
})

provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint="otel-gateway:4317", insecure=True))
)
trace.set_tracer_provider(provider)

app = FastAPI()

# 一行代码，自动注入所有 HTTP semantic conventions
FastAPIInstrumentor.instrument_app(app)

@app.get("/api/data")
async def get_data(request_id: str):
    tracer = trace.get_tracer(__name__)

    # 手动创建子 Span
    with tracer.start_as_current_span("query-database") as span:
        span.set_attributes({
            "db.system": "postgresql",
            "db.operation": "SELECT",
            "db.collection.name": "events",
        })

        result = await query_db(request_id)
        span.set_attribute("db.result.count", len(result))

    return result
```

## Context Propagation —— 链路串联的关键

### W3C Trace Context 标准

一个请求穿过 N 个服务，TraceID 必须在中间件层透传。W3C Trace Context 通过两个 HTTP header 实现：

```
请求 → Service A → Service B → Service C
         ↓ (A 创建或继承 trace)
         ↓ (A → B：在 HTTP header 中附 traceparent)
         ↓ (B 解析 traceparent，创建子 span)
         ↓ (B → C：同样透传)

HTTP Header:
  traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
                ││  │                               │               │
                ││  └─ TraceID (32 hex)              └─ SpanID (16 hex)    └─ flags
                │└─ version
                └─ format

  tracestate: vendor-specific key=value pairs（可选）
```

### 跨服务传播示例

Go 作为客户端请求下游时，必须手动注入 Trace Context：

```go
func callDownstream(ctx context.Context, url string) (*http.Response, error) {
    req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)

    // 注入 W3C trace context 到 HTTP Header
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
    // req.Header now has:
    //   traceparent: 00-{traceID}-{parentSpanID}-01
    //   baggage: key=value,...

    return http.DefaultClient.Do(req)
}
```

### Baggage —— 跨服务携带业务上下文

Baggage 是 trace context 的扩展，允许在 trace 中携带自定义键值对，在整个调用链的每一跳都可见：

```go
import "go.opentelemetry.io/otel/baggage"

// Service A：设置 baggage
bag, _ := baggage.NewMember("user.id", "user-456")
baggageCtx, _ := baggage.New(ctx, bag)

// Service B：读取 baggage
span := trace.SpanFromContext(ctx)
bag := baggage.FromContext(ctx)
userId := bag.Member("user.id").Value()  // "user-456"
span.SetAttributes(attribute.String("enduser.id", userId))
```

> 限制：Baggage 透传在每个 HTTP header 中，大小受 header 限制。**不要在 baggage 中放大数据或敏感信息**。

## Span 设计模式

### Span 命名

| 场景 | 命名规范 | 示例 |
|------|------|------|
| HTTP 请求 | `{method} {route}` | `GET /api/users/:id` |
| gRPC 调用 | `{package}.{Service}/{Method}` | `health.v1.HealthService/Check` |
| DB 操作 | `{db.operation} {db.collection}` | `SELECT users` |
| 业务逻辑 | `{动作} {对象}` | `process-order`, `validate-payment` |
| MCP 工具 | `mcp.tool.{toolName}` | `mcp.tool.get_pod_logs` |

### Span 粒度

**太粗（没有诊断价值）**：
```
handleRequest (1 个大 span，包含所有逻辑)
 → 无法知道瓶颈在 DB 还是缓存还是计算
```

**太细（噪声淹没信号）**：
```
handleRequest
  → parse_body         (0.1ms)
  → validate_email     (0.05ms)
  → check_cache        (0.2ms)
  → log_request        (0.01ms)
  → ... (20 more spans)
 → Trace 视图变成不可读的巨型列表
```

**正确的粒度**：
```
handleRequest             ← 粗粒度：哪个请求？
  → validate-auth         ← 中粒度：哪个模块？
  → query-users-db        ← 中粒度：哪个外部依赖？
  → format-response       ← 中粒度
```

规则：**Span 的边界应该是 I/O 边界、服务边界或逻辑模块边界**。如果两个操作之间没有 I/O、没有网络调用、没有独立失败的可能，就不需要独立的 Span。

### 错误处理

```go
func processOrder(ctx context.Context, orderID string) error {
    ctx, span := tracer.Start(ctx, "process-order")
    defer span.End()

    span.SetAttributes(attribute.String("order.id", orderID))

    order, err := db.GetOrder(ctx, orderID)
    if err != nil {
        // 关键：设置错误状态 + 记录异常
        span.RecordError(err)
        span.SetStatus(codes.Error, "failed to get order")
        return err
    }

    if order.Status == "cancelled" {
        // 业务逻辑拒绝（不是系统错误）→ 不设 Error
        span.SetAttributes(attribute.String("order.status", "cancelled"))
        span.AddEvent("order-already-cancelled")
        return nil
    }

    span.SetStatus(codes.Ok, "order processed successfully")
    return nil
}
```

## Sampling 策略深度分析

### Head Sampling（头部采样）

在 Span 创建的瞬间就决定是否记录——通常用概率。

| 策略 | 配置 | 适用 |
|------|------|------|
| **AlwaysOn** | 100% | 开发环境 |
| **TraceIDRatioBased** | N% (如 0.1 = 10%) | 生产环境通用 |
| **ParentBased** | 父 Span 采样 → 子 Span 采样 | 与 TraceIDRatio 组合使用 |

```go
sdktrace.NewTracerProvider(
    sdktrace.WithSampler(sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(0.1),  // 10% root span 采样
        // 如果 parent 被采样，所有 child 也采样
        // 如果 parent 未被采样，所有 child 也不采样
    )),
)
```

**Head Sampling 的致命缺陷**：错误和慢请求是随机分布的，10% 采样率意味着 90% 的错误 trace 被丢弃。对于一个每天 100 万次请求的服务，如果有 0.1% 的错误率 = 1000 个错误，Head 采样只能抓到约 100 个——数据太稀疏，找不到根因。

### Tail Sampling（尾部采样）

在 Span **完成之后**才决定是否保留——先接收所有 span 到 Collector 内存中，等 trace 完成后再判断。

这就是为什么 Tail Sampling 只在 **Collector Gateway（Deployment）** 中做，不能在 DaemonSet 中做——Gateway 汇集了所有 DaemonSet 的 span，才能对整个 trace 做全貌判断。

```
Tail Sampling 内部分析:

                        收到 span
                          ↓
                    [Decision Wait Buffer]
                    (等待 10s，让同一 trace 的其他 span 到达)
                          ↓
                    trace 完成或超时？
                          ↓
                    逐 Policy 评估:
                      1. status_code=ERROR? → KEEP
                      2. latency > 1s?      → KEEP  
                      3. probabilistic 1%?  → KEEP
                      4. 否则                 → DROP
                          ↓
                      发送到 Exporter
```

```yaml
tail_sampling:
  decision_wait: 10s                       # 等 10 秒让分散的 span 聚合完成
  num_traces: 50000                       # 内存中最多缓存 5 万个 trace
  
  policies:
    # Policy 1: 所有错误 trace 必须保留
    - name: all-errors
      type: status_code
      status_code: { status_codes: [ERROR] }

    # Policy 2: 慢请求必须保留
    - name: slow-traces
      type: latency
      latency: { threshold_ms: 2000 }

    # Policy 3: 特定服务和路径永远保留  
    - name: health-ack-checkout
      type: and
      and:
        and_sub_policy:
          - name: svc
            type: string_attribute
            string_attribute:
              key: service.name
              values: ["health-ack"]
          - name: route
            type: string_attribute
            string_attribute:
              key: http.route
              values: ["/api/checkout"]

    # Policy 4: 剩下的用概率采样
    - name: probabilistic
      type: probabilistic
      probabilistic: { sampling_percentage: 1.0 }  # 1% 保留
```

### Head vs Tail 选型

| 场景 | 推荐 | 理由 |
|------|:---:|------|
| 开发环境 | Head: AlwaysOn | 看到所有 trace |
| 低流量（< 1000 QPS） | Head: 100% | Tail 的决策等待会引入延迟 |
| 高流量（> 10000 QPS） | **Tail** | Head 采样丢太多错误 trace |
| 需要保证 100% 错误 trace | **Tail** | Head 采样做不到 |
| kagent LLM 调用 | Tail | LLM 调用延迟高且随机，必须在完成后判断 |

## 常见埋点错误

| 错误 | 后果 | 正确做法 |
|------|------|------|
| 不在 main() 中调用 `tp.Shutdown(ctx)` | 进程退出时未 flush 缓存的 span → 最后几十条 span 丢失 | `defer tp.Shutdown(ctx)` |
| Span 忘记 `End()` | 该 Span 永远不导出，内存泄漏 | 用 `defer span.End()` |
| 在 for 循环里创建 Span 但不结束 | 内存爆炸 | 循环内 `span.End()` 或确认无内存泄漏 |
| `span.SetAttributes` 放太多动态值 | Metric 的高基数问题从 Prometheus 搬到 OTel | 属性值控制在低基数范围 |
| 用 `context.Background()` 而非传递 ctx | Trace 链断裂，A→B 变成两个独立 trace | 函数签名接受 `ctx context.Context`，始终透传 |
| SDK 侧采样 ≠ Collector 侧采样同时用 | 双重采样，预期 1% 实际 0.01% | SDK 用 AlwaysOn，只在 Collector 做 Tail |

## 关联知识

- [[OpenTelemetry 可观测性实践]] — 本文的埋点层补充（Collector 部署 + OTLP 协议）
- [[../go/Go 基础速查]] — Go SDK 的 goroutine + context 在 OTel 中的运用
- [[Prometheus 存储引擎与高基数治理]] — Span 的属性值控制同样是高基数问题
- [[../mcp/MCP Server 工程实践]] — MCP Server 自身需要 OTel 埋点

## 参考资源

- Semantic Conventions：https://opentelemetry.io/docs/specs/semconv/
- Go SDK：https://github.com/open-telemetry/opentelemetry-go
- Python SDK：https://github.com/open-telemetry/opentelemetry-python
- Sampling：https://opentelemetry.io/docs/concepts/sampling/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 埋点深入 | 2026-07-02 | Semantic Conventions、Go/Python 完整示例、Context Propagation、Span 设计、Sampling 策略 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-09

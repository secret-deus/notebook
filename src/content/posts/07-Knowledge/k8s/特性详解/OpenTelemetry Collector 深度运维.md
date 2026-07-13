---
date: 2026-07-02
tags:
  - opentelemetry
  - collector
  - ottl
  - 运维
  - 扩展
type: 学习笔记
category: 云原生/Kubernetes/可观测性
source: https://opentelemetry.io/docs/collector/
difficulty: 高级
title: "OpenTelemetry Collector 深度运维"
---

# OpenTelemetry Collector 深度运维

## 概述

OTel Collector 是 OTel 体系中最被低估的组件。大多数人把它当成一个「透明的管道」——数据从 Receivers 进，从 Exporters 出。但实际上 Collector 可以做采样、数据清洗、协议转换、实时告警、多租户路由等大量工作，只是这些能力的入口——OTTL（OpenTelemetry Transformation Language）——文档分散，很少有人系统地掌握。

> 一句话：如果你只会配 Receiver → Processor → Exporter，你只用到了 Collector 20% 的能力。学会 OTTL，Collector 就从一个管道变成了一个可编程的数据处理引擎。

## Collector 内部组件生命周期

### 设计哲学：有向无环图（DAG）

Collector 不是简单的线性 Pipeline，而是一个由组件节点和连接边构成的有向无环图（DAG）。每个 Pipeline 内的 Receiver → Processor → Exporter 形成一条**有序路径**，多条 Pipeline 可以**共享同一个 Receiver 或 Exporter**。

```
Component 生命周期:
  Start()   → 被添加到 Pipeline
  Shutdown() → 被移除（配置更新或进程退出）

Pipeline 内执行顺序:
  Receiver → Processor[0] → Processor[1] → ... → Processor[N] → Exporter

关键规则:
  - Processor 之间数据传递是**同步的**（下一个 Processor 必须等上一个返回）
  - Exporter 接收数据后是**异步发送的**（batch processor 之后的数据流）
  - 同一 Pipeline 内的 Processor 之间**有界队列**（queue_size 控制背压）
```

### 背压（Backpressure）机制

当 Exporter 发送速度跟不上 Receiver 接收速度时，Collector 通过背压层层向上游传递信号：

```
Exporter 发送慢（后端慢/网络慢）
  → Processor 的 output queue 满
  → Processor 拒绝接收新数据
  → Receiver 的接收队列满
  → Receiver 丢弃数据或返回 429/503
  → 上游 SDK 收到错误 → 降低发送频率或丢弃本地缓冲的 span
```

这就是 `memory_limiter` 和 `batch` processor 存在的意义：它们定义了背压链条中的「水位线」。

```yaml
processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 1024               # 总内存上限
    spike_limit_mib: 256          # 单次 spike 容忍内存
    # 当内存使用达到 limit_mib → 强制拒绝所有新数据
    # 当 spike 超过 spike_limit_mib → 丢弃本次 spike

  batch:
    send_batch_size: 8192         # 攒到 8192 条 → 发送
    timeout: 5s                   # 最多等 5 秒就发送
    send_batch_max_size: 0        # 0=不限制，设值可限制单批次最大条数
```

## OTTL —— Collector 的可编程数据层

OTTL 是 OTel Collector 内置的领域特定语言（DSL），用于在 Processor 中转换、过滤和修改遥测数据。它让你可以实现「把某个属性的值 hash 之后做匿名化」这种正则做不到的操作。

### 基础语法

```ottl
# 条件表达式（必须返回 bool）
attributes["http.status_code"] >= 500

# 转换表达式（修改数据）
set(attributes["custom.tag"], "value")

# 路径导航
span.name                                     # Span 名称
attributes["db.system"]                       # 属性值
resource.attributes["service.name"]           # Resource 属性
instrumentation_scope.name                    # 探针名称
```

### 30 个实用的 OTTL 语句

**1-5：属性操作**
```yaml
transform:
  trace_statements:
    # 1. 设置属性
    - set(attributes["env"], "production")

    # 2. 删除属性
    - delete_key(attributes, "user.password")

    # 3. 重命名属性
    - set(attributes["deployment.environment"], attributes["env"])
    - delete_key(attributes, "env")

    # 4. 条件设置
    - set(attributes["tier"], "premium") where resource.attributes["namespace"] == "bigdata"

    # 5. 从 URL 提取路径（正则替换）
    - replace_pattern(attributes["http.route"], "/users/[0-9]+", "/users/:id")
```

**6-10：数值转换**
```yaml
transform:
  metric_statements:
    # 6. 单位转换（微秒 → 毫秒）
    - set(unit, "ms") where unit == "us"
    - set(value_double, value_double / 1000.0) where unit == "us"

    # 7. Metric 名称标准化
    - set(metric.name, Concat(["custom.", metric.name], "")) where not IsMatch(metric.name, "^custom\\.")

    # 8. 限幅（clamp）
    - set(value_double, 100.0) where value_double > 100.0

    # 9. IsMatch 条件过滤
    - set(attributes["priority"], "high") where IsMatch(attributes["endpoint"], "^(/api/checkout|/api/payment)")
```

**11-15：字符串操作**
```yaml
transform:
  log_statements:
    # 11. 拼接
    - set(attributes["full_name"], Concat([attributes["first_name"], " ", attributes["last_name"]], ""))

    # 12. 子串提取
    - set(attributes["region"], Substring(attributes["az"], 0, 9))  # "us-east-1a" → "us-east-1"

    # 13. 大小写
    - set(attributes["pod"], ConvertCase(attributes["pod"], "lower"))   # 全小写

    # 14. 字符串替换
    - replace_pattern(attributes["message"], "secret_key=[A-Za-z0-9]+", "secret_key=[REDACTED]")

    # 15. 长度截断（防止属性值过长）
    - set(attributes["body"], Substring(attributes["body"], 0, 1024)) where Len(attributes["body"]) > 1024
```

**16-20：条件过滤**
```yaml
transform:
  trace_statements:
    # 16. 丢弃健康检查的 span（降低噪音）
    - drop() where attributes["http.route"] == "/health"

    # 17. 只保留错误 span 的关键属性
    - delete_key(attributes, "http.request.body") where attributes["http.status_code"] < 500

    # 18. 按服务名改写 span 名称
    - set(span.name, Concat(["api.", span.name], "")) where resource.attributes["service.name"] == "api-tpa"

    # 19. 多条件 AND
    - set(attributes["sla"], "breached") where attributes["http.status_code"] >= 500 and duration > 5000000000

    # 20. NOT 条件
    - drop() where instrumentation_scope.name != "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
```

**21-25：类型与资源操作**
```yaml
transform:
  # 21. 类型转换（string → int）
  - set(attributes["gpu.count"], Int(attributes["gpu.count"]))

  # 22. 从 resource 复制到 span attributes
  - set(attributes["k8s.namespace.name"], resource.attributes["k8s.namespace.name"])

  # 23. 统一多集群命名
  - set(resource.attributes["cluster.name"], "prod-shanghai")
  - truncate_all(attributes, 256)     # 强制所有属性值 ≤ 256 字符

  # 24. 哈希匿名化（用于合规）
  - set(attributes["user.id"], SHA256(attributes["user.id"]))

  # 25. 根据 parent span 状态标记子 span
  - set(attributes["parent.error"], "true") where parent_span.attributes["error"] == "true"
```

**26-30：Metric 专属**
```yaml
transform:
  metric_statements:
    # 26. 聚合 type → 名称前缀
    - set(metric.name, Concat([metric.type, ".", metric.name], "")) where metric.type == "Sum"

    # 27. Delta → Cumulative 标记
    - set(attributes["temporality"], "delta") where IsMatch(metric.name, "^container\\.")

    # 28. 结合 resource 属性
    - set(metric.description, Concat(["from ", resource.attributes["service.name"]], ""))
      where metric.description == ""

    # 29. 限制数据点数量
    - limit(attributes, 10, ["keep.these.keys.*"])            # 只保留 10 个+通配符属性

    # 30. 按条件保留/丢弃整个 Telemetry
    - keep_keys(attributes, ["http.method", "http.status_code", "http.route"])
```

### OTTL vs Filter Processor

| 场景 | 用什么 |
|------|------|
| 简单丢弃某类数据 | `filter` processor（YAML 更简洁） |
| 修改属性值、类型转换、正则替换 | `transform` processor + OTTL |
| 跨 signal 联动（根据 trace 状态修改 metric） | OTTL 做不到（signal 间隔离），用 Connector |

## Connector —— 跨 Pipeline 桥接

Connector 是 OTel v0.83+ 引入的新组件类型，位于 Receiver 和 Exporter 之间，**可以从一个信号生成另一种信号**。

### spanmetrics —— 从 Trace 自动生成 RED 指标

这是最实用的 Connector：从 Span 数据中提取 request count、error count 和 duration，生成 Metric。这解决了 「做了 OTel tracing 但没有 request count 指标」的问题。

```yaml
connectors:
  spanmetrics:
    # 按下列维度聚合
    dimensions:
      - name: http.method
        default: GET
      - name: http.status_code
      - name: service.name       # resource attribute
      - name: http.route

    # 直方图分桶（毫秒）
    histogram:
      explicit:
        buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000]

    # 生成哪些指标
    metrics_flush_interval: 15s

    # 排除不需要聚合的 Span（如健康检查）
    exclude_patterns:
      - name: "GET /health"
```

然后把这些由 span 生成的 metric 发送到 Prometheus：

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [spanmetrics]      # 注意：spanmetrics 作为 exporter

    metrics/span:                    # 新 Pipeline：从 spanmetrics 接收 metric
      receivers: [spanmetrics]      # spanmetrics 在这里是 receiver
      processors: [batch]
      exporters: [prometheusremotewrite]
```

### servicegraph —— 自动生成服务依赖拓扑

```yaml
connectors:
  servicegraph:
    latency_histogram_buckets: [2, 4, 6, 8, 10, 50, 100, 200, 400, 800, 1000, 1400, 2000, 5000, 10000, 15000]
    dimensions: [cluster, namespace]
    store:
      ttl: 2s
      max_items: 1000
```

生成的指标：`traces_service_graph_request_total`、`traces_service_graph_request_server_seconds`，可直接用于 Grafana Node Graph 面板展示服务依赖拓扑。

## Collector 扩展运维

### Scaling 与 HPA

Collector 的瓶颈通常不在 CPU，而在**内存**（tail sampling buffer + batch buffer）。HPA 应该基于内存：

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: otel-gateway
spec:
  scaleTargetRef:
    apiVersion: opentelemetry.io/v1alpha1
    kind: OpenTelemetryCollector
    name: otel-gateway
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 70
```

gRPC 负载均衡：Collector Gateway 多副本时，需要无状态 gRPC 负载均衡。一个常见方案是前面加一个 headless Service + 客户端侧 `round_robin` load balancing：

```yaml
# DaemonSet Collector 连接 Gateway 的配置
exporters:
  otlp:
    endpoint: otel-gateway-headless.monitoring:4317
    tls:
      insecure: true
    # gRPC 客户端侧负载均衡
    balancer_name: round_robin
```

### 磁盘缓冲（防止后端不可用时丢数据）

当后端（Tempo / Prometheus）不可用时，内存中有界队列很快会满。启用磁盘缓冲可以让 Collector 把积压的数据暂存磁盘：

```yaml
exporters:
  otlp/tempo:
    endpoint: tempo.monitoring:4317
    sending_queue:
      enabled: true
      num_consumers: 10                # 并发发送 goroutine
      queue_size: 5000                 # 内存队列容量
      storage: file_storage            # 溢出到磁盘
```

```yaml
# 磁盘存储配置
extensions:
  file_storage:
    directory: /var/lib/otelcol/filestorage
    timeout: 1s
    compaction:
      directory: /var/lib/otelcol/filestorage/compaction
      on_start: true
      on_rebound: true                 # 积压消解后主动压缩
```

### Collector 自身 metrics

Collector 自身暴露 Prometheus metrics 在 `:8888/metrics`，这是排障的第一入口：

```promql
# Collector 是否在拒绝数据
otelcol_processor_refused_spans > 0
otelcol_exporter_send_failed_spans > 0

# Collector 数据吞吐
rate(otelcol_receiver_accepted_spans[1m])

# Collector 内存
otelcol_process_memory_rss

# 队列积压
otelcol_exporter_queue_size
otelcol_exporter_queue_capacity
```

## 生产安全

### 数据传输加密

```yaml
# Collector 间 TLS（DaemonSet → Gateway）
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        tls:
          cert_file: /certs/server.crt
          key_file: /certs/server.key
          client_ca_file: /certs/ca.crt    # mTLS

exporters:
  otlp:
    endpoint: otel-gateway:4317
    tls:
      ca_file: /certs/ca.crt
      cert_file: /certs/client.crt
      key_file: /certs/client.key
```

### 敏感数据脱敏

```yaml
processors:
  transform:
    trace_statements:
      # 脱敏 HTTP Authorization header
      - replace_pattern(attributes["http.request.header.authorization"], "Bearer .+", "Bearer [REDACTED]")
      # 脱敏 URL 中的 token
      - replace_pattern(attributes["url.full"], "token=[^&]+", "token=[REDACTED]")
      # 脱敏 email
      - replace_pattern(attributes["enduser.id"], ".+@.+", "[REDACTED]@example.com")
      # 删除电话号码
      - delete_key(attributes, "phone.number")
      # 哈希 IP 地址（保留用于地理分析，但无法反追到个人）
      - set(attributes["client.address"], SHA256(attributes["client.address"])) where attributes["client.address"] != nil
```

### 多租户路由

通过 attribute 将不同租户的数据路由到不同后端：

```yaml
exporters:
  # 租户 A 的数据去集群内 Prometheus
  prometheusremotewrite/tenant-a:
    endpoint: "http://prometheus-tenant-a:9090/api/v1/write"

  # 租户 B 的数据去 SaaS
  datadog/tenant-b:
    api:
      key: ${env:DD_API_KEY}
    hostname: tenant-b

processors:
  transform:
    metric_statements:
      - drop() where resource.attributes["tenant"] == "a" and exporter != "prometheusremotewrite/tenant-a"
```

## 生产排障手册

### 症状 → 定位 → 修复

| 症状 | 定位 | 修复 |
|------|------|------|
| Collector OOMKilled | `otelcol_process_memory_rss` 持续增长 | 增大 `memory_limiter.limit_mib` 或减少 `tail_sampling.num_traces` |
| Span 延迟 5 分钟后才到达后端 | `batch.timeout` 太大或 `sending_queue` 积压 | 减小 `batch.timeout`、增加 `num_consumers` |
| Tail Sampling 不生效（所有 span 都被保留） | `decision_wait` 太短，span 还没聚合完成就超时 | 增大 `decision_wait`（需要更大的内存 buffer） |
| 部分 span 丢失 | `sending_queue.queue_size` 已满且没有 `file_storage` | 增加 `queue_size` 并启用 `file_storage` |
| gRPC 连接错误 | 网络策略阻断 4317 端口或 TLS 证书不一致 | `grpc_health_probe` 验证、检查 Cilium/Calico 策略 |
| `otelcol_receiver_refused_spans > 0` | `memory_limiter` 触发拒绝，或 Pipeline 队列满 | 增大 `limit_mib` 或 HPA 扩容 Collector 副本 |

### 健康检查与调试

```bash
# Collector 健康检查（gRPC）
grpc_health_probe -addr otel-gateway:4317

# 查看 Collector 自身 metrics
curl http://otel-gateway:8888/metrics | grep otelcol_receiver_accepted

# 调试：把 Collector pipeline 的输出导出到 stdout
exporters:
  debug:
    verbosity: detailed      # 打印每条数据
  # 临时加到 pipeline:  exporters: [..., debug]
```

## 关联知识

- [[OpenTelemetry 可观测性实践]] — 本文的 Collector 运维深度补充
- [[OpenTelemetry Instrumentation 实战]] — SDK 侧埋点产生的数据在 Collector 管线中的处理
- [[K8s 可观测性栈]] — Collector 对接的后端（Prometheus/Tempo/Loki）
- [[../linux/大页内存与透明大页详解]] — Collector 的 `file_storage` 磁盘 I/O 优化
- [[../linux/网络内核参数调优]] — Collector gRPC 高并发场景的 TCP 调优

## 参考资源

- OTel Collector 架构：https://opentelemetry.io/docs/collector/architecture/
- OTTL 文档：https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/pkg/ottl
- Spanmetrics Connector：https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/spanmetricsconnector
- Servicegraph Connector：https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/servicegraphconnector

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| Collector 深入 | 2026-07-02 | 背压机制、OTTL 30 例、Connector 桥接、Scaling/HPA/磁盘缓冲、安全、排障 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-09

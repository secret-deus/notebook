---
date: 2026-07-02
tags:
  - k8s
  - prometheus
  - grafana
  - loki
  - observability
  - 监控
type: 学习笔记
category: 云原生/Kubernetes/可观测性
source: https://prometheus.io/docs/ / https://grafana.com/docs/
difficulty: 进阶
title: "K8s 可观测性栈"
---

# K8s 可观测性栈

## 概述

Kubernetes 集群的可观测性不止是"看 CPU/内存"。完整的可观测性栈需要覆盖三个支柱——**指标（Metrics）**、**日志（Logs）**、**链路追踪（Traces）**——并打通三者间的关联。Prometheus + Loki + Tempo + Grafana（LGTM 栈）是当前最主流的 K8s 原生方案。

> 一句话：Prometheus 告诉你"发生了什么"，Loki 告诉你"为什么发生"，Tempo 告诉你"在哪些组件间发生"。Grafana 把它们画成一张图。

## LGTM 栈组件职责

```
┌─────────────────────────────────────────┐
│            Grafana（可视化）              │
│  仪表盘 · 告警 · 探索 · 关联              │
└────┬─────────────┬─────────────┬────────┘
     │             │             │
┌────▼────┐  ┌─────▼──────┐  ┌───▼──────┐
│Prometheus│  │   Loki     │  │  Tempo   │
│  指标    │  │   日志     │  │ 链路追踪  │
└────┬────┘  └─────┬──────┘  └───┬──────┘
     │             │             │
┌────▼─────────────▼─────────────▼────────┐
│          Grafana Agent / Alloy          │
│         （采集器：抓指标 · 收日志 · 收 trace）│
└─────────────────────────────────────────┘
```

| 组件 | 职责 | 存储后端 | 查询语言 |
|------|------|------|------|
| **Prometheus** | 时序指标抓取、存储、告警 | 本地 TSDB / Thanos / VictoriaMetrics | PromQL |
| **Loki** | 日志聚合、索引（只索引 label，不索引正文） | S3 / GCS / 本地磁盘 | LogQL |
| **Tempo** | 分布式链路追踪存储与查询 | S3 / GCS / 本地磁盘 | TraceQL |
| **Grafana** | 统一可视化、告警管理、探索界面 | — | — |
| **Grafana Agent / Alloy** | 采集器（替代 promtail + otel-collector 等） | — | — |

## Prometheus —— 指标

### 架构与数据模型

```
AlertManager ←────── Prometheus ──────→ Grafana
  (告警路由)           (TSDB + 抓取)          (查询/可视化)
                       ↙   ↓   ↘
                     Pod  Node  Service
                     (metrics endpoint)
```

Prometheus 的时序数据结构：

```
指标名{标签键=标签值, ...} 值 @时间戳

node_cpu_seconds_total{cpu="0",mode="idle",instance="node-1"} 12345.67 @1719900000
  ─────┬────── ──────┬────── ───┬─── ──────┬─────── ───┬─── ─────┬─────
    指标名          标签键值对        值       时间戳
```

四个核心指标类型：

| 类型 | 含义 | K8s 典型示例 |
|------|------|------|
| **Counter** | 只增不减的计数器 | `http_requests_total`、`container_restarts_total` |
| **Gauge** | 可增可减的值 | `node_memory_MemAvailable_bytes`、`kube_pod_container_resource_limits` |
| **Histogram** | 分桶统计（分布） | `apiserver_request_duration_seconds_bucket`（请求延迟分布） |
| **Summary** | 分位数（quantile） | `kubelet_runtime_operations_duration_seconds{quantile="0.99"}` |

### Kube-Prometheus-Stack 部署

推荐的部署方式是通过 kube-prometheus-stack Helm Chart 一键部署整套监控栈：

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install kps prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace \
  --set prometheus.prometheusSpec.retention=15d \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=100Gi \
  --set alertmanager.alertmanagerSpec.storage.volumeClaimTemplate.spec.resources.requests.storage=10Gi \
  --set grafana.adminPassword=admin123 \
  --set grafana.persistence.enabled=true \
  --set grafana.persistence.size=10Gi
```

部署后自动获取的组件：Prometheus Operator、Prometheus、Alertmanager、Grafana、node-exporter、kube-state-metrics、Prometheus Adapter。

### K8s 关键指标速查

#### 控制面

```promql
# API Server 请求延迟 p99（按 verb 分组）
histogram_quantile(0.99,
  sum(rate(apiserver_request_duration_seconds_bucket[5m])) by (verb, le))

# API Server 错误率
sum(rate(apiserver_request_total{code=~"5.."}[5m]))
  / sum(rate(apiserver_request_total[5m])) > 0.01

# etcd Leader 变更（> 0 即告警）
rate(etcd_server_leader_changes_seen_total[10m])

# etcd WAL fsync 延迟 p99
histogram_quantile(0.99,
  rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m]))
```

#### 节点

```promql
# 节点 CPU 使用率
(1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) by (instance)) * 100

# 节点内存使用率
(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100

# 磁盘使用率（排除 tmpfs）
(node_filesystem_size_bytes{fstype!="tmpfs"} - node_filesystem_free_bytes{fstype!="tmpfs"})
  / node_filesystem_size_bytes{fstype!="tmpfs"} * 100 > 80

# 磁盘 I/O 饱和度（利用 iostat 的 %util 近似）
rate(node_disk_io_time_seconds_total{device=~"sd.|nvme.*"}[5m]) * 100
```

#### Pod / 工作负载

```promql
# Pod OOMKilled
kube_pod_container_status_terminated_reason{reason="OOMKilled"}

# Pod 重启速率
rate(kube_pod_container_status_restarts_total[15m]) > 0

# Controller（Deployment/DaemonSet）期望 vs 就绪副本数
kube_deployment_spec_replicas - kube_deployment_status_replicas_ready > 0

# 没有 limits 的 Pod（可能导致节点不稳定）
kube_pod_container_resource_limits{resource="memory"} == 0

# CrashLoopBackOff（5 分钟内有重启的 Pod）
rate(kube_pod_container_status_restarts_total[5m]) > 0
```

#### Service / 网络

```promql
# nf_conntrack 使用率
node_nf_conntrack_entries / node_nf_conntrack_entries_limit * 100 > 80

# 网卡丢包
rate(node_network_receive_drop_total{device!="lo"}[5m]) + rate(node_network_transmit_drop_total{device!="lo"}[5m])
```

### Prometheus Operator CRD

Prometheus Operator 通过 CRD 管理 Prometheus 生态：

```yaml
# ServiceMonitor：告诉 Prometheus 抓取哪个 Service 的 /metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: myapp-sm
  labels:
    release: kps              # 匹配 Prometheus 的 serviceMonitorSelector
spec:
  selector:
    matchLabels:
      app: myapp
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
---
# PrometheusRule：告警规则
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: myapp-alerts
  labels:
    release: kps
spec:
  groups:
    - name: myapp
      rules:
        - alert: HighErrorRate
          expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "High error rate on {{ $labels.pod }}"
            description: "5xx rate is {{ $value }} req/s"
```

### 生产级告警规则精选

```yaml
groups:
  - name: k8s-critical
    rules:
      # 1. 节点不可用
      - alert: NodeNotReady
        expr: kube_node_status_condition{condition="Ready",status="true"} == 0
        for: 5m
        labels: { severity: critical }
        annotations: { summary: "Node {{ $labels.node }} is NotReady" }

      # 2. Pod 频繁重启
      - alert: PodCrashLooping
        expr: rate(kube_pod_container_status_restarts_total[15m]) > 0
        for: 5m
        labels: { severity: warning }
        annotations: { summary: "Pod {{ $labels.pod }} crash looping" }

      # 3. PVC 使用率
      - alert: PersistentVolumeFilling
        expr: (kubelet_volume_stats_available_bytes / kubelet_volume_stats_capacity_bytes) < 0.1
        for: 5m
        labels: { severity: warning }

      # 4. 证书过期（30 天内）
      - alert: CertificateExpiring
        expr: avg(probe_ssl_earliest_cert_expiry - time()) by (instance) < 2592000
        for: 5m
        labels: { severity: warning }
```

### PromQL 核心函数速记

| 函数 | 作用 | 示例 |
|------|------|------|
| `rate(v[5m])` | 每秒增长率（Counter 专用） | `rate(http_requests_total[5m])` |
| `irate(v[5m])` | 瞬时增长率（更灵敏，但毛刺多） | `irate(network_bytes[5m])` |
| `increase(v[5m])` | 时间窗口内的增量 | `increase(restarts[1h])` |
| `avg_over_time(v[5m])` | 平均值 | `avg_over_time(cpu_usage[10m])` |
| `histogram_quantile(0.99, v)` | 分位数（Histogram 专用） | p99 延迟 |
| `sum(v) by (label)` | 按标签聚合求和 | `sum(rate(requests[5m])) by (pod)` |
| `topk(5, v)` | Top N | `topk(5, memory_usage)` |
| `absent(v)` | 指标缺失检测 | `absent(up{job="myapp"})` |
| `predict_linear(v[1h], 3600)` | 线性预测 | 预测 1 小时后磁盘使用量 |

## Loki —— 日志

### 核心理念

Loki 的架构理念与众不同：**只为 label 建索引，不为日志正文建索引**。这大幅降低了存储成本和写入延迟。

```
传统日志（Elasticsearch） → 为每个 token 建倒排索引 → 存储膨胀 3-10x
Loki                     → 只索引 label（app=xxx, env=prod） → 存储仅膨胀 1.1-1.3x
```

### 部署与采集

推荐使用 Grafana Agent（v0.40+ 更名为 Alloy）替代 promtail：

```yaml
# grafana-agent config
logs:
  configs:
    - name: k8s-logs
      clients:
        - url: http://loki-gateway.monitoring.svc/loki/api/v1/push
      scrape_configs:
        - job_name: kubernetes-pods
          kubernetes_sd_configs:
            - role: pod
          relabel_configs:
            - source_labels: [__meta_kubernetes_pod_label_app]
              target_label: app
            - source_labels: [__meta_kubernetes_namespace]
              target_label: namespace
            - source_labels: [__meta_kubernetes_pod_name]
              target_label: pod
          pipeline_stages:
            - docker: {}         # 解析 Docker JSON 日志格式
            - cri: {}            # 解析 CRI 日志格式
            - multiline:         # 合并 Java 堆栈等多行日志
                firstline: '^\d{4}-\d{2}-\d{2}'
```

### LogQL 核心查询

```logql
# 基本筛选——查 Go 容器日志
{namespace="health", app=~"go-.*"}

# 全文搜索——找含 "OOM" 的日志
{namespace="health"} |= "OOM"

# 排除过滤
{namespace="health"} != "debug"

# 正则匹配
{namespace="health"} |~ "ERROR|FATAL"

# 解析 JSON 日志（提取字段）
{app="api"} | json | status = 500

# 聚合——每分钟错误数
rate({app="api"} | json | status >= 500 [1m])

# 与 Prometheus 指标关联（同一 Grafana 面板）
# Metrics：http_errors rate
# Logs：Click → 查看对应时段的日志
```

### 关联 Prometheus → Loki

在 Grafana 告警中添加 "runbook_url" 或 Logs Panel Link，点击告警图表自动跳转到对应时段和应用的日志：

```
Grafana Dashboard Link:
/explore?left=["now-1h","now","Loki",{"expr":"{namespace=\"$namespace\",app=\"$app\"}"}]
```

## Tempo —— 链路追踪

### 工作原理

```
Request → Service A → Service B → Service C
           | (traceID=abc, spanID=1)  | (spanID=2)  | (spanID=3)
           
每个 span 携带同样的 traceID，Tempo 按 traceID 聚合所有 span 形成完整调用链
```

Jaeger（由 Istio/Envoy 注入）或 OpenTelemetry SDK 产生 span，Grafana Agent 转发到 Tempo。

### 集成 Istio + OpenTelemetry

```yaml
# Istio 自动注入 trace header（无需代码改动）
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: mesh-default
  namespace: istio-system
spec:
  tracing:
    - providers:
        - name: otel
      randomSamplingPercentage: 1.0   # 全量采样（开发），生产建议 0.1-1%
```

### TraceQL 查询

```traceql
# 查询 P99 延迟的 trace
{ duration > 1s }

# 查询 HTTP 500 错误的 trace
{ status = error && span.http.status_code = 500 }

# 查询调用特定服务的 trace
{ resource.service.name = "health-ack" }

# 查询含特定属性的 span
{ span.http.url =~ "/api/checkout.*" }
```

## Grafana —— 可视化

### Dashboard Provisioning

通过 ConfigMap 声明式管理 Dashboard：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-dashboard
  labels:
    grafana_dashboard: "1"     # Grafana sidecar 自动发现
data:
  my-dashboard.json: |
    {
      "title": "My App Overview",
      "panels": [...],
      "templating": {
        "list": [
          {"name": "namespace", "type": "datasource", "datasource": "Prometheus", ...},
          {"name": "pod", "type": "query", "datasource": "Prometheus",
           "query": "kube_pod_info{namespace=\"$namespace\"}", ...}
        ]
      }
    }
```

### 典型 Dashboard 布局

| Row | 面板 | 指标 |
|------|------|------|
| **概览** | CPU / 内存 / 磁盘 / 网络 | 节点级聚合指标 |
| **应用** | QPS / 延迟 p99 / 错误率 / 健康状态 | RED 指标（Rate-Error-Duration） |
| **依赖** | 上游/下游服务延迟、断路器状态 | Istio/Envoy 指标 |
| **实例** | 每 Pod 的 CPU/内存/重启/就绪状态 | Pod 级别指标 |
| **日志关联** | 日志量/错误量 | Loki query |
| **Traces** | P99 trace 示例 | Tempo query |

## GPU 节点专项监控

GPU 节点的监控需要使用 NVIDIA DCGM（Data Center GPU Manager），它通过 DCGM Exporter 暴露 Prometheus 指标：

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm install dcgm-exporter nvidia/dcgm-exporter -n monitoring \
  --set serviceMonitor.enabled=true \
  --set serviceMonitor.interval=30s
```

关键 GPU 指标：

```promql
# GPU 利用率
DCGM_FI_DEV_GPU_UTIL

# GPU 显存使用
DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL * 100

# GPU 温度
DCGM_FI_DEV_GPU_TEMP  # 告警阈值 > 80°C

# GPU 功耗
DCGM_FI_DEV_POWER_USAGE

# Xid 错误（硬件故障标志）
DCGM_FI_DEV_XID_ERRORS  # > 0 即告警

# NVLink 带宽使用率
DCGM_FI_PROF_NVLINK_TX_BYTES + DCGM_FI_PROF_NVLINK_RX_BYTES
```

GPU 告警规则：

```yaml
- alert: GpuHighTemperature
  expr: DCGM_FI_DEV_GPU_TEMP > 80
  for: 5m
  labels: { severity: warning }
  annotations: { summary: "GPU {{ $labels.gpu }} temperature {{ $value }}°C" }

- alert: GpuXidError
  expr: increase(DCGM_FI_DEV_XID_ERRORS[5m]) > 0
  labels: { severity: critical }
  annotations: { summary: "GPU Xid error detected" }
```

## 生产部署清单

| 步骤 | 操作 | 验证 |
|------|------|------|
| 1 | 部署 kube-prometheus-stack | `kubectl get pods -n monitoring` |
| 2 | 部署 Loki + Grafana Agent | `{app="api"} \|= "" ` 在 Grafana Explore 中返回日志 |
| 3 | 部署 Tempo + OpenTelemetry | Jaeger UI 可查询 trace |
| 4 | 配置 Grafana Data Sources | 在 Grafana → Data Sources 中确认 P/L/T 均已连接 |
| 5 | 导入核心 Dashboard（Node Exporter Full / K8s Cluster / RED Method） | Dashboard 数据正常显示 |
| 6 | 配置 Alertmanager → Slack/Webhook | 触发测试告警确认通道 |
| 7 | GPU 节点部署 DCGM Exporter | Grafana 中可查询 DCGM_FI_DEV_GPU_UTIL |

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| Prometheus 内存爆炸 | 高基数 label（如 `pod_uid`） | 用 `metric_relabel_configs` drop 掉高基数 label |
| Loki 查询慢 | chunk 过多或查询范围太大 | 缩短时间窗口、使用 `limit`、调大 `chunk_target_size` |
| Grafana Dashboard 加载慢 | 面板太多或查询量太大 | 减少面板数、增大采集间隔、用 recording rules 预计算 |
| Alertmanager 告警风暴 | 一个 Pod 故障 → N 条重复告警 | Alertmanager 用 `group_by: ['alertname', 'namespace']` 去重 |
| Prometheus disk 写满 | retention 时间过长或 TSDB compaction 跟不上 | 缩短 retention、迁移到 Thanos/VictoriaMetrics |

## 关联知识

- [[Prometheus 存储引擎与高基数治理]] — 本文的存储引擎深度补充（TSDB Head/Compaction、高基数治理、OOM 复盘）
- [[etcd 运维详解]] — etcd 的核心 Prometheus 指标
- [[../linux/网络内核参数调优]] — nf_conntrack 和网卡指标的 PromQL 查询
- [[ArgoCD GitOps 实战]] — ArgoCD Sync 状态的 Prometheus 指标
- [[../gpu-cluster-ops/monitoring/DCGM 监控体系详解]] — DCGM GPU 监控的详细介绍
- [[../mcp/MCP Server 工程实践]] — MCP Server 自身的可观测性日志和指标
- [[OpenTelemetry 可观测性实践]] — OTel 统一采集标准（替代 Prometheus scrape + Loki push + Tempo ingest 三种 agent）

## 参考资源

- kube-prometheus-stack：https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack
- PromQL 教程：https://prometheus.io/docs/prometheus/latest/querying/basics/
- Loki 文档：https://grafana.com/docs/loki/latest/
- Tempo 文档：https://grafana.com/docs/tempo/latest/
- DCGM Exporter：https://github.com/NVIDIA/dcgm-exporter

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 栈级理解 | 2026-07-02 | 完成：LGTM 栈、PromQL 速查、Loki/LogQL、Tempo/TraceQL、Grafana、GPU 监控 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-09

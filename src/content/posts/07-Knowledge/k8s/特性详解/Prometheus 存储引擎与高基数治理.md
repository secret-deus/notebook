---
date: 2026-07-02
tags:
  - prometheus
  - tsdb
  - observability
  - 存储引擎
  - 性能
type: 学习笔记
category: 云原生/Kubernetes/可观测性
source: https://prometheus.io/docs/prometheus/latest/storage/
difficulty: 高级
title: "Prometheus 存储引擎与高基数治理"
---

# Prometheus 存储引擎与高基数治理

## 概述

生产环境 Prometheus 最大的三个痛点是：磁盘写爆、查询超时、内存 OOM。这三个问题的根源都在 TSDB（Time Series Database）的设计上。理解 TSDB 的内部结构，才能在出问题时知道 `--storage.tsdb.retention.time` 调多少、为什么某个 `rate()` 查询让 Prometheus 卡死、为什么 label 设计不当直接把内存打满。

> 一句话：Prometheus 不是在存"数据"，它在存"时间线"。每个唯一的 label 组合 = 一条时间线。时间线越多，TSDB 越痛苦。

## TSDB 内部结构

### 宏观布局

```
prometheus-data/
├── wal/                     # 预写日志（Write Ahead Log）
│   ├── 000001               # 128MB 段文件
│   ├── 000002               # 最新写入先落 WAL，再批量写 Head
│   └── checkpoint.000003/   # WAL 压缩快照
├── chunks_head/             # Head Block 的 chunk 目录
├── 01JXXXXXXXX/             # 持久化 Block（2 小时窗口）
│   ├── index                # 倒排索引（label → series）
│   ├── chunks/              # 压缩后的数据块
│   │   └── 000001           # 512MB 段
│   ├── meta.json            # Block 元数据
│   └── tombstones           # 删除标记
└── 01JYYYYYYYY/             # 下一个 Block
```

### Head Block → Compaction 工作流

```
写入路径:
  Scrape → 解码 → WAL（可靠性保证）
               ↓ 批量
           Head Block（内存中的活跃块）
               ↓ 每 2 小时
           Compaction → 持久化 Block（磁盘）

Compaction 的 3 个层级:
  L1: Head Block → 2小时 Block（写磁盘）
  L2: 多个 2h Block → 更大的 Block（垂直压缩）
  L3: 过期 Block → 删除或降采样（取决于 lifetime）
```

### Head Block 的内存模型

Head Block 是 Prometheus 内存占用的核心来源。每一条时间线在 Head 中的内存开销约 **3-4 KB**（series 结构体 + label hash + chunk 指针）。

```
10 万条时间线 × 3KB = 300MB （可控）
100 万条时间线 × 3KB = 3GB   （开始吃力）
500 万条时间线 × 3KB = 15GB  （32GB 的 Prometheus 实例可能 OOM 在别处）

但真正的风险不在 series 数量，而在 "churn":
  - Pod 重启 → 新 label 组合 → 新时间线
  - Deployment 滚动 → 短时间内大量时间线创建 + 旧时间线标记为 stale
  - 即使数据不再增长，5 分钟 stale 标记期间的 churn 可以让内存翻倍
```

核心内存参数：

```bash
# Prometheus 启动时设置
--storage.tsdb.head-chunks-write-queue-size=0  # 默认 0（自适应），调大可降低内存峰值但增加延迟

# 运行时查看
curl localhost:9090/api/v1/status/tsdb | jq '.data'
# "headStats": {"numSeries": 123456, "chunkCount": 78901, ...}
```

### Compaction 的两类操作

| 操作 | 触发条件 | 影响 |
|------|------|------|
| **垂直压缩**（Vertical Compaction） | 同时间窗口的多个 Block | 合并重叠时间范围，消除重复样本 |
| **水平压缩**（Horizontal Compaction） | Block 总大小超过限制 | 降采样：`10% * retention` 窗口用原精度，其余用降采样 |
| **删除压缩**（Tombstone Cleanup） | Tombstone 数量积累 | 物理删除标记为删除的时间线数据 |

观察 compaction 行为：

```bash
# Prometheus 日志中 compaction 耗时
grep "compact blocks" /var/log/prometheus.log
# ts=2026-07-02T12:00:00.000Z caller=compact.go:518 level=info component=tsdb msg="compact blocks" ...
# duration=12.345s  ← Compaction 耗时，> 30s 需关注

# 查看 Block 分布
ls -la prometheus-data/ | grep "^d"
# 通常 20-30 个 Block 正常，> 50 说明 compaction 跟不上写入速度
```

## 高基数治理：决定 Prometheus 生死的问题

### 什么是"高基数"

```
低基数 label（安全）:
  instance="node-1"       → 几千个唯一值  ✓
  namespace="health"      → 几十个唯一值  ✓
  job="kubelet"           → 几十个唯一值  ✓

高基数 label（危险）:
  pod_uid="7d8f9..."      → 几十万个唯一值  ✗ 每个 Pod 一个
  request_id="abc-123"    → 无限增长       ✗ 每个请求一个
  user_id="user-456"      → 百万级        ✗ 用户量增长
  container_id="sha256:.."→ 每个容器一个  ✗
```

### 查杀高基数

```promql
# 第一步：找出哪个 metrics 的时间线最多
topk(10, count by (__name__)({__name__!=""}))

# 第二步：找出哪个 label 的基数最高
# （在 Grafana Explore 中执行，或通过 promtool 分析）
# 方法：采样 5 分钟内的 series 分布
count by (pod) (up)    # 按 pod 统计，找出异常的标签值

# 第三步：在 Prometheus UI /api/v1/label/__name__/values 查看总 metrics 数
# 超过 2000 个不同的 metrics name 说明已经有采集膨胀问题

# 第四步：揪出导致 "churn" 的源头
rate(prometheus_tsdb_head_series_created_total[5m])
# 如果持续 > 10/s，说明有东西在大量创建新时间线
# Pod 频繁重启？滚动更新？每个请求都创建新 label？
```

### 治理策略（从易到难）

**策略 1：采集时 drop（最有效，零存储开销）**

```yaml
# ServiceMonitor 或 PodMonitor 中
spec:
  endpoints:
    - port: metrics
      # 只采集需要的指标（白名单）
      metricRelabelings:
        - sourceLabels: [__name__]
          regex: '(http_requests_total|http_request_duration_.*|up)'
          action: keep
        # 干掉高基数 label
        - sourceLabels: [pod_uid, container_id]
          action: labeldrop
        # 重命名降低基数
        - sourceLabels: [pod]
          regex: '(.+)-[a-z0-9]{5}-[a-z0-9]{5}'   # 去掉 Pod 的随机后缀
          targetLabel: pod
          replacement: '${1}'
```

**策略 2：recording rules 预聚合（降低实时查询复杂度）**

**策略 3：水平切分（Federation / Thanos Query 分片）**

### 一例生产事故复盘：Prometheus 内存 OOM

**背景**：200 节点 K8s 集群，Prometheus 配置 32GB 内存。

**现象**：每隔 4-6 小时 OOMKilled 一次，重启循环。

**排查过程**：

```bash
# 1. 看 Prometheus 的自身指标
prometheus_tsdb_head_series           # 活跃时间线：180 万！
prometheus_tsdb_head_series_created_total  # 创建速率：500/s（异常高）

# 2. 找高基数来源
topk(10, count by (__name__)({__name__!=""}))
# 2: {__name__="istio_requests_total"} = 450000  ← 占 25%
# 3: {__name__="apiserver_request_duration_seconds_bucket"} = 280000

# 3. 深入 istio_requests_total
count by (destination_pod) (istio_requests_total)
# destination_pod 含 Pod UID，每次滚动更新产生新 series

# 4. 查 "churn"
rate(prometheus_tsdb_head_series_created_total[5m])  # 500/s
# 根因：CronJob 每 5 分钟创建 50 个 Pod，每个产生 200+ istio metrics series
```

**修复**：

```yaml
metricRelabelings:
  # Istio 的高基数 label —— 干掉
  - regex: '(destination_pod|source_pod|grpc_response_status)'
    action: labeldrop
  # 或者：只保留目标服务的聚合指标
  - sourceLabels: [__name__]
    regex: 'istio_requests_total'
    action: drop
```

修复后：180 万 series → 80 万，内存从 28GB → 12GB。

## Recording Rules 设计模式

Recording Rules 的本质是**用磁盘换时间**：预计算频繁查询的表达式，查询时直接读结果而不是实时算。

### 什么时候用 Recording Rules

```
需要 Recording Rule 的信号:
  - Grafana Dashboard 加载超过 5 秒
  - 某个 PromQL 的 range vector 超过 30 天（如 rate([30d])）
  - 告警规则包含 histogram_quantile() + sum() 多重聚合
  - 多个 Dashboard 重复计算相同的聚合查询

不需要 Recording Rule 的情况:
  - 简单的 instant vector 查询（`up == 0`）
  - 数据窗口 < 1 小时
  - 查询频率很低（< 1 次/分钟）
```

### 三层聚合模式

```yaml
groups:
  - name: http.rules
    interval: 30s                    # 30s 粒度
    rules:
      # L1：原始预计算（替代直接 query 原始 metrics）
      - record: job:http_requests:rate5m
        expr: rate(http_requests_total[5m])

      # L2：跨 job 聚合（替代 Grafana 中的 sum(...) by (...)）
      - record: namespace:http_requests:rate5m
        expr: sum without (instance, pod) (job:http_requests:rate5m)

  - name: slo.rules
    interval: 5m                     # 5m 粒度，更粗
    rules:
      # L3：SLO 计算（长期、低频）
      - record: namespace:http_errors:ratio30d
        expr: |
          sum by (namespace) (rate(http_requests_total{status=~"5.."}[30d]))
          /
          sum by (namespace) (rate(http_requests_total[30d]))
```

命名约定（Prometheus 官方推荐）：

```
level:metric:operation
  ↑    ↑        ↑
 聚合级 指标名   操作

示例:
  job:http_requests_total:rate5m            # job 级，rate 5m
  namespace:kube_pod_container:memory_usage # namespace 级，内存使用
  cluster:node_cpu_utilization:avg1h        # cluster 级，CPU 利用率平均值
```

### Recording Rules 的性能陷阱

| 陷阱 | 表现 | 修复 |
|------|------|------|
| Rule 太多（> 1000 条） | Prometheus 每 evaluation cycle 卡住 | 合并同时间窗口的规则、减少不必要的 L1 规则 |
| Rule 引用 Rule（A 依赖 B，B 依赖 C） | 多层依赖导致数据延迟叠加 | 最多 2 层，避免 3 层以上 |
| Rule 用了 `absent()` | `absent()` 在 Recording Rule 中无效 | 改为 `unless` 或 alert rule 中处理 |
| Rule 依赖的原始 metrics 延迟 2 分钟到达 | 规则计算结果不准 | 增大 evaluation interval 或加 `or vector(0)` 兜底 |

## Thanos vs VictoriaMetrics

Prometheus 单体实例的硬限制：单机磁盘容量 = 最大存储能力。超过就需要集群方案。

### Thanos —— CNCF 原教旨路线

Thanos 是"给 Prometheus 加的 Sidecar"，不改 Prometheus 核心代码，而是在旁边坐一个 Sidecar 上传 TSDB Block 到对象存储。

```
架构:
  Prometheus-A → Thanos Sidecar ──→ S3/GCS
  Prometheus-B → Thanos Sidecar ──→ S3/GCS
                                      ↓
                    Thanos Store Gateway（读 S3/GCS 中的 Block）
                    Thanos Compactor（降采样 + compaction）
                                      ↓
                    Thanos Querier（统一查询入口，去重 + 合并）
                                      ↓
                                    Grafana
```

关键能力：

| 能力 | 实现方式 | 代价 |
|------|------|------|
| **长期存储** | TSDB Block 上传到 S3/GCS | 对象存储费用 |
| **全局查询** | Querier 对多个 Sidecar + Store 并行查询 + 去重 | 查询延迟叠加（需要 Dedup） |
| **降采样** | Compactor 生成 5m/1h 粒度的 Block | 额外 Compactor 组件 |
| **多租户** | 通过 label 隔离 | 配置复杂度 |
| **HA Prometheus** | 两个 Prometheus 抓同一 targets，Querier dedup | 双倍存储 |

```bash
# Thanos Sidecar 关键参数
thanos sidecar \
  --prometheus.url=http://localhost:9090 \
  --tsdb.path=/prometheus \
  --objstore.config-file=/etc/thanos/s3.yaml \
  --shipper.upload-compacted    # 也上传已 compaction 的 block
```

### VictoriaMetrics —— 兼容 PromQL 替代方案

VictoriaMetrics（VM）是用 Go 重写的时序数据库，兼容 PromQL 和 Prometheus Remote Write，但存储效率比 Prometheus 高 7x。

| 维度 | Prometheus | Thanos | VictoriaMetrics |
|------|:---:|:---:|:---:|
| 存储效率（每样本字节） | ~1.3B | ~1.3B + S3 压缩 | ~0.4B（7x 优于原生） |
| 查询性能（同数据量） | 1x | 0.5-0.8x（Dedup 开销） | 2-5x |
| 高基数支持 | ≤ 1000 万 series | ≤ 1000 万 / 实例 | **≤ 1 亿 series** |
| 运维复杂度 | 低（单二进制） | 高（5+ 组件） | 低（单二进制） |
| 社区绑定 | K8s 原生 | CNCF 标准方案 | 独立 |
| 云原生集成 | ServiceMonitor、PrometheusRule | Prometheus + Sidecar | Remote Write Adapter |

```bash
# VictoriaMetrics 单节点部署（替代 Prometheus）
docker run -v /data:/victoria-metrics-data \
  victoriametrics/victoria-metrics \
  -storageDataPath=/victoria-metrics-data \
  -retentionPeriod=12    # 保留月数

# VictoriaMetrics 集群模式（会牺牲运维简单性）
# vminsert（写入） → vmstorage（存储） → vmselect（查询）
```

VM 的 dedup 和 Prometheus 不同：VM 的 `-dedup.minScrapeInterval` 是写入时去重（相同时间线 + 相同时间窗口只存一份），Thanos 是查询时去重（读两份结果后去重）。这是 VM 查询更快的关键原因。

## 关联知识

- [[K8s 可观测性栈]] — 本文是其存储引擎深度补充
- [[../linux/大页内存与透明大页详解]] — Prometheus TSDB 的 mmap 映射依赖大页性能
- [[../linux/网络内核参数调优]] — Prometheus 抓取大量 targets 时的 TCP 连接优化

## 参考资源

- Prometheus TSDB 格式：https://github.com/prometheus/prometheus/tree/main/tsdb/docs/format
- Prometheus TSDB 博客：https://ganeshvernekar.com/blog/prometheus-tsdb-the-head-block/
- VictoriaMetrics 技术细节：https://docs.victoriametrics.com/faq/
- Thanos 架构：https://thanos.io/tip/thanos/design.md/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| TSDB 深入 | 2026-07-02 | TSDB 结构、Head/Compaction、高基数治理、OOM 复盘、Thanos vs VM |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-09

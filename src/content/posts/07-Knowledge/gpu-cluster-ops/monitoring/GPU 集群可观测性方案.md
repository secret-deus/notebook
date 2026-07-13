---
date: 2026-06-30
tags:
  - gpu
  - monitoring
  - observability
  - prometheus
  - grafana
type: 学习笔记
category: GPU集群运维/监控
source: 个人整理
difficulty: 进阶
title: "GPU 集群可观测性方案"
---

# GPU 集群可观测性方案

> 构建 GPU 集群的统一可观测性平台：指标、日志、链路追踪三管齐下，覆盖硬件→OS→K8s→训练框架全栈。

## 概述

GPU 集群的可观测性比通用 K8s 集群多一个维度：GPU 硬件层（温度、功耗、Xid 错误、NVLink 状态、ECC 错误等）。需要 DCGM + 标准 K8s 监控体系的融合方案。

---

## 1. 三层可观测性模型

### 第一层：硬件层（DCGM）

| 采集器 | 核心指标 | 采集频率 | 存储 |
|--------|----------|:--------:|------|
| `dcgm-exporter` | GPU 温度/功耗/风扇转速 | 15s | Prometheus |
| `dcgm-exporter` | GPU 利用率 / 显存使用率 | 15s | Prometheus |
| `dcgm-exporter` | Xid 错误码 / ECC 单双比特错误 / NVLink CRC 错误 | 10s | Prometheus + Alertmanager |
| `dcgm-exporter` | NVLink 带宽 (TX/RX bytes) / NVLink 链路状态 | 30s | Prometheus |
| `dcgm-exporter` | SM Clock / Memory Clock / 降频原因 | 30s | Prometheus |
| `dcgm-exporter` | PCIe 带宽/replay 计数 | 30s | Prometheus |
| `dcgm-exporter` | FP32/FP16/TF32 吞吐 (DCGM_FI_PROF_* ) | 按需 | Prometheus |

**dcgm-exporter 部署要点**：

```yaml
# dcgm-exporter DaemonSet 关键配置
args:
  - --collectors=/etc/dcgm-exporter/default-counters.csv
  - -f /etc/dcgm-exporter/dcgm-metrics.csv  # 自定义指标文件
env:
  - name: DCGM_EXPORTER_KUBERNETES
    value: "true"
  - name: DCGM_EXPORTER_LISTEN
    value: ":9400"
```

**dcgm-metrics.csv 自定义指标示例**：

```csv
# GPU 利用率与时钟
DCGM_FI_DEV_GPU_UTIL, gauge, GPU utilization (%), percentage
DCGM_FI_DEV_MEM_COPY_UTIL, gauge, Memory utilization (%), percentage
DCGM_FI_DEV_SM_CLOCK, gauge, SM clock (MHz), frequency
DCGM_FI_DEV_MEM_CLOCK, gauge, Memory clock (MHz), frequency

# 温度与功耗
DCGM_FI_DEV_GPU_TEMP, gauge, GPU temperature (C), temperature
DCGM_FI_DEV_POWER_USAGE, gauge, Power usage (W), power
DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION, counter, Total energy (mJ), energy

# 错误指标（P0 告警来源）
DCGM_FI_DEV_XID_ERRORS, gauge, XID errors, errors
DCGM_FI_DEV_ECC_SBE_VOL_TOTAL, counter, Single-bit ECC errors, errors
DCGM_FI_DEV_ECC_DBE_VOL_TOTAL, counter, Double-bit ECC errors, errors
DCGM_FI_DEV_RETIRED_SBES, gauge, Retired pages (SBE), pages
DCGM_FI_DEV_RETIRED_DBES, gauge, Retired pages (DBE), pages
DCGM_FI_DEV_ROW_REMAP_FAILURE, gauge, Row remap failure, errors

# NVLink
DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT_TOTAL, counter, NVLink CRC errors, errors
DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL, counter, NVLink bandwidth (total), throughput
```

### 第二层：OS / K8s 层

| 采集器 | 核心指标 | 用途 |
|--------|----------|------|
| `node-exporter` | CPU 使用率、内存、磁盘 IOPS、网络流量 | 排除非 GPU 瓶颈 |
| `kubelet / cAdvisor` | Pod CPU/内存、OOMKilled 事件 | 训练任务资源分析 |
| `kube-state-metrics` | Node Ready / Pod Phase / Job 完成状态 | K8s 资源状态 |
| `ethtool` metrics | 网卡丢包/错误计数 | 通信链路健康 |
| `nvme-exporter` / `node-exporter` | NVMe 磁盘 wear level、温度 | 本地存储健康 |
| `ib-exporter` (InfiniBand) | IB 端口错误、link down 事件 | IB 网络健康 |

### 第三层：应用层（训练框架）

| 采集方式 | 指标 | 维度 |
|----------|------|------|
| PyTorch `torch.monitor` + Prometheus client | `iteration_time_seconds`, `tokens_per_second`, `loss`, `gradient_norm` | 按 job / rank / node |
| `torch.cuda.memory` | `allocated`, `reserved`, `max_allocated` | 按 rank |
| JAX profile / PyTorch Profiler | kernel launch 时间、内存带宽 | 按 operator |
| 自定义 callback | `data_load_time`, `checkpoint_save_time` | 按 step |

---

## 2. Prometheus 架构设计

### 部署拓扑

```
┌─────────────────────────────────────────────────────────────┐
│                  Prometheus (HA Pair)                        │
│  Per-region / per-cluster: 1-2 instances                    │
│  Scrape: dcgm-exporter (9400), node-exporter (9100),        │
│          kubelet (10250), kube-state-metrics, apps           │
└───────────────┬─────────────────────────────────────────────┘
                │ remote_write
┌───────────────▼─────────────────────────────────────────────┐
│              Thanos Receive / VictoriaMetrics                │
│  Global aggregation layer, long-term storage                 │
└─────────────────────────────────────────────────────────────┘
```

### 规模参考与容量规划

| 集群规模 | Prometheus 实例 | 每实例 Target 数 | 采集间隔 | 存储周期 | 日增量 |
|----------|:---------------:|:-----------------:|:--------:|:--------:|:------:|
| ≤ 32 GPU (4 节点) | 1 (HA pair) | ~200 | 15s | local 30d | ~3 GB |
| 64-256 GPU (8-32 节点) | 1 (HA pair) | ~500 | 15s | local 15d + Thanos 180d | ~15 GB |
| 256-1024 GPU (32-128 节点) | 2-4 (federation) | ~2000 | 20s | local 7d + Thanos 365d | ~60 GB |
| > 1024 GPU | Thanos Receive 集群 | > 5000 | 30s | Thanos 365d | > 200 GB |

### Prometheus 关键配置

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: gpu-cluster-prod-01
    region: us-east-1

# 采集目标
scrape_configs:
  - job_name: dcgm-exporter
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        action: keep
        regex: nvidia-dcgm-exporter
    scrape_interval: 15s
    metric_relabel_configs:
      # 降低高基数标签
      - source_labels: [UUID]
        target_label: gpu_uuid

  - job_name: node-exporter
    kubernetes_sd_configs:
      - role: endpoints
    scrape_interval: 30s

  - job_name: kubelet
    scheme: https
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      insecure_skip_verify: true
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    kubernetes_sd_configs:
      - role: node
    scrape_interval: 30s

# 远程写入 Thanos / VictoriaMetrics
remote_write:
  - url: "http://thanos-receive:19291/api/v1/write"
    queue_config:
      max_samples_per_send: 5000
      capacity: 10000
      max_shards: 10
    write_relabel_configs:
      # 长期存储丢弃部分高基数指标
      - source_labels: [__name__]
        regex: 'container_(network|sockets|oom).*'
        action: drop

# 规则文件
rule_files:
  - /etc/prometheus/rules/gpu-alerts.yml
  - /etc/prometheus/rules/k8s-alerts.yml
```

### 存储保留策略

| 层级 | 存储后端 | 保留周期 | 采样率 |
|------|----------|:--------:|:------:|
| 本地 (Prometheus TSDB) | SSD (≥ 200GB) | 15-30 天 | 原始 |
| 长期 (Thanos) | 对象存储 (S3/GCS) | 365 天 (downsample 5m) | 5m/1h |
| 聚合视图 (Recording Rules) | Prometheus + Thanos | 与长期同步 | 预计算 |

### Recording Rules（减少 Grafana 查询负载）

```yaml
groups:
  - name: gpu_recording
    interval: 30s
    rules:
      - record: cluster:gpu_utilization:avg
        expr: avg by (cluster) (DCGM_FI_DEV_GPU_UTIL)
      - record: cluster:gpu_power_draw:sum
        expr: sum by (cluster) (DCGM_FI_DEV_POWER_USAGE)
      - record: node:gpu_temp:max
        expr: max by (node, cluster) (DCGM_FI_DEV_GPU_TEMP)
      - record: node:gpu_memory_used:avg
        expr: avg by (node, cluster) (DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL * 100)
```

---

## 3. Grafana Dashboard 设计

### 3.1 集群总览 Dashboard

| 面板 | PromQL | 说明 |
|------|--------|------|
| GPU 总数 / 可用数 | `count(DCGM_FI_DEV_GPU_UTIL)` / `count(DCGM_FI_DEV_GPU_UTIL) - count(DCGM_FI_DEV_XID_ERRORS > 0)` | 集群健康度 |
| 总功耗 | `sum(cluster:gpu_power_draw:sum) / 1000` | 单位 kW |
| 平均 GPU 利用率 | `avg(cluster:gpu_utilization:avg)` | 整体利用率 |
| 最高 GPU 温度 | `max(node:gpu_temp:max)` | 热管理 |
| 活跃训练任务数 | `count(kube_job_status_active{namespace=\"training\"})` | 任务调度状态 |
| ECC 错误累计 | `rate(DCGM_FI_DEV_ECC_SBE_VOL_TOTAL[5m])` | 硬件退化预警 |

### 3.2 节点详情 Dashboard（8-GPU 热力图）

**热力图 Panel 配置（Grafana 9+ Heatmap plugin）**：

```
指标: DCGM_FI_DEV_GPU_TEMP
Dimensions: node, gpu_index (0-7)
Y Axis: node (hostname)
X Axis: gpu_index (0-7)
颜色: 蓝色 (30°C) → 绿色 (60°C) → 橙色 (75°C) → 红色 (85°C+)
```

每个节点展开视图包含：
- 8 卡温度/功耗/利用率 折线图（同一 panel，不同 series）
- 显存使用 vs 显存总量（bar gauge）
- NVLink 带宽热力图（8 卡之间的 NVLink 带宽矩阵）
- PCIe 吞吐量

### 3.3 训练性能 Dashboard

| 指标 | PromQL / 来源 | 面板类型 |
|------|--------------|----------|
| **TGS** (Tokens/GPU/sec) | `training_tokens_per_second` (app 暴露) | Stat + Graph |
| **MFU** (Model FLOPs Utilization) | `(observed_TFLOPS / theoretical_peak_TFLOPS) * 100` | Gauge |
| 迭代时间 | `training_iteration_time_seconds` | 时间序列 |
| Loss 曲线 | `training_loss` | 时间序列 (对数 Y 轴) |
| 梯度范数 | `training_gradient_norm` | 时间序列 |
| 数据加载时间占比 | `training_data_load_time / training_iteration_time_seconds * 100` | Gauge |

**MFU 计算公式**：
```
MFU = (tokens_per_step * model_parameters * 6) / (step_time * GPU_count * GPU_peak_TFLOPS * 1e12)
# 6 = approx FLOPs per token per parameter (forward 2x + backward 4x)
# H100 SXM peak TFLOPS (BF16): 989 TFLOPS
```

### 3.4 NCCL 通信 Dashboard

| 指标 | 来源 | 说明 |
|------|------|------|
| `nccl_bandwidth_gbps` | NCCL 测试脚本 + Prometheus pushgateway | 跨节点带宽 |
| `DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL` | DCGM | NVLink 实时吞吐 |
| `DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT_TOTAL` | DCGM | NVLink 链路错误 |
| `DCGM_FI_DEV_PCIE_REPLAY_COUNTER` | DCGM | PCIe 重试次数 |
| `node_network_transmit_drop_total` | node-exporter | 网卡丢包 (RoCE 故障信号) |

---

## 4. 告警规则

### GPU 硬件告警 (Prometheus Alert Rules)

```yaml
groups:
  - name: gpu_hardware_alerts
    interval: 15s
    rules:
      # P0: GPU 温度过高
      - alert: GPUTemperatureHigh
        expr: DCGM_FI_DEV_GPU_TEMP > 85
        for: 2m
        labels:
          severity: P0
          category: hardware
        annotations:
          summary: "GPU 温度过高 ({{ $value }}°C)"
          description: "节点 {{ $labels.node }} GPU {{ $labels.gpu }} 温度 {{ $value }}°C > 85°C，可能触发降频或关机保护。"

      # P0: Xid 错误（任何非零 Xid 都需要关注）
      - alert: GPUXidError
        expr: DCGM_FI_DEV_XID_ERRORS > 0
        for: 30s
        labels:
          severity: P0
          category: hardware
        annotations:
          summary: "GPU Xid 错误 (Xid={{ $value }})"
          description: "节点 {{ $labels.node }} GPU {{ $labels.gpu }} 报出 Xid={{ $value }}。参考 [[../troubleshooting/GPU Xid 错误排查手册]] 排查。"

      # P1: ECC 双比特错误（不可纠正）
      - alert: GPUECCDoubleBitError
        expr: rate(DCGM_FI_DEV_ECC_DBE_VOL_TOTAL[5m]) > 0
        for: 1m
        labels:
          severity: P0
          category: hardware
        annotations:
          summary: "GPU ECC 双比特错误"
          description: "节点 {{ $labels.node }} GPU {{ $labels.gpu }} 检测到 ECC DBE 错误，不可纠正。需立即检查并考虑 GPU 替换。"

      # P1: ECC 单比特错误递增（可纠正但需关注）
      - alert: GPUECCSingleBitErrorRate
        expr: rate(DCGM_FI_DEV_ECC_SBE_VOL_TOTAL[1h]) > 10
        for: 5m
        labels:
          severity: P1
          category: hardware
        annotations:
          summary: "GPU ECC 单比特错误率上升"
          description: "节点 {{ $labels.node }} GPU {{ $labels.gpu }} 单比特 ECC 错误率 {{ $value }}/h，可能暗示内存劣化。"

      # P1: Row Remap 失败（硬件不可恢复错误）
      - alert: GPURowRemapFailure
        expr: DCGM_FI_DEV_ROW_REMAP_FAILURE > 0
        labels:
          severity: P0
          category: hardware
        annotations:
          summary: "GPU Row Remap 失败"
          description: "节点 {{ $labels.node }} GPU {{ $labels.gpu }} Row Remap 失败，GPU 需替换。"

      # P2: GPU 降频
      - alert: GPUThrottling
        expr: DCGM_FI_DEV_CLOCK_THROTTLE_REASONS > 0
        for: 5m
        labels:
          severity: P1
          category: hardware
        annotations:
          summary: "GPU 降频中"
          description: "节点 {{ $labels.node }} GPU {{ $labels.gpu }} 降频原因码 {{ $value }}。常见原因：温度过高、功耗限制、供电不足。"

      # P1: NVLink 链路断开
      - alert: NVLinkLinkDown
        expr: DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT_TOTAL offset 1m != DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT_TOTAL
        labels:
          severity: P1
          category: hardware
        annotations:
          summary: "NVLink CRC 错误增加"
          description: "节点 {{ $labels.node }} GPU {{ $labels.gpu }} NVLink CRC 错误增加。参考 [[../troubleshooting/NCCL 通信故障诊断指南]]。"

      # P2: GPU 利用率过低（资源浪费）
      - alert: GPUUtilizationLow
        expr: DCGM_FI_DEV_GPU_UTIL < 50
        for: 30m
        labels:
          severity: P2
          category: efficiency
        annotations:
          summary: "GPU 利用率过低 ({{ $value }}%)"
          description: "节点 {{ $labels.node }} GPU {{ $labels.gpu }} 利用率 {{ $value }}%，持续 30 分钟。可能原因：任务已结束但未释放、训练 hang 住。"

      # P2: 显存即将耗尽
      - alert: GPUMemoryHigh
        expr: (DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL) * 100 > 95
        for: 5m
        labels:
          severity: P2
          category: capacity
        annotations:
          summary: "GPU 显存使用率 > 95%"
          description: "节点 {{ $labels.node }} GPU {{ $labels.gpu }} 显存使用率 {{ $value | humanize }}%，可能 OOM。"
```

### 节点与网络告警

```yaml
groups:
  - name: node_alerts
    interval: 30s
    rules:
      # P0: 节点不可达
      - alert: NodeUnreachable
        expr: up{job="node-exporter"} == 0
        for: 2m
        labels:
          severity: P0
          category: infrastructure
        annotations:
          summary: "节点 {{ $labels.instance }} 不可达"
          description: "node-exporter 连续 2 分钟不可达，节点可能宕机或网络中断。"

      # P1: 磁盘空间不足
      - alert: NodeDiskFull
        expr: (node_filesystem_avail_bytes / node_filesystem_size_bytes) * 100 < 10
        for: 5m
        labels:
          severity: P1
          category: capacity
        annotations:
          summary: "节点 {{ $labels.instance }} 磁盘空间不足 ({{ $value | humanize }}% 可用)"
```

### 训练任务告警

```yaml
groups:
  - name: training_alerts
    interval: 30s
    rules:
      # P0: 训练任务停滞
      - alert: TrainingJobStalled
        expr: rate(training_iteration_time_seconds[10m]) == 0
          and kube_job_status_active{namespace="training"} == 1
        for: 10m
        labels:
          severity: P0
          category: application
        annotations:
          summary: "训练任务停滞"
          description: "训练任务 {{ $labels.job_name }} 10 分钟内无迭代步进。检查 NCCL 通信、Xid 错误。参考 [[../troubleshooting/NCCL 通信故障诊断指南]]。"

      # P1: Loss 异常（发散或 NaN）
      - alert: TrainingLossAbnormal
        expr: training_loss > 1000 or training_loss != training_loss
        for: 2m
        labels:
          severity: P1
          category: application
        annotations:
          summary: "训练 Loss 异常 ({{ $value }})"
          description: "训练任务 {{ $labels.job_name }} loss={{ $value }}，可能发散或出现 NaN。"

      # P2: 数据加载延迟
      - alert: DataLoadLatencyHigh
        expr: (training_data_load_time / training_iteration_time_seconds) > 0.5
        for: 15m
        labels:
          severity: P2
          category: performance
        annotations:
          summary: "数据加载耗时占比 > 50%"
          description: "训练任务 {{ $labels.job_name }} 数据加载耗时 {{ $value | humanize }}%，成为瓶颈。"
```

---

## 5. 日志采集流水线

### 总体架构

```
训练 Pod 日志                   系统日志
(stdout/stderr)                (journald, dmesg, GPU driver)
       │                              │
       ▼                              ▼
  Fluent Bit                    Promtail
  (DaemonSet)                   (DaemonSet)
       │                              │
       │ tail /var/log/containers     │ journal API + dmesg
       │  │                           │  │
       │  ▼                           │  ▼
       │  ├── training.* → labels     │  ├── kernel → labels
       │  ├── nccl → labels           │  ├── nvidia* → labels
       │  └── default                 │  └── kubelet → labels
       │                              │
       ▼                              ▼
  ┌──────────────────────────────────────┐
  │            Grafana Loki              │
  │  (S3/GCS backend, 30d retention)    │
  └──────────────────┬───────────────────┘
                     │
                     ▼
              Grafana Logs Panel
         (LogQL: Xid 与训练日志关联)
```

### Fluent Bit 配置片段

```ini
[INPUT]
    Name              tail
    Path              /var/log/containers/*.log
    Parser            cri
    Tag               kube.*
    Refresh_Interval  5

[FILTER]
    Name              kubernetes
    Match             kube.*
    Kube_URL          https://kubernetes.default.svc:443
    Merge_Log         On

[FILTER]
    Name              rewrite_tag
    Match             kube.*
    Rule              $kubernetes['labels']['app.kubernetes.io/name'] ^training$ training.$kubernetes['namespace_name'].$kubernetes['pod_name'] false

[OUTPUT]
    Name              loki
    Match             training.*
    host              loki-gateway.loki.svc
    port              3100
    labels            job=training, namespace=$kubernetes['namespace_name']
```

### 关键日志关联查询（LogQL）

```logql
# 查询某个节点在特定时间的 Xid 错误相关日志
{job="system", unit="kernel"} |= "NVRM.*Xid"
  | regexp `Xid (?P<xid>\d+)`

# 查询训练任务在 Xid 发生时间点前后的日志
{namespace="training", pod=~"llama-70b.*"}
  | line_format "{{.timestamp}} {{.log}}"
  | json

# 关联查询：Xid 时间窗内的训练日志
{namespace="training"} |= "NCCL|cudaLaunch|RuntimeError"
```

### Promtail systemd 采集配置

```yaml
scrape_configs:
  - job_name: journal
    journal:
      path: /var/log/journal
    relabel_configs:
      - source_labels: [__journal__systemd_unit]
        target_label: unit
      - source_labels: [__journal__hostname]
        target_label: node
      - source_labels: [__journal__transport]
        action: keep
        regex: kernel|driver

  - job_name: dmesg
    pipeline_stages:
      - match:
          selector: '{job="dmesg"} |~ "NVRM.*Xid"'
          stages:
            - metrics:
                dmesg_xid_total:
                  type: Counter
                  description: "Total Xid errors detected in dmesg"
                  prefix: node_
                  source: xid
```

---

## 6. 训练任务指标暴露

### PyTorch + Prometheus Client 示例

```python
# training_metrics.py — 集成到训练脚本中
from prometheus_client import Gauge, Histogram, Counter, start_http_server
import torch
import time

# 定义指标
TRAINING_ITERATION_TIME = Histogram(
    "training_iteration_time_seconds",
    "Time per training iteration",
    buckets=[0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0]
)
TRAINING_TOKENS_PER_SEC = Gauge(
    "training_tokens_per_second", "Tokens processed per GPU per second"
)
TRAINING_LOSS = Gauge("training_loss", "Current training loss")
TRAINING_GRADIENT_NORM = Gauge("training_gradient_norm", "Gradient norm")
TRAINING_LEARNING_RATE = Gauge("training_learning_rate", "Current learning rate")
TRAINING_GPU_MEMORY_USED = Gauge(
    "training_gpu_memory_used_bytes",
    "GPU memory used per rank",
    ["rank", "gpu_uuid"]
)
DATA_LOAD_TIME = Gauge("training_data_load_time_seconds", "Data loading time per step")
MFU_GAUGE = Gauge("training_mfu_percent", "Model FLOPs Utilization")

# 启动 metrics 端口（每个 rank 独立暴露）
def init_metrics(port=9090):
    start_http_server(port)
    print(f"Metrics server started on port {port}")

# 训练循环中采集
def training_step(model, optimizer, data_loader, step):
    iter_start = time.time()

    # 数据加载计时
    data_start = time.time()
    batch = next(data_loader)
    DATA_LOAD_TIME.set(time.time() - data_start)

    # 前向传播
    loss = model(batch)
    loss.backward()

    # 记录梯度范数
    total_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
    TRAINING_GRADIENT_NORM.set(total_norm.item())

    optimizer.step()
    optimizer.zero_grad()

    # 记录指标
    elapsed = time.time() - iter_start
    TRAINING_ITERATION_TIME.observe(elapsed)
    TRAINING_LOSS.set(loss.item())

    # TGS 计算（需根据实际 batch 和 sequence 调整）
    tokens_per_step = batch_size * seq_length  # 每步处理的 token 数
    TRAINING_TOKENS_PER_SEC.set(tokens_per_step / elapsed)

    # GPU 显存
    for rank in range(torch.cuda.device_count()):
        mem = torch.cuda.memory_stats(rank)
        TRAINING_GPU_MEMORY_USED.labels(
            rank=str(rank),
            gpu_uuid=get_gpu_uuid(rank)
        ).set(mem["allocated_bytes.all.current"])

    # MFU 计算
    mfu = compute_mfu(elapsed, tokens_per_step, num_gpus, peak_tflops)
    MFU_GAUGE.set(mfu)

def compute_mfu(step_time, tokens_per_step, num_gpus, peak_tflops=989):
    """H100 SXM BF16 peak = 989 TFLOPS"""
    flops_per_step = tokens_per_step * model_params * 6  # 6N approximation
    actual_tflops = flops_per_step / step_time / 1e12
    return (actual_tflops / (num_gpus * peak_tflops)) * 100

def get_gpu_uuid(rank):
    return torch.cuda.get_device_properties(rank).uuid
```

### 暴露到 Prometheus

```yaml
# 训练 Pod 的 ServiceMonitor / PodMonitor
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: training-metrics
  namespace: training
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: training
  podMetricsEndpoints:
    - port: metrics
      interval: 15s
      path: /metrics
```

---

## 7. 实施计划

### 第 1 天：最小可行部署（MVP）

| 组件 | 操作 | 预计耗时 |
|------|------|:--------:|
| `dcgm-exporter` | DaemonSet 部署，验证 GPU 指标采集 | 1h |
| `node-exporter` + `kube-state-metrics` | Helm 安装 kube-prometheus-stack | 0.5h |
| Prometheus (单实例) | 配置 scrape jobs, 验证指标入库 | 1h |
| Grafana (基础 Dashboard) | 导入 GPU 集群总览 Dashboard | 0.5h |
| **P0 告警** | GPU 温度、Xid、节点不可达 | 0.5h |
| **验证** | 跑 NCCL 测试任务，确认全链路通 | 1h |

### 第 1~2 周：生产化完善

| 组件 | 操作 | 预计耗时 |
|------|------|:--------:|
| Prometheus HA Pair | 添加第 2 实例 + remote_write | 2h |
| Thanos Receiver + S3 | 长期存储 + downsampling | 3h |
| Grafana 完整 Dashboard | 集群总览、节点详情热力图、训练性能 | 4h |
| 告警完善 (P1/P2) | ECC、NVLink、训练停滞、Loss 异常 | 2h |
| Fluent Bit + Loki | 日志采集流水线，关联查询验证 | 3h |
| Training Metrics | PyTorch Prometheus client 集成 + PodMonitor | 3h |
| Alertmanager + 通知 | 企业微信/Slack/PagerDuty 通知链路 | 2h |
| **压测验证** | 真实训练任务运行 24h+，验证无漏报/误报 | 持续 |

### 成本估算

| 资源 | 规格 | 月成本 (按云 GPU 集群) |
|------|------|:---------------------:|
| Prometheus (HA 2 实例) | 4 vCPU + 16 GB RAM + 200 GB SSD × 2 | ~$200 |
| Thanos Receive + Store | 4 vCPU + 32 GB RAM + 50 GB SSD | ~$150 |
| Thanos 对象存储 (S3) | ~100 GB/月 (根据规模) | ~$3 |
| Loki (cortex mode) | 8 vCPU + 32 GB RAM + 200 GB SSD | ~$300 |
| Loki 对象存储 (S3) | ~50 GB/月 (compressed logs) | ~$2 |
| Grafana | 2 vCPU + 4 GB RAM | ~$100 |
| Alertmanager | 1 vCPU + 2 GB RAM | ~$30 |
| **总计** | | **~$785/月** (256 GPU 集群规模) |

> 注：大规模集群 (>512 GPU) 建议使用 VictoriaMetrics 替代 Prometheus，资源效率提升约 5-7 倍。

---

## 告警分级体系

| 级别 | 典型告警 | 响应时间 |
|------|----------|:---:|
| **P0 - 紧急** | GPU Xid Error、ECC DBE、节点不可达、训练停滞 | 5min |
| **P1 - 严重** | GPU 降频、ECC SBE 递增、NVLink CRC 错误、NVLink 链路断开 | 15min |
| **P2 - 警告** | 显存使用 > 95%、温度 > 85°C、GPU 利用率 < 50% (空闲)、数据加载延迟 | 1h |

---

## 关联知识

- [[DCGM 监控体系详解]]
- [[../troubleshooting/GPU Xid 错误排查手册]]
- [[../troubleshooting/NCCL 通信故障诊断指南]]
- [[../network/NCCL 通信原理与调优]]
- [[GPU 集群运维知识总览]]

---

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 骨架创建 | 2026-06-30 | 框架搭建 |
| 全面重构 | 2026-06-30 | 方案设计、配置、Alert Rules、实施计划 |

## 状态标记

📖 已掌握 — 架构设计（三层可观测性模型、Prometheus + Thanos 拓扑、Alert 分级体系、日志流水线）

📝 待补充 — Grafana Dashboard JSON 模板、OpenTelemetry trace 集成、VictoriaMetrics 迁移方案、DCGM Health Check 自动化巡检脚本

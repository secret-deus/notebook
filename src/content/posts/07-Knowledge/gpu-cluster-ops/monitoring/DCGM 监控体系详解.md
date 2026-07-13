---
date: 2026-06-29
tags:
  - gpu
  - dcgm
  - monitoring
  - prometheus
  - grafana
type: 学习笔记
category: GPU集群运维/监控
source: NVIDIA DCGM 官方文档
difficulty: 进阶
title: "DCGM 监控体系详解"
---

# DCGM 监控体系详解

> 基于 NVIDIA DCGM 构建 GPU 集群的统一可观测平台，覆盖指标采集、存储、可视化和告警全链路。

## 概述

DCGM (Data Center GPU Manager) 是 NVIDIA 官方 GPU 集群管理与监控工具，提供丰富的 GPU 遥测指标（温度、功耗、显存、计算利用率、Xid 错误等），是 GPU 集群可观测性的核心组件。

## 核心概念

### 1. DCGM 架构

```
┌─────────────────────────────────────┐
│  dcgm-exporter  (Prometheus 导出)    │
├─────────────────────────────────────┤
│  DCGM HostEngine  (守护进程)         │
├─────────────────────────────────────┤
│  NVML  (底层 GPU 管理库)             │
├─────────────────────────────────────┤
│  GPU Driver                         │
└─────────────────────────────────────┘
```

### 2. 关键指标分类

#### 硬件健康
```
DCGM_FI_DEV_XID_ERRORS           # Xid 错误计数
DCGM_FI_DEV_ECC_ERRORS           # ECC 错误
DCGM_FI_DEV_RETIRED_SBE          # 退役的单比特错误页
DCGM_FI_DEV_RETIRED_DBE          # 退役的双比特错误页
```

#### 利用率
```
DCGM_FI_DEV_GPU_UTIL             # GPU 计算利用率 (%)
DCGM_FI_DEV_MEM_COPY_UTIL        # 显存带宽利用率 (%)
DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL # NVLink 带宽利用率
DCGM_FI_PROF_SM_OCCUPANCY        # SM 占用率
DCGM_FI_PROF_PIPE_TENSOR_ACTIVE  # Tensor Core 活跃比例
```

#### 功耗与温度
```
DCGM_FI_DEV_POWER_USAGE          # 实时功耗 (W)
DCGM_FI_DEV_GPU_TEMP             # GPU 核心温度 (°C)
DCGM_FI_DEV_MEM_CLOCK_THROTTLE_REASONS  # 降频原因
```

#### 显存
```
DCGM_FI_DEV_FB_USED              # 已用帧缓存
DCGM_FI_DEV_FB_FREE              # 可用帧缓存
DCGM_FI_DEV_FB_USED_PERCENT      # 显存使用率 (%)
```

## 关键要点

### dcgm-exporter 部署

```yaml
# K8s DaemonSet 方式部署
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: dcgm-exporter
spec:
  selector:
    matchLabels:
      app: dcgm-exporter
  template:
    metadata:
      labels:
        app: dcgm-exporter
    spec:
      containers:
      - name: dcgm-exporter
        image: nvcr.io/nvidia/k8s/dcgm-exporter:3.3.6-3.4.1-ubuntu22.04
        env:
        - name: DCGM_EXPORTER_LISTEN
          value: ":9400"
        - name: DCGM_EXPORTER_KUBERNETES
          value: "true"
        securityContext:
          privileged: true
        volumeMounts:
        - name: pod-resources
          mountPath: /var/lib/kubelet/pod-resources
      volumes:
      - name: pod-resources
        hostPath:
          path: /var/lib/kubelet/pod-resources
```

### Prometheus 抓取配置

```yaml
scrape_configs:
  - job_name: 'dcgm-exporter'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        action: keep
        regex: dcgm-exporter
      - source_labels: [__meta_kubernetes_pod_node_name]
        target_label: node
```

### 告警规则示例

```yaml
groups:
  - name: gpu_alerts
    rules:
      - alert: GPUHighTemperature
        expr: DCGM_FI_DEV_GPU_TEMP > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "GPU {{ $labels.node }}/{{ $labels.gpu }} 温度过高"
          
      - alert: GPUXidError
        expr: increase(DCGM_FI_DEV_XID_ERRORS[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "GPU {{ $labels.node }}/{{ $labels.gpu }} 检测到 Xid 错误"
          
      - alert: GPUECCError
        expr: increase(DCGM_FI_DEV_ECC_ERRORS[5m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "GPU {{ $labels.node }}/{{ $labels.gpu }} 出现 ECC 错误"
```

## 常见问题

1. **dcgm-exporter 无数据**：检查 HostEngine 是否启动、GPU 是否被容器化正确挂载
2. **指标延迟**：DCGM 采集周期默认 10s，调整 `DCGM_EXPORTER_INTERVAL`
3. **大规模集群性能**：exporter 数量 × 指标数量 × 采集频率 = 需评估 Prometheus 容量
4. **多租户场景**：DCGM 指标是节点级别，需要额外逻辑标记 Pod 归属

## 关联知识

- [[GPU 集群可观测性方案]]
- [[../troubleshooting/GPU Xid 错误排查手册]]
- [[../performance/GPU 集群性能调优指南]]
- [[../GPU 集群运维知识总览]] — 返回总览

## 参考资源

- [NVIDIA DCGM 官方文档](https://docs.nvidia.com/datacenter/dcgm/latest/)
- [dcgm-exporter GitHub](https://github.com/NVIDIA/dcgm-exporter)

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 框架搭建 | 2026-06-29 | 骨架创建 |

## 状态标记

📝 待补充 — 需补充 Grafana Dashboard JSON 模板、多集群联邦监控方案、Job 级别指标采集 (DCGM_FI_PROF_*)

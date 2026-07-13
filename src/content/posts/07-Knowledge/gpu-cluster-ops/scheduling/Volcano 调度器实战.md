---
date: 2026-06-30
tags:
  - gpu
  - scheduling
  - volcano
  - batch-scheduler
  - gang-scheduling
type: 学习笔记
category: GPU集群运维/调度
source: Volcano 官方文档 + 个人整理
difficulty: 进阶
title: "Volcano 调度器实战"
---

# Volcano 调度器实战

> Volcano 是 CNCF 云原生批量调度器，专门解决 AI/ML 训练任务的 Gang Scheduling、队列管理、资源预留等问题，是 GPU 集群调度的事实标配。

---

## 一、为什么 GPU 集群需要 Volcano

K8s 默认调度器的 GPU 短板：

| 问题 | K8s Default Scheduler | Volcano |
|------|:---:|:---:|
| **Gang Scheduling** | ❌ 部分 Pod 启动后等资源，GPU 被白白占用 | ✅ All-or-nothing，所有 Pod 同时调度 |
| **队列优先级** | ⚠️ PriorityClass 粗粒度 | ✅ Queue 级别 + Job 级别，支持公平共享 |
| **资源预留** | ❌ 不支持 | ✅ 提前预留资源 |
| **拓扑感知** | ⚠️ Topology Manager 有限 | ✅ TaskTopology 精确控制 GPU 放置 |
| **作业生命周期** | ❌ 无作业概念 | ✅ Job → Task → Pod，完整的作业生命周期 |

---

## 二、核心概念

```
Queue（队列）
  └── PodGroup（作业的 Pod 集合，用于 Gang Scheduling）
        └── Job（Volcano Job: 一个训练作业）
              └── Task（Worker/PS/Master 等角色）
                    └── Pod

资源流转：
Queue → 按权重分配资源 → PodGroup 申请 → Scheduler 决策 → 分配节点
```

---

## 三、Gang Scheduling 实战

```yaml
apiVersion: batch.volcano.sh/v1alpha1
kind: Job
metadata:
  name: llm-training
spec:
  minAvailable: 8       # ★ 最少 8 个 Pod 同时就绪才启动
  schedulerName: volcano
  queue: high-priority
  tasks:
    - replicas: 8
      name: worker
      template:
        spec:
          containers:
            - name: trainer
              image: pytorch/pytorch:2.4
              resources:
                limits:
                  nvidia.com/gpu: 8
              command:
                - torchrun
                - --nproc_per_node=8
                - train.py
```

**关键效果**：8 个 Pod 要么全部 Running，要么全部 Pending——不会出现 6 个占用 GPU 干等另外 2 个的情况。

## 四、队列与资源管理

```yaml
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: training-queue
spec:
  weight: 2               # 权重（vs 其他 queue）
  capability:
    nvidia.com/gpu: "64"  # 队列总配额
---
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: inference-queue
spec:
  weight: 1
  capability:
    nvidia.com/gpu: "32"
```

## 五、拓扑感知

```yaml
apiVersion: batch.volcano.sh/v1alpha1
kind: Job
spec:
  tasks:
    - replicas: 8
      name: worker
      topologyPolicy:
        policy: "restricted"  # best-effort / restricted / single-numa
      template:
        spec:
          containers:
            - resources:
                limits:
                  nvidia.com/gpu: 8
```

## 六、常见配置

```bash
# Helm 安装
helm repo add volcano-sh https://volcano-sh.github.io/helm-charts
helm install volcano volcano-sh/volcano \
  --namespace volcano-system --create-namespace \
  --set basic.scheduler_name=volcano

# 关键参数
# batch_scheduler.yaml:
actions: "enqueue,allocate,backfill,preempt"  # 调度动作链
tiers:                                         # 分级驱逐策略
  - plugins:
      - name: priority
      - name: gang
      - name: conformance
  - plugins:
      - name: drf       # Dominant Resource Fairness
      - name: predicates
      - name: proportion
      - name: nodeorder
```

---

## 关联知识

- [[K8s GPU 调度机制详解]] — K8s 原生调度 vs Volcano
- [[Device Plugin 与 DRA 对比]] — Volcano 对 DRA 的支持现状
- [[GPU 资源分配与隔离策略]] — MIG/Time-Slicing 与 Volcano 配合
- [[../hardware/NVLink 与 NVSwitch 拓扑详解]] — 拓扑感知的基础
- [[GPU 集群运维知识总览]] — 返回总览

## 参考资源

- [Volcano 官方文档](https://volcano.sh/docs/)
- [Volcano GitHub](https://github.com/volcano-sh/volcano)

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 内容创建 | 2026-06-30 | 核心概念 + 实战配置 |

## 状态标记

📖 已掌握 — Gang Scheduling、Queue 管理、拓扑感知
📝 待补充 — Volcano v1.10+ 新增特性、与 Kueue 对比、多集群联邦调度

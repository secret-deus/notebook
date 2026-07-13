---
date: 2026-06-30
tags:
  - linux
  - kernel
  - 性能调优
  - 总览
type: 学习笔记
category: 基础设施/Linux
source: https://www.kernel.org/doc/html/latest/
difficulty: 进阶
title: "Linux 内核调优总览"
---

# Linux 内核调优总览

## 概述

无论是 Kubernetes 节点优化、GPU 集群调优还是 etcd 磁盘延迟优化，底层都依赖 Linux 内核参数的合理配置。本系列覆盖 K8s 节点 + GPU 训练场景中最关键的 5 个调优维度。

> 所有调优都要问三个问题：这个参数控制什么？改了对什么场景有利？**什么情况下不能改？**

## 五大调优维度

| # | 专题 | 难度 | 核心内容 |
|:---:|------|:---:|------|
| 1 | [[cgroup v2 详解]] | 进阶 | v1→v2 架构差异、五大控制器（cpu/memory/io/pids/cpuset）、PSI 压力指标、K8s v1.31+ 迁移实践 |
| 2 | [[NUMA 架构与亲和性调优]] | 高级 | 拓扑分析（distance 矩阵）、四种内存策略（bind/preferred/interleave）、GPU 训练 NUMA 绑定、zone_reclaim_mode 陷阱 |
| 3 | [[网络内核参数调优]] | 进阶 | nf_conntrack 爆表原理与调优、TCP 连接管理/缓冲区、Socket backlog、ARP 邻居表、BBR 拥塞控制 |
| 4 | [[大页内存与透明大页详解]] | 进阶 | TLB 原理、显式 HugePages vs 透明大页（THP）、khugepaged compaction 开销、K8s hugepages 资源、GPU 训练大页优化 |
| 5 | [[CPU 隔离与中断亲和性]] | 高级 | isolcpus + nohz_full + rcu_nocbs、Kubelet CPU Manager static policy、IRQ 亲和性配置、生产级隔离方案脚本 |

## 快速定位：什么场景看哪篇

| 遇到的情况 | 对应专题 |
|------|------|
| 节点 Pod 密度高，Service 连接丢失 | [[网络内核参数调优]] — nf_conntrack 爆表 |
| etcd 延迟抖动，Leader 频繁切换 | [[大页内存与透明大页详解]] — 关闭 THP |
| GPU 训练吞吐低，NCCL 带宽不稳 | [[NUMA 架构与亲和性调优]] — GPU+网卡同 NUMA |
| 延迟敏感 Pod p99 抖动 | [[CPU 隔离与中断亲和性]] — 独占 CPU + tickless |
| 从 cgroup v1 迁移到 v2 后 Pod 异常 | [[cgroup v2 详解]] — 统计口径差异 |
| 大内存节点 OOM 但实际有空闲内存 | [[NUMA 架构与亲和性调优]] — zone_reclaim_mode |
| 应用 fork 后内存暴增 | [[大页内存与透明大页详解]] — THP COW 陷阱 |
| 大量 TIME_WAIT 连接 | [[网络内核参数调优]] — tcp_tw_reuse + fin_timeout |

## 生产 K8s 节点初始化（精简版）

```bash
#!/bin/bash
# kernel-init.sh —— K8s 节点内核初始化

# === cgroup v2 验证 ===
if [ "$(stat -fc %T /sys/fs/cgroup)" != "cgroup2fs" ]; then
  echo "ERROR: cgroup v2 required" && exit 1
fi

# === sysctl ===
cat << 'EOF' > /etc/sysctl.d/99-k8s-node.conf
# Network
net.ipv4.ip_forward = 1
net.netfilter.nf_conntrack_max = 2097152
net.core.somaxconn = 32768
net.ipv4.tcp_tw_reuse = 1
net.ipv4.neigh.default.gc_thresh3 = 8192
# Memory
vm.swappiness = 0
vm.min_free_kbytes = 262144
vm.overcommit_memory = 1
vm.max_map_count = 262144
vm.dirty_ratio = 5
vm.zone_reclaim_mode = 0
# FS
fs.inotify.max_user_watches = 1048576
EOF
sysctl --system

# === Swap ===
swapoff -a && sed -i '/swap/d' /etc/fstab

# === Modules ===
cat << EOF > /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
modprobe overlay br_netfilter

# === THP ===
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo madvise > /sys/kernel/mm/transparent_hugepage/defrag

# === irqbalance ===
systemctl enable --now irqbalance

echo "Kernel init complete. See details in /etc/sysctl.d/99-k8s-node.conf"
```

## 关联知识

- [[../k8s/特性详解/etcd 运维详解]] — etcd 依赖 cgroup、THP、swappiness
- [[../k8s/特性详解/CNI 网络插件对比与排障]] — CNI 性能依赖 nf_conntrack、somaxconn
- [[../k8s/特性详解/Sidecar 容器详解]] — Sidecar 容器的 cgroup 资源隔离
- [[../gpu-cluster-ops/hardware/NVIDIA GPU 架构演进]] — GPU 训练的 NUMA 和中断要求
- [[../gpu-cluster-ops/network/NCCL 通信原理与调优]] — NCCL 依赖 大页 + NUMA + IRQ

## 参考资源

- Linux Kernel 文档：https://www.kernel.org/doc/html/latest/
- RHEL 性能调优：https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/
- K8s sysctl 列表：https://kubernetes.io/docs/tasks/administer-cluster/sysctl-cluster/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 总览构建 | 2026-06-30 | 5 篇专题全部完成，交叉引用齐全 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-07

---
date: 2026-06-30
tags:
  - linux
  - numa
  - 内存架构
  - gpu
  - 性能调优
type: 学习笔记
category: 基础设施/Linux
source: https://www.kernel.org/doc/html/latest/admin-guide/numa_memory_policy.html
difficulty: 高级
title: "NUMA 架构与亲和性调优"
---

# NUMA 架构与亲和性调优

## 概述

NUMA（Non-Uniform Memory Access）是多路 CPU 服务器的内存架构。每个 CPU Socket 拥有本地内存控制器和本地内存，访问本地内存快、远程内存慢。这个「快慢差异」对延迟敏感和带宽密集的工作负载（数据库、GPU 训练、DPDK）影响巨大。

> 一句话：NUMA 的本地/远程延迟差 = CPU 本地内存约 100ns，远程约 150-300ns。看起来不多，在 GPU 训练中每步卡 10μs 级联放大后就是 5-10% 吞吐差距。

## 拓扑分析

### 读取 NUMA 拓扑

```bash
# 方法 1：numactl
numactl --hardware
# available: 4 nodes (0-3)
# node 0 cpus: 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23    ← 物理核 + HT 兄弟
# node 0 size: 128000 MB      ← 本地 128GB
# node 1 cpus: 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
# node 1 size: 128000 MB
# ...
# node distances:
# node   0   1   2   3
#   0:  10  12  21  21    ← 10=本地, 12=同Socket不同die, 21=跨Socket
#   1:  12  10  21  21
#   2:  21  21  10  12
#   3:  21  21  12  10

# 方法 2：lstopo（更直观的拓扑图）
lstopo --no-io --no-legend
# 可输出 PNG 可视化拓扑
```

### distance 矩阵解读

| distance 值 | 含义 | 实例 |
|:---:|------|------|
| **10** | 同 NUMA 节点（本地） | 基准延迟 |
| **12** | 同一 Socket 的不同 die/CCD | 约 1.2x 延迟（AMD EPYC） |
| **21** | 跨 Socket | 约 2.1x 延迟 |
| **31-51** | 跨机箱（4S/8S 服务器） | 不常见 |

> distance 是 ACPI SLIT 表的标准化值，不是绝对纳秒，但比例关系准确。

### 内存分配分析

```bash
# 查看进程的内存分布在哪些 NUMA 节点
numastat -p $(pgrep -f kubelet)
#                            Node 0  Node 1  Node 2  Node 3  Total
#                   -------- ------- ------- ------- ------- -------
# Numa_Hit              1234567  987654  654321  321098 3197640
# Numa_Miss              12345  543210   98765   43210  697530  ← 20% 远程访问！
# Numa_Foreign            87321   65432   54321   43210  250284
# ...

# 查看每个 NUMA 节点的内存使用
numastat -m
# 显示 MemTotal, MemFree, MemUsed per node
```

如果 Numa_Miss 比例高（> 10%），说明进程频繁跨 NUMA 访问，**这就是性能问题的信号**。

## 四种内存策略

NUMA 内存策略控制内核如何分配内存。通过 `set_mempolicy()` 系统调用或 `numactl` 设置。

| 策略 | numactl 参数 | 行为 | 适用场景 |
|------|:---:|------|------|
| **Default** | （默认） | 优先本地分配，失败后跨节点 | 通用 |
| **Bind** | `--membind=N` | **只从指定节点分配**，失败则 OOM | GPU 训练、DPDK |
| **Preferred** | `--preferred=N` | 优先从指定节点分配，失败后跨节点 | 数据库、JVM |
| **Interleave** | `--interleave=0,N` | 轮询分配，所有节点均匀分布 | 大页面共享内存、tmpfs |

```bash
# Bind：GPU0 训练进程只使用 NUMA0 内存
numactl --cpunodebind=0 --membind=0 python train.py

# Preferred：优先 NUMA0，但不拒绝远程
numactl --preferred=0 java -jar app.jar

# Interleave：所有 4 个 NUMA 节点均匀分布（适合被多 NUMA 进程共享的内存）
numactl --interleave=0,1,2,3 python train.py --use-shared-memory
```

### zone_reclaim_mode 的陷阱

`vm.zone_reclaim_mode` 是 NUMA 调优中最容易被误解的参数：

| 值 | 行为 | 结果 |
|:---:|------|------|
| **0** | 禁用 zone reclaim。本地内存不够时，**允许从远程 NUMA 分配** | 可能远程访问多，但不会无故 reclaim |
| **1** | 启用。本地内存不够时，先**回收本地缓存页**，实在不够才跨 NUMA | 减少了远程访问，但 CPU 花费在 reclaim 上 |
| **2** | 回收 + 回写脏页（更激进） | |
| **4** | 回收 + 交换匿名页（最激进） | |

**K8s 节点强烈建议设为 0**。设为非 0 会导致：
- 频繁 page reclaim → CPU sys 升高
- 跨 NUMA 时本可用的远程内存被闲置
- etcd、Redis 等延迟敏感应用受 reclaim 影响抖动

```bash
# 检查当前值
sysctl vm.zone_reclaim_mode
# 正确值：0

# 持久化
echo "vm.zone_reclaim_mode = 0" >> /etc/sysctl.d/99-numa.conf
sysctl -p /etc/sysctl.d/99-numa.conf
```

## NUMA 自动平衡（auto-numa-balancing）

Linux 3.13+ 内核支持自动 NUMA 平衡：检测进程频繁访问远程内存时，自动将内存迁移到本地或进程迁移到数据所在 NUMA 节点。

| 参数 | 说明 |
|------|------|
| `kernel.numa_balancing = 1` | 启用自动平衡 |
| `kernel.numa_balancing_scan_delay_ms` | 进程创建后多久开始扫描（默认 1000） |
| `kernel.numa_balancing_scan_period_min_ms` | 最小扫描间隔 |
| `kernel.numa_balancing_scan_period_max_ms` | 最大扫描间隔 |
| `kernel.numa_balancing_scan_size_mb` | 每次扫描的内存大小 |

**K8s 场景建议**：
- 多租户通用 K8s 节点：`numa_balancing = 1`（内核自动优化）
- GPU 训练节点：`numa_balancing = 0`（由 `numactl --membind` 手动控制，避免自动迁移干扰 NCCL 通信）

## GPU 训练场景的 NUMA 调优

### 为什么 GPU 训练对 NUMA 敏感

```
NUMA0                          NUMA1
  GPU0  GPU1                     GPU2  GPU3
  mlx5_0 (IB 网卡)               mlx5_1 (IB 网卡)
  CPU 0-7                        CPU 8-15
  RAM 128GB                      RAM 128GB

正确配置：GPU0 → mlx5_0（同 NUMA0），GPU2 → mlx5_1（同 NUMA1）
错误配置：GPU0 → mlx5_1（跨 NUMA），每次 NCCL AllReduce 都有 ~50% 远程访问
```

### 实操步骤

```bash
# 1. 查看 GPU-NUMA-网卡拓扑
nvidia-smi topo -m
#         GPU0    GPU1    GPU2    GPU3    mlx5_0  mlx5_1  CPU Affinity    NUMA Affinity
# GPU0     X      NV18    NV18    NV18    PXB     SYS     0-7,16-23       0
# GPU1    NV18     X      NV18    NV18    PXB     SYS     8-15,24-31      0
# GPU2    NV18    NV18     X      NV18    SYS     PXB     32-39,48-55     1
# GPU3    NV18    NV18    NV18     X      SYS     PXB     40-47,56-63     1
# mlx5_0  PXB     PXB     SYS     SYS      X      SYS
# mlx5_1  SYS     SYS     PXB     PXB     SYS      X
# 解释：PXB = 同 PCIe Switch（最优），SYS = 跨 NUMA（差）

# 2. GPU0 训练绑定同一 NUMA 节点
numactl --cpunodebind=0 --membind=0 \
  python -u train.py

# 3. 多卡训练：每个 rank 绑定自己的 NUMA
# rank 0 (GPU0, GPU1)
numactl --cpunodebind=0 --membind=0 \
  python -u -m torch.distributed.run --nproc_per_node=2 --master_addr=... train.py &

# rank 1 (GPU2, GPU3)
numactl --cpunodebind=1 --membind=1 \
  python -u -m torch.distributed.run --nproc_per_node=2 --master_addr=... train.py &

# 4. 设置 NCCL 使用本地 IB 设备
export NCCL_IB_HCA=mlx5_0,mlx5_1      # 指定 IB 设备
export NCCL_SOCKET_IFNAME=eth0
export NCCL_NET_GDR_LEVEL=5            # GPU Direct RDMA（需要 PXB 拓扑）
```

### 性能对比（典型场景）

| 配置 | MLPerf ResNet-50 吞吐 | NCCL AllReduce 带宽 |
|------|:---:|:---:|
| GPU 和网卡跨 NUMA | 基准（3800 img/s） | 基准（18 GB/s） |
| **GPU 和网卡同 NUMA** | **+8% ~ +12%** | **+25% ~ +40%** |
| GPU 和网卡同 NUMA + mem bind | +10% ~ +15% | +30% ~ +45% |

## NUMA 故障排查

### 检测远程内存访问比例

```bash
# per-node 内存访问计数
perf stat -e 'node-loads,node-load-misses,node-stores,node-store-misses' \
  -p $(pgrep -f kubelet) -- sleep 10

# 计算远程访问比例
# node-load-misses / node-loads × 100%
# > 10% 说明存在问题
```

### 常见 NUMA 问题排查

| 症状 | 可能原因 | 排查方法 |
|------|---------|---------|
| 应用性能波动大，有时快有时慢 | 某些批次的内存分配跨 NUMA | `numastat -p <pid>` 观察 miss 趋势 |
| GPU 训练 NCCL 带宽不稳 | IB 网卡和 GPU 不在同一 NUMA | `nvidia-smi topo -m` 检查 PXB/SYS |
| 节点内存使用不平衡（一个节点满，另一个空） | zone_reclaim_mode ≠ 0 | `sysctl vm.zone_reclaim_mode` |
| 特定 Pod OOM 但节点整体内存充足 | `membind` 策略锁定在内存不足的 NUMA 节点 | 检查 Pod 是否有 NUMA 亲和性注解 |

## 关联知识

- [[cgroup v2 详解]] — cpuset 控制器的底层依赖
- [[CPU 隔离与中断亲和性]] — NUMA + 中断亲和性的组合调优
- [[大页内存与透明大页详解]] — 1GB 大页的 NUMA 分配
- [[../k8s/特性详解/DRA 动态资源分配详解]] — DRA 支持 NUMA-aware 设备分配
- [[../k8s/特性详解/In-place Pod 资源更新详解]] — CPU/Memory Manager 依赖 NUMA 拓扑

## 参考资源

- 内核 NUMA 策略：https://www.kernel.org/doc/html/latest/admin-guide/numa_memory_policy.html
- Auto NUMA Balancing：https://www.kernel.org/doc/html/latest/admin-guide/sysctl/kernel.html#numa-balancing
- NVIDIA NUMA 最佳实践：https://docs.nvidia.com/deeplearning/performance/dl-performance-checklist/index.html

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 架构理解 | 2026-06-30 | 完成：拓扑分析、四种策略、GPU 亲和性实战、故障排查 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-07

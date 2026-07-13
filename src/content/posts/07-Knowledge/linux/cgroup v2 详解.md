---
date: 2026-06-30
tags:
  - linux
  - cgroup
  - 资源隔离
  - kubernetes
  - 内核
type: 学习笔记
category: 基础设施/Linux
source: https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
difficulty: 进阶
title: "cgroup v2 详解"
---

# cgroup v2 详解

## 概述

cgroup（Control Group）是 Linux 内核实现资源隔离与限制的核心机制。Kubernetes 通过 cgroup 将 CPU、内存、I/O 等资源约束施加到 Pod 和容器上。cgroup v2 自 Linux 4.5 引入，v5.2 功能趋于完整，成为 **K8s v1.31+ 的唯一选项**。

> 一句话：没有 cgroup，就没有 Pod QoS 的 Guaranteed / Burstable / BestEffort。

## v1 vs v2：为什么必须迁移

### 架构层面的质变

```
cgroup v1:                               cgroup v2:
/sys/fs/cgroup/                          /sys/fs/cgroup/
  ├── cpu/                                 ├── cgroup.controllers
  │   └── kubepods/                        ├── cgroup.subtree_control
  │       └── pod-xxx/                     └── kubepods.slice/
  │           └── cpu.shares                   ├── cpu.weight
  ├── memory/                                 ├── memory.max
  │   └── kubepods/                           └── kubepods-burstable.slice/
  │       └── pod-xxx/                            └── pod-xxx/
  │           └── memory.limit_in_bytes               ├── cpu.weight
  ├── blkio/                                          └── memory.max
  │   └── kubepods/
  └── ...                                  所有控制器在同一棵树下
      每个子系统独立一棵树
```

v1 的本质问题：同一进程的 CPU 和内存约束分布在两棵独立的树上，无关联、无统一视图。v2 用一个统一层级解决了这个问题。

### 关键差异

| 维度 | cgroup v1 | cgroup v2 |
|------|-----------|-----------|
| 层级结构 | 每个子系统独立树 | **统一层级** |
| 进程归属 | 一个进程可跨子树（混乱） | 一个进程只能在一个叶子节点 |
| 内存压力 | 无 | **PSI (Pressure Stall Information)** |
| OOM 控制 | OOM killer 按 cgroup 独立决策 | `memory.oom.group` 可杀整组进程 |
| 线程控制 | cgroup v1 自身不支持 | threaded 模式 |
| 委托模型 | 无标准 | 统一 delegation 模型 |

### K8s 迁移时间线

| K8s 版本 | cgroup v2 状态 |
|---------|---------------|
| v1.25 | GA，默认仍用 v1 |
| v1.27 | 默认 v1，但 v2 完全可用 |
| v1.29 | kubelet 新增 `--cgroup-driver=systemd` 对 v2 的改进支持 |
| **v1.31** | **cgroup v2 强制要求**，不再支持 v1 |

## 五大控制器

### cpu —— CPU 带宽与权重

两个独立的控制维度：**权重**（比例共享）和**带宽**（硬上限）。

| 文件 | 含义 | 示例 |
|------|------|------|
| `cpu.weight` | 权重（默认 100），范围 [1, 10000] | K8s `requests.cpu` 不可压缩资源通过 weight 映射 |
| `cpu.max` | `$MAX $PERIOD`，带宽限制（微秒） | `"20000 100000"` = 0.2 核；`"max 100000"` = 不限制 |
| `cpu.stat` | 使用统计（usage_usec, user_usec, system_usec） | — |
| `cpu.pressure` | PSI 指标（some/full, avg10/avg60/avg300） | — |

K8s 映射规则：
- `requests.cpu` → `cpu.weight`（按比例换算：1 核请求 ≈ 1024 weight）
- `limits.cpu` → `cpu.max`（直接设置带宽上限）
- `requests == limits` 且为整数核 → Guaranteed Qos，触发 CPU Manager exclusive allocation

```bash
# 查看 Pod 的 CPU 约束
POD_CGROUP=$(cat /proc/$(pgrep -f "sleep" | head -1)/cgroup | awk -F: '{print $3}')
echo "CPU weight: $(cat /sys/fs/cgroup/$POD_CGROUP/cpu.weight)"
echo "CPU max:    $(cat /sys/fs/cgroup/$POD_CGROUP/cpu.max)"
```

### memory —— 内存与 swap

| 文件 | 含义 |
|------|------|
| `memory.max` | 硬限制（字节），达到后触发 OOM |
| `memory.high` | 软限制，达到后**节流**（throttle allocation）但不 OOM，优先回收 |
| `memory.low` | 最佳保护线，内存紧张时尽量不回收低于此线的内存 |
| `memory.min` | 硬保护线，低于此线的内存**绝不被回收** |
| `memory.current` | 当前使用量 |
| `memory.swap.max` | swap 上限（`0` = 禁止 swap，`max` = 不限制） |
| `memory.oom.group` | 设为 `1` 时 OOM 杀掉整个 cgroup 的所有进程 |
| `memory.stat` | 详细统计（anon, file, kernel_stack, slab, sock, ...） |
| `memory.pressure` | PSI 内存压力指标 |

K8s 映射：
- `limits.memory` → `memory.max`
- `requests.memory` → 影响 OOM 打分（oom_score_adj），不直接映射到 `memory.low`

```bash
# 查看 Pod 内存压力
POD_CGROUP="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<uid>.slice"
cat $POD_CGROUP/memory.pressure
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

### io —— 块设备 I/O 控制

| 文件 | 含义 |
|------|------|
| `io.weight` | I/O 权重（默认 100），类似 cpu.weight |
| `io.max` | I/O 带宽硬限制：`$DEV $RBPS $WBPS $RIOPS $WIOPS` |
| `io.stat` | 每设备读写字节/操作统计 |
| `io.pressure` | PSI I/O 压力指标 |

```bash
# 限制某 cgroup 对 sda 的写带宽为 10MB/s
echo "8:0 rbps=10485760 wbps=10485760" > io.max
```

> 注意：io 控制器对 buffered I/O 的控制有限，仅直接影响 direct I/O。

### pids —— 进程数限制

防止 fork bomb 或进程泄漏：

```bash
# 限制该 cgroup 最多 100 个进程
echo 100 > pids.max
```

K8s 通过 `--pod-max-pids` 使用（默认 -1 不限制）。

### cpuset —— CPU/内存节点绑定

指定 cgroup 进程只能运行在哪些 CPU 和 NUMA 节点上：

| 文件 | 含义 |
|------|------|
| `cpuset.cpus` | 允许使用的 CPU 列表（如 `0-3,8-11`） |
| `cpuset.mems` | 允许使用的 NUMA 内存节点（如 `0`） |
| `cpuset.cpus.effective` | 实际生效的 CPU（受父节点限制） |

这是 K8s CPU Manager static policy 的底层机制。

## PSI —— 资源压力的新语言

PSI（Pressure Stall Information）量化了"有多少任务因为等不到资源而被阻塞"。它能区分 **some**（部分任务阻塞）和 **full**（所有任务阻塞），分别给出 10s/60s/300s 的平均值。

```bash
# 解读 PSI 指标
cat /sys/fs/cgroup/kubepods.slice/cpu.pressure
# some avg10=5.23 avg60=3.15 avg300=1.08 total=12345678
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
# ↑ some=5.23 表示过去 10 秒平均有 5.23% 的时间有任务在等 CPU

# 使用 PSI 做主动 OOM（比直接 OOM 更平滑）
# 在 memory.pressure 的 some 指标超过阈值时主动驱逐低优先级 Pod
```

K8s 社区正在利用 PSI 做更智能的驱逐决策（替代粗暴的 `memory.available < 100Mi`）。

## 实践：从 v1 迁移到 v2

### 迁移前检查

```bash
# 1. 确认内核支持
grep cgroup /proc/filesystems
# 应有 nodev cgroup2

# 2. 确认当前运行模式
stat -fc %T /sys/fs/cgroup/
# cgroup2fs → v2
# tmpfs → v1

# 3. 检查 containerd/cri-o 配置
# containerd: /etc/containerd/config.toml
# [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
#   SystemdCgroup = true  ← 必须为 true

# 4. 检查 kubelet 启动参数
# --cgroup-driver=systemd  ← 推荐
```

### 迁移步骤

```bash
# step 1: 逐一 cordon + drain 节点
kubectl cordon node-1
kubectl drain node-1 --ignore-daemonsets --delete-emptydir-data

# step 2: 添加内核启动参数
# /etc/default/grub
GRUB_CMDLINE_LINUX="... systemd.unified_cgroup_hierarchy=1 cgroup_no_v1=all"
update-grub
reboot

# step 3: 验证
stat -fc %T /sys/fs/cgroup/  # cgroup2fs

# step 4: 恢复节点
kubectl uncordon node-1
```

### 迁移常见坑

| 问题 | 原因 | 解决 |
|------|------|------|
| 容器无法启动 | containerd/cri-o 未配置 SystemdCgroup=true | 检查 runtime 配置 |
| `kubectl top node` 显示内存异常 | cgroup v1/v2 统计口径不同（`total_inactive_file` 处理） | 升级 kubelet ≥ v1.27 |
| Prometheus cAdvisor 指标名变化 | v2 的路径和文件名不同 | 升级 cAdvisor ≥ v0.47 |
| GPU operator 异常 | NVIDIA GPU operator 旧版本不识别 v2 | 升级到 ≥ v23.6 |
| Java 应用 OOM | v2 下 `memory.stat` 含 kernel 内存（如 sock），实际可用更少 | 适当增大 limits，或降级内核 |

## 关联知识

- [[NUMA 架构与亲和性调优]] — cpuset 控制器的底层依赖
- [[大页内存与透明大页详解]] — hugetlb 是 cgroup v2 的控制器之一
- [[CPU 隔离与中断亲和性]] — cpuset + isolcpus 的组合运用
- [[../k8s/特性详解/Sidecar 容器详解]] — Sidecar 容器共用同一 Pod cgroup
- [[../k8s/特性详解/In-place Pod 资源更新详解]] — 原地更新依赖 cgroup 修改

## 参考资源

- 内核文档：https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
- cgroup v2 迁移指南：https://kubernetes.io/docs/concepts/architecture/cgroups/
- systemd cgroup 委托：https://systemd.io/CGROUP_DELEGATION/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 架构理解 | 2026-06-30 | 完成：v1/v2 架构差异、五大控制器、PSI、迁移实践 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-07

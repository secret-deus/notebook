---
date: 2026-06-30
tags:
  - linux
  - cpu
  - 中断
  - 性能调优
  - kubernetes
type: 学习笔记
category: 基础设施/Linux
source: https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html
difficulty: 高级
title: "CPU 隔离与中断亲和性"
---

# CPU 隔离与中断亲和性

## 概述

在 Kubernetes 节点上，系统进程（kubelet、containerd、sshd、监控 agent）与业务 Pod 共享 CPU。对于延迟敏感型工作负载（etcd、GPU 训练、DPDK、实时流处理），CPU 争抢会导致 p99 延迟井喷。CPU 隔离通过专属 CPU + tickless 模式 + 中断分散，把噪音降到最低。

> 一句话：CPU 隔离不是"给 Pod 更多 CPU"，而是"让 Pod 的 CPU **不被任何东西打扰**"。

## 问题根源：是什么在抢 CPU

即使 Pod 独占了 CPU，以下内核活动仍会打断用户进程：

| 干扰源 | 频率 | 影响 |
|------|:---:|------|
| **定时器中断（tick）** | 每秒 100-1000 次（`CONFIG_HZ`） | 每 1-10ms 暂停用户进程一次 |
| **RCU 回调** | 取决于 RCU 宽限期 | softirq 占用 CPU |
| **中断处理** | 网卡可达每秒百万次 | 硬中断 + softirq |
| **khugepaged / kcompactd** | 持续 | 内存压缩消耗 CPU |
| **kubelet 健康检查** | 每 10s | HTTP probe 使用 CPU |
| **Prometheus node_exporter** | 每 15s | 采集指标消耗 CPU |

CPU 隔离的目标是消除或最小化以上所有干扰。

## isolcpus —— 完全隔离 CPU

### 原理

`isolcpus` 告诉内核调度器：**不要主动把任何进程放到这些 CPU 上**。但做了 3 个不完美的地方：
1. 只影响 CFS 调度器，不影响内核线程和中断
2. 不影响实时调度类（SCHED_FIFO/SCHED_RR）
3. 隔离的 CPU 仍会收到定时器中断和软中断

```bash
# grub 启动参数
GRUB_CMDLINE_LINUX="isolcpus=4-15"
# CPU 0-3 给系统用，CPU 4-15 完全隔离给业务
```

### cgroup v2 cpuset → 更好的替代

cgroup v2 的 `cpuset` 可以动态分配（无需重启），且能被 K8s CPU Manager 管理：

```bash
# 创建隔离 cpuset
mkdir /sys/fs/cgroup/isolated
echo "4-15" > /sys/fs/cgroup/isolated/cpuset.cpus
echo "0" > /sys/fs/cgroup/isolated/cpuset.mems

# 把已运行的进程绑定到隔离 CPU
echo <pid> > /sys/fs/cgroup/isolated/cgroup.procs
```

> K8s v1.26+ 的 CPU Manager static policy 内部使用 cgroup cpuset 实现。

## nohz_full + rcu_nocbs —— Tickless + RCU offload

### nohz_full

内核的 `CONFIG_NO_HZ_FULL` 让 CPU 在只有单个可运行任务时**停止定时器中断**（tickless）。这对延迟敏感应用至关重要。

```bash
# grub 启动参数
GRUB_CMDLINE_LINUX="nohz_full=4-15"
```

条件：CPU 上必须只有 **一个** 可运行任务。如果有两个，tick 恢复。

### rcu_nocbs

将隔离 CPU 的 RCU 回调处理迁移到其他 CPU 上，彻底消除 RCU softirq 干扰：

```bash
GRUB_CMDLINE_LINUX="rcu_nocbs=4-15"
```

### 完整 grub 行示例

```bash
GRUB_CMDLINE_LINUX="... isolcpus=4-15 nohz_full=4-15 rcu_nocbs=4-15"
```

### 验证隔离效果

```bash
# 检查中断分布
cat /proc/interrupts | grep -E "CPU4 |CPU5 |CPU6 "
# 隔离 CPU 的中断数应远少于非隔离 CPU

# 检查 timer 中断
cat /proc/interrupts | grep -E "LOC:"
# 隔离 CPU 的 LOC (Local Timer Interrupts) 应很低

# 检查 RCU 回调迁移（1 = 已迁移）
cat /sys/devices/system/cpu/cpu4/rcu_expedited /sys/devices/system/cpu/cpu4/rcu_normal
# 都应为 1
```

## Kubelet CPU Manager

CPU Manager 是 K8s 提供的 CPU 亲和性机制。当 Pod 满足 `Guaranteed` QoS + `requests == limits` + CPU 为整数核时，kubelet 为其分配**独占 CPU**。

```yaml
# /var/lib/kubelet/config.yaml
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 5s
reservedSystemCPUs: "0-3"               # CPU 0-3 保留给系统进程
cpuManagerPolicyOptions:
  full-pcpus-only: true                 # 只分配完整的物理核（不跨 HT）
  distribute-cpus-across-numa: true     # 跨 NUMA 均匀分配
  align-by-socket: true                 # 按 Socket 对齐
```

Pod 资源配置：
```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: latency-critical
    resources:
      requests:
        cpu: 4                # 必须是整数核
        memory: 8Gi
      limits:
        cpu: 4                # 必须等于 requests
        memory: 8Gi
  # QoS: Guaranteed → 触发 CPU Manager exclusive allocation
```

验证 Pod 是否获得独占 CPU：
```bash
# 在节点上
cat /var/lib/kubelet/cpu_manager_state
# {"policyName":"static","defaultCpuSet":"0-3","entries":{"<pod-uid>":{"<container>":"4-7"}}}

# 在容器内
cat /sys/fs/cgroup/cpuset.cpus
# 4-7 ← 独占
```

### static vs none

| 策略 | 独占 CPU | 适用场景 |
|------|:---:|------|
| **none** | 无，所有 Pod 共享 CPU 池 | 通用多租户 |
| **static** | Guaranteed + 整数核 = 独占 | 延迟敏感应用 |

## 中断亲和性（IRQ Affinity）

即使 CPU 被 isolcpus 隔离，网卡中断仍可能落到隔离 CPU 上。需要通过 IRQ 亲和性（smp_affinity）将中断引导到系统 CPU。

### 手动配置

```bash
# 查看某网卡的所有中断号
grep mlx5_0 /proc/interrupts | awk -F: '{print $1}'

# 把 mlx5_0 的中断分散到 CPU 0-3（系统 CPU）
for irq in $(grep mlx5_0 /proc/interrupts | awk -F: '{print $1}'); do
  echo "0-3" > /proc/irq/$irq/smp_affinity_list
  # 或位掩码方式：echo 0f > /proc/irq/$irq/smp_affinity（0f = CPU0-3）
done

# 验证
cat /proc/interrupts | grep mlx5_0
# 确认每一列只有 CPU0-3 有数字，CPU4-15 为 0
```

### 高速网卡的多队列中断

现代网卡（Mellanox ConnectX、Intel E810）支持多队列 RSS（Receive Side Scaling），每个队列独立中断：

```bash
# 查看队列数
ethtool -l eth0
# Channel parameters for eth0:
# Pre-set maximums:
# RX:             63
# Combined:       63
# Current hardware settings:
# RX:             63

# 查看每个队列的中断
ls /proc/irq/ | while read irq; do
  grep -l "mlx5_0" /proc/irq/$irq/* 2>/dev/null && echo "IRQ $irq"
done

# 为每个队列分配独立 CPU（系统 CPU 池内轮询）
irqs=($(grep mlx5_0-rx /proc/interrupts | awk -F: '{print $1}'))
for i in $(seq 0 $((${#irqs[@]} - 1))); do
  cpu=$((i % 4))            # 轮询分配 CPU 0-3
  echo $cpu > /proc/irq/${irqs[$i]}/smp_affinity_list
done
```

### irqbalance 的正确用法

`irqbalance` 自动管理中断分配，但**默认行为不适合 CPU 隔离场景**（它可能将中断分配到隔离 CPU）。需要配置：

```bash
# /etc/sysconfig/irqbalance（RHEL）或 /etc/default/irqbalance（Debian）
IRQBALANCE_ARGS="--hintpolicy=exact"
IRQBALANCE_BANNED_CPUS="4-15"   # 禁止将中断分配到隔离 CPU
ONE_SHOT=1                      # 一次性分配后退出（不建议），或用 standard 模式
```

```bash
systemctl restart irqbalance
```

### 中断亲和性 vs RPS/RFS

中断亲和性只控制**硬中断**落在哪个 CPU。RPS（Receive Packet Steering）和 RFS（Receive Flow Steering）控制**软中断（softirq）**在哪个 CPU 处理：

```bash
# RPS：将网络包的软中断处理分散到多个 CPU
echo "0f" > /sys/class/net/eth0/queues/rx-0/rps_cpus   # CPU0-3

# RFS：根据应用所在 CPU 调度软中断
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries
echo 4096 > /sys/class/net/eth0/queues/rx-0/rps_flow_cnt
```

> 对于 CPU 隔离场景：RPS mask 应设为系统 CPU（0-3），而非隔离 CPU。

## 生产级 CPU 隔离方案

### 完整的节点初始化

```bash
#!/bin/bash
# cpu-isolation-init.sh

# 1. grub 参数（需重启生效）
# 编辑 /etc/default/grub:
# GRUB_CMDLINE_LINUX="isolcpus=4-15 nohz_full=4-15 rcu_nocbs=4-15"
# update-grub && reboot

# 2. 内核线程迁移到系统 CPU
# 重启后，把已存在的内核线程迁移到 CPU 0-3
for pid in $(pgrep -f "rcuog|rcu_preempt|kworker|ksoftirqd|migration"); do
  taskset -pc 0-3 $pid 2>/dev/null
done

# 3. 配置 irqbalance
mkdir -p /etc/irqbalance
echo "IRQBALANCE_BANNED_CPUS=4-15" > /etc/irqbalance/env
systemctl restart irqbalance

# 4. 网卡中断只分配到系统 CPU
for iface in eth0 mlx5_0; do
  for irq in $(grep "$iface" /proc/interrupts | awk -F: '{print $1}'); do
    echo 0-3 > /proc/irq/$irq/smp_affinity_list 2>/dev/null
  done
done

# 5. kubelet CPU Manager
cat > /var/lib/kubelet/config.yaml << EOF
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 5s
reservedSystemCPUs: "0-3"
cpuManagerPolicyOptions:
  full-pcpus-only: true
  distribute-cpus-across-numa: true
EOF

systemctl restart kubelet
```

### 验证清单

```bash
# ✓ 中断不落在隔离 CPU 上
cat /proc/interrupts | awk '{for(i=5;i<=16;i++) sum[i]+=$i} END {for(i=5;i<=16;i++) print "CPU"i-4": "sum[i]}'
# CPU 4-15 的中断数应远小于 CPU 0-3

# ✓ timer 中断被 tickless
cat /proc/interrupts | grep LOC | awk '{for(i=5;i<=NF;i++) if($i>0) print "CPU"i-4": "$i}' | sort -t: -k2 -nr

# ✓ 独占 CPU 的 Pod 正确分布
cat /var/lib/kubelet/cpu_manager_state

# ✓ 没有进程跑在隔离 CPU 上（除了期望的 Pod）
ps -eo pid,psr,comm | awk '$2>=4 && $2<=15 {print}' | grep -v "train\|etcd\|redis"
# 应该只显示你的关键进程
```

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 隔离 CPU 仍有中断 | irqbalance 将中断分配到了隔离 CPU | 配置 `IRQBALANCE_BANNED_CPUS` |
| isolcpus 后内核线程仍在隔离 CPU | isolcpus 不影响内核线程 | 手动 `taskset -pc 0-3 <pid>` |
| CPU Manager 未分配独占 CPU | Pod 不是 Guaranteed QoS 或 requests≠limits 或非整数核 | 确保 requests==limits 且为整数核 |
| nohz_full 不生效（仍有 tick） | CPU 上有多个可运行任务 | 检查 `cat /proc/stat` 的 runnable 数 |
| 独占 CPU 的 Pod 延迟仍然抖动 | `khugepaged`、`kcompactd` 等内核线程仍在隔离 CPU | `taskset` 迁移到系统 CPU |
| CPU Manager 分配了 HT 兄弟核 | 未设 `full-pcpus-only` | 启用该选项并要求 2 的幂次核数 |

## 关联知识

- [[cgroup v2 详解]] — CPU Manager 底层使用 cgroup v2 cpuset
- [[NUMA 架构与亲和性调优]] — CPU 隔离 + NUMA 绑定的组合
- [[网络内核参数调优]] — 网卡中断分散到系统 CPU
- [[大页内存与透明大页详解]] — khugepaged/kcompactd 应绑在系统 CPU
- [[../k8s/特性详解/etcd 运维详解]] — etcd 从 CPU 隔离中获益最大

## 参考资源

- 内核参数文档：https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html
- K8s CPU Manager：https://kubernetes.io/docs/tasks/administer-cluster/cpu-management-policies/
- nohz_full 文档：https://www.kernel.org/doc/html/latest/timers/no_hz.html
- RHEL tuned profile：https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 深度梳理 | 2026-06-30 | isolcpus、nohz_full、rcu_nocbs、CPU Manager、IRQ affinity、生产初始化脚本 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-07

---
date: 2026-06-29
tags:
  - k8s
  - nftables
  - kube-proxy
  - 网络
type: 学习笔记
category: 云原生/Kubernetes/网络
source: https://kubernetes.io/blog/2025/04/23/kubernetes-v1-33-release/
difficulty: 进阶
title: "nftables kube-proxy 详解"
---

# nftables kube-proxy 详解

## 概述

nftables 是 kube-proxy 的**新一代数据平面后端**，从 **v1.29 Alpha → v1.31 Beta 默认启用 → v1.33 GA**。它是继 iptables 和 ipvs 之后的第三种模式，解决 iptables 在大规模集群中的性能瓶颈。随着 **v1.35 kube-proxy ipvs 模式弃用**，nftables 将是唯一推荐的 Linux 数据平面后端。

> nftables 是 Linux 内核自 3.13（2014）起提供的下一代包过滤框架，统一了 iptables/ip6tables/arptables/ebtables 四套工具。

## 为什么需要 nftables

### iptables 的问题

| 问题 | 详情 |
|------|------|
| **线性匹配 O(n)** | 5,000 个 Service 时，每个包遍历 5,000 条规则，P99 延迟飙升 |
| **规则更新全量刷新** | 增删一个 Service → 重新构建所有 iptables 规则 → `iptables-restore` 原子替换 |
| **conntrack 竞争** | iptables 重度依赖 conntrack，高并发下 conntrack 表成为瓶颈 |
| **调试困难** | `iptables -L -n -v` 输出冗长，规则结构与语义脱节 |
| **IPv4/IPv6 分离** | iptables 和 ip6tables 两套独立规则，双栈集群规则翻倍 |

### nftables 的改进

| 优势 | 详情 |
|------|------|
| **原子规则更新** | 增删 Service → 仅修改相关 table/chain，无需全量重建 |
| **原生集合（Set）** | 用 `nft set` 存 IP:Port 映射，O(1) 查找 |
| **单框架双栈** | 同一 `nft` 规则表同时处理 IPv4 和 IPv6 |
| **内核态速率限制** | 直接在 nftables 规则中 `limit rate`，减少 conntrack 依赖 |
| **结构化输出** | `nft list ruleset` 输出 JSON，易于解析和调试 |

### 大规模集群性能对比（~5000 Service）

| 指标 | iptables | ipvs | nftables |
|------|:---:|:---:|:---:|
| 新建规则耗时 | ~30s | ~2s | ~1s |
| 规则更新耗时（增 1 个 Service） | ~30s（全量刷新） | ~2s | ~0.5s |
| 包转发 P99 延迟 | ~10ms | ~0.5ms | ~1ms |
| CPU 使用 | 高（线性扫描） | 低（IPVS hash） | 低（nft set hash） |
| 内核模块依赖 | 多（iptables/ip_tables/nf_conntrack 等 20+） | 少（ip_vs + nf_conntrack） | 极少（nf_tables） |
| 双栈支持 | 独立 iptables + ip6tables | 独立 ipvs + ip6vs | 同一规则表 |

## 核心概念

### kube-proxy 模式对比

```
iptables 模式：
  包 → PREROUTING → iptables 规则链（线性遍历）→ DNAT → POSTROUTING

ipvs 模式：
  包 → PREROUTING → IPVS 调度（round-robin / lc / sh）→ DNAT → POSTROUTING

nftables 模式：
  包 → PREROUTING → nftables 规则表（set 查找）→ DNAT → POSTROUTING
                     ↑
                 nft set { svc_ip:svc_port → [pod_ip:pod_port, ...] }
```

### nftables 规则结构

kube-proxy nftables 模式创建的典型规则结构：

```
table ip kube-proxy {
    # Service IP:Port → Endpoint IP:Port 映射集合
    set svc-ep-set {
        type ipv4_addr . inet_service . ipv4_addr . inet_service
        elements = {
            10.96.0.1 . 443 . 10.244.1.5 . 8443,
            10.96.0.10 . 53 . 10.244.2.3 . 53,
            ...
        }
    }

    chain kube-proxy-services {
        # 匹配 ClusterIP 的包，DNAT 到 endpoint
        ip daddr . tcp dport @svc-ep-set \
            dnat to ip saddr map { ... }
    }

    chain kube-proxy-nodeports {
        # NodePort 流量处理
        tcp dport { 30000-32767 } jump kube-proxy-services
    }
}
```

## 实战配置

### 启用 nftables 模式

```bash
# kube-proxy 配置文件方式
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
mode: nftables
nftables:
  masqueradeAll: false
  masqueradeBit: 14
  minSyncPeriod: 1s
  syncPeriod: 30s
```

```bash
# 或者通过 kubeadm 配置
# kubeadm-config.yaml
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
---
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
mode: nftables
```

### 从 iptables 迁移到 nftables

```bash
# 1. 确认内核版本 ≥ 5.13
uname -r                     # 需要 ≥ 5.13

# 2. 确认 nft 可用
nft --version

# 3. 逐个节点切换 kube-proxy 模式（建议逐个 DaemonSet Pod 重启）
kubectl -n kube-system rollout restart daemonset kube-proxy

# 4. 验证规则
NODE_IP=$(kubectl get node -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
ssh $NODE_IP "nft list ruleset | head -50"
```

### 从 ipvs 迁移到 nftables（v1.35 起强烈推荐）

```bash
# ipvs 模式已在 v1.35 弃用！
# 迁移前验证：

# 1. 清空旧 ipvs 规则（kube-proxy 切换模式后自动清理）
# 2. 确认 nftables 规则正确
ssh $NODE_IP "nft list table ip kube-proxy"

# 3. 验证 Service 可达性
kubectl run test --rm -it --image=busybox -- wget -qO- http://<cluster-ip>:<port>/health
```

### 验证规则与调试

```bash
# 查看所有 kube-proxy 创建的 nftables 规则
nft list ruleset | grep -A 5 kube-proxy

# 查看 Service → Endpoint 映射集合
nft list set ip kube-proxy svc-ep-set

# 查看 NodePort 规则
nft list chain ip kube-proxy kube-proxy-nodeports

# JSON 格式输出（可编程解析）
nft -j list ruleset | jq '.nftables'

# 监控规则变更
watch -n 1 'nft list set ip kube-proxy svc-ep-set | wc -l'
```

## 迁移检查清单

从 iptables/ipvs 迁移到 nftables 前需确认：

| 检查项 | 命令 | 预期 |
|--------|------|------|
| 内核版本 ≥ 5.13 | `uname -r` | ≥ 5.13 |
| `nf_tables` 模块加载 | `lsmod \| grep nf_tables` | 有输出 |
| 无自定义 iptables 规则依赖 | `iptables -L -n` | 仅 kube-proxy 相关 |
| NetworkPolicy 兼容（Calico/Cilium） | 查阅 CNI 文档 | Calico ≥ 3.27 / Cilium ≥ 1.15 |
| Conntrack 不依赖 iptables | 确认应用不使用 iptables NOTRACK | — |
| kube-proxy metrics 正常 | `curl localhost:10249/metrics \| grep nftables` | 有 sync_proxy_rules 指标 |

## 注意与限制

| 限制 | 说明 |
|------|------|
| **仅 Linux** | Windows 节点不支持 nftables，仍用 userspace 模式 |
| **内核版本** | 需 Linux kernel ≥ 5.13（RHEL 8.5+ / Ubuntu 22.04+ 满足） |
| **不支持 externalTrafficPolicy=Local** | nftables 模式下 Local 策略需要额外 conntrack 支持（某些内核版本有 bug） |
| **与 NetworkPolicy 的交互** | 取决于 CNI 实现。Cilium 不受影响（eBPF），Calico 需 ≥ 3.27 |
| **调试工具链** | 运维需熟悉 `nft` 命令替代 `iptables`（语法完全不同） |

## nft vs iptables 命令对照

| iptables 命令 | nftables 等价命令 |
|--------------|------------------|
| `iptables -L -n -v` | `nft list ruleset` |
| `iptables -t nat -L KUBE-SERVICES` | `nft list chain ip kube-proxy kube-proxy-services` |
| `iptables -S` | `nft list ruleset` |
| `iptables-save` | `nft list ruleset` |
| `conntrack -L` | `conntrack -L`（不变，conntrack 独立工具） |
| 查看规则计数器 | `nft list ruleset`（counter 字段） |
| 清空规则 | `nft flush ruleset`（危险！） |

## 常见问题 / 坑点

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 切换 nftables 后 NodePort 不可达 | `externalTrafficPolicy=Local` 兼容性 | 改用 `Cluster` 或升级内核 ≥ 6.1 |
| Service 更新慢（仍然 > 5s） | `minSyncPeriod` / `syncPeriod` 配置不当 | 调小 `minSyncPeriod` 到 100ms |
| `nft list ruleset` 规则为空 | kube-proxy 未正确初始化为 nftables 模式 | 检查 kube-proxy 日志 `kubectl -n kube-system logs ds/kube-proxy` |
| 旧 iptables 规则残留 | kube-proxy 切换模式时不自动清理 | 手动 `iptables -F -t nat` 并重启 kube-proxy |
| 某些 Pod 的 DNAT 不生效 | nft set 未完全同步 | 检查 `minSyncPeriod` 和 kube-proxy 日志 |

## 关联知识

- [[../versions/K8s 1.33 Octarine 详解]]（nftables GA 版本）
- [[../versions/K8s 1.35 Timbernetes 详解]]（ipvs 弃用版本）
- [[../versions/K8s 1.31 Elli 详解]]（nftables 默认启用 Beta 版本）
- [[../K8s 1.28-1.36 版本更新总结#主线 2：网络数据平面 — iptables → nftables]]

## 参考资源

- KEP-3866（nftables kube-proxy）：https://kep.k8s.io/3866
- 官方迁移指南：https://kubernetes.io/docs/reference/networking/virtual-ips/#migrating-from-iptables-mode-to-nftables
- nftables wiki：https://wiki.nftables.org/
- nftables 从 iptables 迁移：https://wiki.nftables.org/wiki-nftables/index.php/Moving_from_iptables_to_nftables

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 初次学习 | 2026-06-29 | 理解 iptables/ipvs/nftables 差异 |
| 深入理解 | | 测试集群切换 nftables |
| 实战应用 | | 生产环境 nftables 迁移 |

---

**状态**: 📖 已掌握

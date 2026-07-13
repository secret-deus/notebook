---
date: 2026-06-30
tags:
  - k8s
  - cni
  - network
  - calico
  - cilium
  - flannel
type: 学习笔记
category: 云原生/Kubernetes/网络
source: https://www.cni.dev/
difficulty: 进阶
title: "CNI 网络插件对比与排障"
---

# CNI 网络插件对比与排障

## 概述

CNI（Container Network Interface）是 CNCF 孵化的容器网络标准规范，定义了容器运行时如何配置网络接口。Kubernetes 不内置网络实现，而是通过 CNI 插件赋予每个 Pod 唯一的 IP 地址，并实现跨节点 Pod 通信。选对 CNI 插件直接影响集群的性能、可观测性和安全性。

> 一句话：**K8s 只管「我想让 Pod 有 IP」，CNI 插件负责「具体怎么给 IP + 怎么通」**。

## CNI 规范核心概念

CNI 规范（v1.0.0）定义了三个基本操作：

| 操作 | 触发时机 | 说明 |
|------|---------|------|
| **ADD** | 创建 Pod 时 | 分配 IP、创建 veth pair、配置路由 |
| **DEL** | 删除 Pod 时 | 回收 IP、删除 veth pair、清理路由 |
| **CHECK** | 周期性检查 | 验证容器网络配置一致性 |

```
Pod 创建 → CRI 调用 → kubelet → CNI Plugin (ADD)
  → 分配 IP（从 IPAM）
  → 创建 veth pair（一端在 Pod ns，一端在 host）
  → 配置路由规则
  → 返回结果给 kubelet
```

## 三大主流 CNI 插件

### Flannel —— 最简单

Flannel 只做一件事：**给每个 Node 分配一个子网，Pod IP 在子网内分配，跨节点通过 Overlay 隧道转发**。没有网络策略、没有可观测性、没有高级特性。

**架构**：

```
Node1 (subnet 10.244.1.0/24)          Node2 (subnet 10.244.2.0/24)
  Pod-A (10.244.1.5)                    Pod-B (10.244.2.8)
    ↓ veth                                ↓ veth
  cni0 bridge                           cni0 bridge
    ↓                                    ↓
  flanneld (encap/decap)  ←VXLAN→  flanneld (encap/decap)
```

| 维度 | 详情 |
|------|------|
| **后端模式** | VXLAN（默认）、host-gw（同 L2）、UDP（淘汰）、WireGuard（实验性） |
| **包封装** | VXLAN 模式：原始包外包一层 UDP + VXLAN 头，有 50 字节额外开销 |
| **MTU** | VXLAN 下必须降到 1450（1500 - 50） |
| **网络策略** | ❌ 不支持 |
| **IPAM** | 每个 Node 分配 `/24` 子网，host-local |
| **安装** | `kubectl apply -f flannel.yaml` |
| **适用场景** | 开发/测试环境、简单集群、不想折腾网络 |

### Calico —— 高性能 + 策略丰富

Calico 支持两种数据面模式：**纯路由（BGP）** 和 **Overlay（IPIP/VXLAN）**。BGP 模式下 Pod IP 直接路由，无封装开销。

**BGP 模式路由**：

```bash
# Node1 路由表
10.244.1.0/24 dev cali-xxx  scope link    # 本节点 Pod
10.244.2.0/24 via 192.168.1.11 dev eth0   # Node2 Pod（BGP 播布）

# Pod-A(10.244.1.5) → Pod-B(10.244.2.8)
# 包直接从 Node1 eth0 → Node2 eth0 → cali-xxx 进入 Pod
# 零封装，性能接近裸金属网络
```

**三种数据面模式**：

| 模式 | 原理 | 封装开销 | 跨子网 | BGP 要求 |
|------|------|:---:|:---:|:---:|
| **BGP** | Pod IP 通过 BGP 播布到路由器/其他节点 | 无 | ❌ 需底层路由可达 | ✅ 必须 |
| **IPIP** | 原始 IP 包外封 IPIP 头，通过隧道转发 | 20 字节 | ✅ | ❌ 可选 |
| **VXLAN** | 原始帧外封 VXLAN 头 | 50 字节 | ✅ | ❌ 可选 |
| **eBPF** | 使用 eBPF 替代 kube-proxy + iptables | 无 | 取决于底层 | ❌ |

**关键特性**：

| 特性 | 说明 |
|------|------|
| **NetworkPolicy** | 原生 K8s NetworkPolicy + Calico 扩展（GlobalNetworkPolicy、Tiered Policy） |
| **IPAM** | 支持 host-local（默认）和 Calico IPAM（按 IP Pool 分配，支持预留） |
| **WireGuard** | 数据面加密，配置一条 wireguard 隧道即可 |
| **eBPF 模式** | 替代 kube-proxy，直接在内核处理 Service 转发，延迟更低、吞吐更高 |

```yaml
# Calico IPPool 示例
apiVersion: crd.projectcalico.org/v1
kind: IPPool
metadata:
  name: default-pool
spec:
  cidr: 10.244.0.0/16
  ipipMode: CrossSubnet    # 同子网 BGP，跨子网 IPIP
  vxlanMode: Never
  natOutgoing: true
```

### Cilium —— eBPF 原生

Cilium 完全基于 eBPF，在内核层面实现负载均衡、网络策略、可观测性。没有 iptables、没有 kube-proxy、没有 overlay 封装开销。

**核心优势**：

```
传统 kube-proxy (iptables):
  Service VIP → iptables DNAT → 随机选择 Endpoint
  每个 Service 产生大量 iptables 规则，O(n) 查找，更新时规则替换开销大

Cilium (eBPF):
  Service VIP → eBPF map 查询 → 直接找到 Endpoint
  O(1) 查找，原子更新，无规则爆炸
```

| 特性 | 说明 |
|------|------|
| **数据面** | eBPF（无 kube-proxy），KPR（kube-proxy replacement） |
| **网络模式** | Direct Routing（同子网直接路由）、VXLAN/Geneve Tunnel（跨子网） |
| **NetworkPolicy** | K8s NetworkPolicy + CiliumNetworkPolicy（L3/L4/L7，DNS/FQDN 策略，HTTP/gRPC/ Kafka 协议感知） |
| **L7 策略** | 可按 HTTP Method、Path、Header 做准入控制 |
| **可观测性** | Hubble（实时服务拓扑、流日志、L7 可视化） |
| **服务网格** | 内置 Sidecar-less Service Mesh（支持 mTLS、Ingress、Gateway API） |
| **带宽管理** | 按 Pod 限速（BandwidthManager） |
| **集群网格** | ClusterMesh（跨集群服务发现和负载均衡） |

```yaml
# CiliumNetworkPolicy：只允许 GET /api/health
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-policy
spec:
  endpointSelector:
    matchLabels:
      app: api-server
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: GET
                path: "/api/health"
```

## 三大插件对比总表

| 维度 | Flannel | Calico | Cilium |
|------|:---:|:---:|:---:|
| **复杂度** | ⭐ 极低 | ⭐⭐⭐ 中等 | ⭐⭐⭐⭐ 较高 |
| **性能** | 中（VXLAN 封装） | 高（BGP 无封装）/ 中（IPIP） | **最高**（eBPF 零开销） |
| **网络策略** | ❌ | ✅ K8s + Calico 扩展 | ✅ K8s + Cilium L7/TLS/DNS/FQDN |
| **可观测性** | ❌ | 基础（Calico Cloud/Typha） | ✅ Hubble（L3/L4/L7 流日志+服务拓扑） |
| **Service 代理** | kube-proxy iptables | kube-proxy / eBPF 替代 | eBPF 替代 kube-proxy（KPR） |
| **服务网格** | ❌ | ❌ | ✅ 内置（mTLS、Gateway API） |
| **加密** | WireGuard（实验性） | WireGuard | WireGuard + IPsec |
| **跨集群** | ❌ | ❌ | ✅ ClusterMesh |
| **GPU 场景** | ❌ 无优化 | 可用 | ✅ 支持 RDMA、带宽管理 |
| **安装方式** | `kubectl apply` | Operator / `kubectl apply` | Helm / CLI |
| **适用场景** | 开发/测试、边缘 | **企业生产、混合云、BGP 数据中心** | 高性能、零信任、可观测性优先、GPU 集群 |

## 选型决策树

```
需要网络策略？
├── 不需要 → Flannel
└── 需要
    ├── 只需要 L3/L4 策略，追求简单 → Calico
    └── 需要 L7 策略（HTTP Header/Method）、可观测性、服务网格
        ├── eBPF 内核 ≥ 5.10 → Cilium
        └── 旧内核，无法用 eBPF → Calico
```

## 排障流程

### 通用排查路径

```
Pod 间网络不通
  → 1. Pod 有 IP 吗？
    → kubectl get pod -o wide（检查 IP 栏）
    → 如果 <none> → CNI 插件未正常工作
  → 2. 同节点两个 Pod 能通吗？
    → kubectl exec pod-a -- ping <pod-b-ip>
    → 如果同节点不通 → CNI 网桥/路由问题
  → 3. 跨节点 Pod 能通吗？
    → 如果跨节点不通 → Overlay 隧道或 BGP 路由问题
  → 4. Pod → Service 能通吗？
    → kubectl exec pod -- curl <svc-cluster-ip>:<port>
    → 如果不通 → kube-proxy 或 eBPF Service 转发问题
  → 5. Pod → 外部 能通吗？
    → kubectl exec pod -- curl 8.8.8.8
    → 如果不通 → NAT/Masquerade 或 DNS 问题
  → 6. DNS 解析正常吗？
    → kubectl exec pod -- nslookup kubernetes.default
    → 如果失败 → CoreDNS 或 CNI DNS 代理问题
```

### Flannel 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| Pod 跨节点不通 | VXLAN 端口（8472 UDP）被防火墙阻断 | 放行 8472/UDP |
| MTU 导致大包丢包 | VXLAN 封装超过物理网卡 MTU | Pod 网卡 MTU 设为 1450 |
| Node 间 Pod CIDR 冲突 | `flanneld` 分配了同样的子网 | 重启 flannel Pod，检查 etcd/kube-subnet-mgr |

```bash
# Flannel 排查命令
kubectl get nodes -o jsonpath='{.items[*].spec.podCIDR}'                 # 检查 Node CIDR
kubectl -n kube-flannel logs -l app=flannel --tail=200                    # 查看 flanneld 日志
ip route | grep flannel                                                   # 查看主机路由
```

### Calico 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `calico-node` Readiness 失败 | Bird（BGP daemon）无法与 Peer 建立连接 | 检查 BGP Peer 配置、防火墙 179/TCP |
| Pod IP 分配失败 | IPPool 耗尽 | 增大 CIDR 或增加新的 IPPool |
| 跨子网 Pod 不通 | IPIP 模式下 BGP 路由未生效 | 检查 `calicoctl node status`，确认 BGP Established |
| iptables 规则爆炸 | 大量 NetworkPolicy + Service | 切换到 eBPF 模式或减少 iptables 规则 |

```bash
# Calico 排查命令
calicoctl node status                                    # BGP 状态
calicoctl get ippool -o wide                             # IPPool 使用率
calicoctl get felixconfiguration default -o yaml         # Felix 配置
kubectl -n calico-system logs -l app=calico-node         # 节点日志
```

### Cilium 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| Cilium 未就绪 | 内核版本不支持 eBPF | 升级内核 ≥ 5.10（推荐 5.15+） |
| Hubble 无数据 | Hubble Relay 未启用或端口不通 | `cilium hubble enable` |
| Service 负载不均 | eBPF 使用了 Maglev 一致性哈希 | 检查 `cilium config` 的 `loadBalancer.algorithm` |
| kube-proxy replacement 异常 | 与 iptables kube-proxy 冲突 | 确认 kube-proxy 已禁用 |

```bash
# Cilium 排查命令
cilium status                                            # 整体状态
cilium connectivity test                                 # 连接性测试
cilium endpoint list                                     # 所有 Endpoint
hubble observe --from-pod default/nginx                  # 实时流日志
kubectl -n kube-system exec -it cilium-xxx -- cilium-dbg bpf lb list  # eBPF LB 映射
```

## 关联知识

- [[../gateway-api/Gateway API 概述]] — Gateway API 在 Cilium 中直接集成，无需额外 Ingress Controller
- [[nftables kube-proxy 详解]] — Calico eBPF 和 Cilium KPR 都旨在替代 iptables kube-proxy
- [[../versions/K8s 1.36 Haru 详解]] — v1.36 增强了 Service 流量分发与节点网络健康检测
- [[kagent 详解]] — kagent 依赖 Istio/Ambient Mesh 做 Agent 通信的 mTLS，CNI 是底层基础

## 参考资源

- CNI 规范：https://www.cni.dev/
- Calico 文档：https://docs.tigera.io/calico/latest/
- Cilium 文档：https://docs.cilium.io/
- Flannel 文档：https://github.com/flannel-io/flannel
- Cilium eBPF 数据面：https://docs.cilium.io/en/stable/network/ebpf/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 对比理解 | 2026-06-30 | 完成：Flannel/Calico/Cilium 架构差异、选型决策、排障流程 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-07

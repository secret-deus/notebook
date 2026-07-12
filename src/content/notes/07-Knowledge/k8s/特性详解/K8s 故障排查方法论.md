---
date: 2026-07-08
tags:
  - k8s
  - 故障排查
  - 诊断
  - 运维
type: 学习笔记
category: 云原生/Kubernetes/运维
source: https://kubernetes.io/docs/tasks/debug/
difficulty: 高级
title: "K8s 故障排查方法论"
---

# K8s 故障排查方法论

## 概述

K8s 故障排查不是一条一条翻 kubectl 命令。120+ 微服务的集群，每出现一个故障就从头查一遍是不可持续的。需要一套**系统化的排查框架**——每一步缩小故障域、每一步排除一类问题、每一步有明确的「下一动作」而不依赖经验。

> 一条核心原则：永远从控制面往下查。控制面 → 节点 → Pod → 容器 → 应用日志。因为下面的问题可能是上面引发的，但上面的问题不可能是下面引发的。

## 排查框架

```
Level 1: 控制面（API Server / etcd / Controller Manager / Scheduler）
  ↓ 控制面异常 → 下面全异常
Level 2: 节点（Node Ready / 资源/ 磁盘 / kubelet / 容器运行时）
  ↓ 节点异常 → 该节点上 Pod 全异常
Level 3: Pod（调度 / 镜像 / 启动 / 探针 / 资源）
  ↓ Pod 异常 → 单个服务不可用
Level 4: 网络（Service / Ingress / DNS / NetworkPolicy）
  ↓ 网络异常 → 服务间通信用
Level 5: 存储（PV / PVC / StorageClass / CSI）
  ↓ 存储异常 → 有状态服务不可用
Level 6: 应用层（配置 / 日志 / 探针 / 依赖服务）
```

每层的排查命令速查：

| 层级 | 第一个命令 | 作用 |
|------|------|------|
| 控制面 | `kubectl get componentstatuses` | 检查 API Server/etcd/scheduler 健康 |
| 节点 | `kubectl describe node <name>` | 查看 Conditions（Ready/MemoryPressure/DiskPressure）和 Events |
| Pod | `kubectl describe pod <name> -n <ns>` | 查看 Events（最全的故障线索） |
| 网络 | `kubectl exec <pod> -n <ns> -- curl -v <svc>:<port>` | 端到端连通性 |
| 存储 | `kubectl describe pvc <name> -n <ns>` | PVC 绑定状态 |
| 应用 | `kubectl logs <pod> -n <ns> --tail=100` | 应用日志第一现场 |

## 11 个典型故障案例

### 案例 1：Pod 一直 Pending

**现象**：`kubectl get pods` 显示 `STATUS: Pending`，超过 5 分钟未调度。

**排查步骤**：

```bash
# Step 1: 看 Events——这是最重要的线索来源
kubectl describe pod <pending-pod> -n <ns> | grep -A 20 Events

# 根据 Events 判断根因：

# Events 显示: 0/3 nodes are available: 1 node(s) had untolerated taint {nvidia.com/gpu: }, 2 Insufficient cpu.
```

| Events 信息 | 根因 | 修复 |
|------|------|------|
| `insufficient cpu/memory` | 所有节点资源不足 | HPA 扩容节点 或 降低 requests |
| `untolerated taint` | Pod 没有匹配 Node 的 toleration | 添加正确的 toleration 或移除 taint |
| `node(s) didn't match Pod's node affinity rules` | nodeSelector/nodeAffinity 不匹配 | 检查 selector 是否指向了不存在的 label |
| `pod has unbound immediate PVC` | PVC 无法绑定 | 检查 PVC 的 StorageClass 是否就绪 |
| `0/3 nodes: 3 pod has hostPort xxx` | hostPort 冲突（同节点已有 Pod 占用） | 使用 hostPort 的两个 Pod 调到不同节点 |

```bash
# 补充检查
kubectl describe node <node> | grep -A5 "Allocated resources"
# 看节点的资源分配率。CPU requests > 80% → 马上可能出问题
kubectl top node <node>
# 实际使用量 vs requests 的差异
```

### 案例 2：ImagePullBackOff

**现象**：Pod Events 中 `Failed to pull image "xxx": ...`

**排查流程**——四个最常见的原因和对应诊断：

```bash
# 1. 镜像 tag 不存在（最常见）
kubectl describe pod <pod> | grep -A5 Events
# Failed to pull image "registry.example.com/health-ack:v2.3.1": manifest for ... not found
# → 确认 tag 是否正确、CI 是否构建成功

# 2. Registry 认证失败
# Events: pull access denied / authorization failed
kubectl get secret <pull-secret> -n <ns> -o yaml
# 检查 .dockerconfigjson 中的凭据是否过期

# 3. Registry 不可达（DNS 或网络）
kubectl run test --rm -it --image=alpine -- sh -c "nslookup registry.example.com"
kubectl run test --rm -it --image=alpine -- sh -c "wget -O- https://registry.example.com/v2/"

# 4. 节点磁盘满（镜像拉取失败但表面上原因不明显）
kubectl describe node <node> | grep DiskPressure
# 如果 True → 清理节点磁盘或扩容
```

### 案例 3：CrashLoopBackOff

**现象**：容器启动 → 立即退出 → kubelet 重启 → 再退出 → 指数退避重启。

**这不是根因，是症状。** CrashLoopBackOff 表示「容器的主进程以非 0 退出码退出」。需要查**为什么退出**。

```bash
# Step 1: 查看上一次崩溃的日志（--previous 是关键）
kubectl logs <pod> -n <ns> --previous --tail=50

# Step 2: 查看退出原因
kubectl describe pod <pod> | grep -A5 "Last State"
# Exit Code: 1   → 应用内部错误（代码 panic、配置错误）
# Exit Code: 137  → OOMKilled（被内核 kill）
# Exit Code: 143  → SIGTERM（正常终止信号，可能是资源不足被驱逐或 kubelet 要求退出）
# Exit Code: 139  → SIGSEGV（段错误，内存访问越界）
# Reason: OOMKilled → 内存超限

# Step 3: 如果是 OOMKilled
kubectl top pod <pod> -n <ns>          # 看实际内存使用
kubectl describe pod <pod> | grep -A2 "Limits\|Requests"
# limits.memory 是否太小？
# requests.memory 是否至少等于应用正常运行所需的最小值？

# 容器内没有 logs 文件（/dev/termination-log 为空）→ 容器启动过程中就崩溃了
```

### 案例 4：Readiness Probe 失败

**现象**：Pod Running 但 `READY: 0/1`，Service 不转发流量。

```bash
# 查看探针配置和失败历史
kubectl describe pod <pod> -n <ns> | grep -A10 "Readiness\|Liveness"
# 关键信息：
#   Readiness:  http-get http://:8080/api/health delay=10s period=5s timeout=3s failure=3
#   Warning  Unhealthy  10s (x15 over 2m)  Readiness probe failed: Get "http://x.x.x.x:8080/api/health": dial tcp: connection refused

# 诊断：
# 1. "connection refused" → 应用还没监听 8080 端口（启动太慢）
#    → 调大 initialDelaySeconds
# 2. "HTTP 503" → 应用在运行但 /api/health 返回 503
#    → 检查依赖（数据库、Nacos 等）是否就绪
# 3. 超时 (timeout after 3s) → 健康检查端点本身执行太慢
#    → 优化 /api/health 的性能 或 调大 timeoutSeconds

# 直接在 Pod 内验证探针
kubectl exec <pod> -n <ns> -- curl -v http://localhost:8080/api/health
```

### 案例 5：Service 不通

**现象**：Pod A 通过 Service ClusterIP 调 Pod B，返回 `connection refused` 或超时。

```bash
# 诊断清单（顺序执行，每一步都排除一类可能性）

# 1. Pod 本身是否正常？
kubectl get pods -n <ns> -l app=<svc-selector>
kubectl describe pod <pod> -n <ns> | grep -E "Ready|Conditions"

# 2. Endpoints 是否正确？
kubectl get endpoints <svc> -n <ns>
# 如果 ENDPOINTS 列为空 → Service selector 没有匹配到 Pod
kubectl get pods -n <ns> -l app=health-ack --show-labels
# 对比 Service 的 spec.selector 和 Pod 的 labels 是否一致

# 3. 网络连通性（从源 Pod 内测试）
kubectl exec <source-pod> -n <src-ns> -- sh -c "
  echo '=== DNS ==='
  nslookup <svc>.<ns>.svc.cluster.local        # DNS 解析是否正常？
  echo '=== TCP ==='
  timeout 5 bash -c 'cat < /dev/tcp/<svc>/<port>' 2>&1   # TCP 能通吗？
  echo '=== HTTP ==='
  curl -v --max-time 5 http://<svc>.<ns>:<port>/health
"

# 4. NetworkPolicy 拦截？
kubectl get networkpolicies -n <ns>
# 如果存在 deny-all → 逐一检查是否有 allow 白名单规则
```

### 案例 6：Ingress 返回 502 Bad Gateway

对应你之前遇到的 api-tpa Ingress 问题。

```bash
# Step 1: 检查后端 Service 和 Endpoint
kubectl get ingress <name> -n <ns> -o yaml | grep -A5 backend
kubectl get endpoints <backend-svc> -n <ns>
# 如果 ENDPOINTS 列为空 → 确认 Pod Ready

# Step 2: 检查 Ingress Controller 日志
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller --tail=200 | grep <host>
# 或者 Istio Gateway:
kubectl logs -n istio-system deployment/istio-ingressgateway --tail=200

# Step 3: 检查 Ingress Controller 是否正确 reload 了配置
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- cat /etc/nginx/nginx.conf | grep <host>
# 如果 reload 失败 → Events 中会有 "configmap reload failure" 或类似信息

# Step 4: 验证 SSL 证书
openssl s_client -connect <host>:443 -servername <host> 2>&1 | grep -A2 "Verify return code"
# 不匹配 → 检查 tls.secretName 是否存在且证书域名匹配
```

### 案例 7：Node NotReady

**现象**：`kubectl get nodes` 中某节点 `STATUS: NotReady`。

```bash
# Step 1: 看节点 Events
kubectl describe node <node> | tail -30
# 关键 Conditions:
#   MemoryPressure: True  → 内存不够，kubelet 开始驱逐 Pod
#   DiskPressure: True    → 磁盘不够
#   PIDPressure: True     → 进程数超限
#   NetworkUnavailable: True → CNI 未正确初始化

# Step 2: SSH 到节点，检查 kubelet 状态
ssh <node> "systemctl status kubelet"
# 如果 kubelet down → 查看 journal
ssh <node> "journalctl -u kubelet -n 100 --no-pager"

# Step 3: 检查容器运行时
ssh <node> "crictl ps"      # containerd/CRI-O 是否正常
ssh <node> "df -h /"        # 根分区是否写满
ssh <node> "df -h /var/lib/containerd"

# Step 4: 如果节点无响应甚至 SSH 不上
# 进入到云平台控制台查看节点状态
# 如果无法恢复 → cordon + drain + 替换节点
kubectl cordon <node>
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
```

### 案例 8：Pod Pending（反亲和规则冲突）

对应你遇到的 Deployment 反亲和导致的 Pending 问题。

```bash
kubectl describe pod <pod> -n <ns> | grep -A10 Events
# Events: 0/3 nodes are available: 3 node(s) didn't match pod anti-affinity rules

# 检查 Deployment 的反亲和配置
kubectl get deployment <name> -n <ns> -o yaml | grep -A20 affinity
# spec.template.spec.affinity.podAntiAffinity:
#   requiredDuringSchedulingIgnoredDuringExecution:
#     - topologyKey: kubernetes.io/hostname  → 每个节点只能有一个 Pod
#       labelSelector: { matchLabels: { app: xxx } }

# 问题：replicas=3，但只有 2 个节点 → 至少一个 Pod 永远无法调度
# 解决：
#   1. 增加节点数 ≥ replicas
#   2. 改为 preferredDuringScheduling（软反亲和，尽量但不强制）
#   3. 改用 podAffinity（同节点）而非 podAntiAffinity
```

### 案例 9：DNS 解析异常（间歇性超时）

K8s DNS 的经典问题：部分 Pod 的 DNS 解析间歇性失败或延迟 5 秒。

```bash
# Step 1: 验证 CoreDNS Pod 健康
kubectl get pods -n kube-system -l k8s-app=kube-dns

# Step 2: 检查 CoreDNS 日志
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=100

# Step 3: 从 Pod 内测试 DNS 解析
kubectl exec <pod> -n <ns> -- nslookup kubernetes.default

# 常见根因：
# 1. CoreDNS OOM → 日志中有 "OOMKilled"
#    → 增大 CoreDNS 的 memory limits
# 2. conntrack 表满（UDP DNS 查询用 conntrack，高并发下溢出）
#    → 增大 nf_conntrack_max
# 3. ndots 配置不当（默认 ndots:5，导致多级 DNS 查询链）
#    → Pod spec: dnsConfig.options: [{name: ndots, value: "2"}]
# 4. CoreDNS cache 未命中率太高
#    → 启用 CoreDNS cache plugin: cache 30
```

### 案例 10：etcd 写空间满

```bash
# 症状：
# kubectl apply 任何资源返回: etcdserver: mvcc: database space exceeded
# 集群所有写操作被拒绝（只读）

# 紧急修复：
# 1. 碎片整理
ETCDCTL_API=3 etcdctl defrag --endpoints=https://127.0.0.1:2379

# 2. 若 defrag 后仍告警→ compact（压缩历史版本）
rev=$(etcdctl endpoint status --write-out=json | jq -r '.[0].Status.header.revision')
etcdctl compact $rev
etcdctl defrag

# 3. 根本解决：配 auto-compaction
# etcd 启动参数: --auto-compaction-mode=periodic --auto-compaction-retention=1h
```

### 案例 11：证书过期

kubeadm 部署的集群，所有证书 1 年有效期。

```bash
# 检查所有证书过期时间
kubeadm certs check-expiration

# 如果即将过期：
kubeadm certs renew all
# 重启控制面组件：
crictl ps | grep -E "kube-apiserver|kube-controller|kube-scheduler|etcd" | awk '{print $1}' | xargs -I {} crictl stop {}

# 如果不 renew 的后果：
# API Server 拒绝所有 kubectl 请求 → 看上去像集群挂了
# 检查 apiserver 日志: x509: certificate has expired
```

## 通用排查工具包

```bash
# 1. 一次性看所有 namespace 的异常 Pod
kubectl get pods -A --field-selector=status.phase!=Running \
  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,STATUS:.status.phase,NODE:.spec.nodeName

# 2. 最近 1 小时的所有 Events（最全的问题线索）
kubectl get events -A --sort-by='.lastTimestamp' | tail -50

# 3. 查看资源 top（CPU/内存实际使用）
kubectl top nodes
kubectl top pods -A --sort-by=memory | tail -20

# 4. 所有 namespace 的 NotReady 节点
kubectl get nodes --field-selector=spec.unschedulable=true

# 5. 查看某个 Pod 的资源使用详情（cgroup 层面）
kubectl exec <pod> -n <ns> -- cat /sys/fs/cgroup/memory.current
# 或 kubectl top pod <pod> -n <ns> --containers

# 6. Debug 容器（K8s v1.31+）
kubectl debug <pod> -n <ns> -it --image=alpine --target=<container>
# 进入一个临时容器（共享同一个 PID namespace），不影响原容器
```

## 关联知识

- [[etcd 运维详解]] — etcd 空间写满案例的详细处理
- [[CNI 网络插件对比与排障]] — Service 不通时的 CNI 层面排查
- [[../linux/网络内核参数调优]] — DNS 间歇性超时与 nf_conntrack 的关系
- [[Istio 服务网格详解]] — 引入 Istio 后 503 的三个新增根因
- [[容器运行时深度对比]] — Node NotReady 时 containerd 层面的排查

## 参考资源

- K8s 调试文档：https://kubernetes.io/docs/tasks/debug/
- kubectl debug：https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/
- K8s Events 参考：https://kubernetes.io/docs/reference/kubectl/generated/kubectl_events/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 方法论 | 2026-07-08 | 6 层排查框架 + 11 个典型案例（你遇到的场景全覆盖） |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-15

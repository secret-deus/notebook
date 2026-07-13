---
date: 2026-07-06
tags:
  - k8s
  - security
  - pss
  - rbac
  - network-policy
  - 安全加固
type: 学习笔记
category: 云原生/Kubernetes/安全
source: https://kubernetes.io/docs/concepts/security/
difficulty: 进阶
title: "K8s 安全加固实战"
---

# K8s 安全加固实战

## 概述

120+ 微服务集群的安全不是「配一个 NetworkPolicy 就没事了」。K8s 安全有 4 层防御纵深：代码 → 容器 → Pod → 集群。每层都有攻击面，每层都需要独立加固。K8s 提供了 Pod Security Standards（准入拦截）、NetworkPolicy（微分段）、RBAC（权限）、审计日志（溯源）四类内置安全机制，但这只是起点——镜像扫描、Secret 管理、运行时检测才是生产标配。

> 一句话：没有攻不破的防线。安全的目标不是防住所有攻击，而是让入侵者每走一步都要绕过一个新的防线——增加攻击成本到不值得继续为止。

## 你集群的威胁模型（120+ 微服务场景）

```
威胁源 1: 被入侵的前端服务 ← 最常见的入口
  → 攻击者获得 frontend Pod 的 shell
  → 尝试连接内部数据库、读取 Secret、横向移动到其他 Pod
  → 尝试利用高权限 ServiceAccount，调用 K8s API

威胁源 2: 恶意或不规范的内部服务
  → 某服务代码中存在 SSRF，被利用扫描 VPC 内网
  → 某服务误用了 cluster-admin ServiceAccount

威胁源 3: 供应链攻击
  → 镜像中藏有后门
  → 基础镜像包含已知漏洞

威胁源 4: 配置失误
  → kubectl apply 了 dev 环境的宽松配置到 prod
  → 人类操作失误（最常见的 root cause）
```

## 第一层：Pod Security Standards（准入拦截）

PSS 是 K8s v1.25 GA 的特性，替代了 PodSecurityPolicy。它在**准入阶段**拦截不安全的 Pod 配置。

### 三级 Profile

| Profile | 限制什么 | 允许的特权操作 | 适用 |
|------|------|------|------|
| **Privileged** | 无限制 | 全部 | 系统级 Pod（CNI、CSI、kube-proxy） |
| **Baseline** | 阻止已知的提权手段 | 无特权操作 | **默认的最低保底** |
| **Restricted** | 最严格 | 几乎不允许任何特权配置 | 业务 Pod 的最终目标 |

### Baseline 拦截的关键危险配置

| 拦截项 | 为什么危险 |
|------|------|
| `hostNetwork: true` | Pod 直接使用宿主机网络，绕过 CNI/NetworkPolicy |
| `hostPID: true` | Pod 能看到宿主机所有进程 |
| `hostIPC: true` | Pod 能访问宿主机共享内存段 |
| `privileged: true` | 容器获得宿主机的所有能力 |
| `SYS_ADMIN` capability | 几乎等于 root，可 mount、加载内核模块 |
| `hostPath` volume | 直接读写宿主机文件系统 |
| `allowPrivilegeEscalation: true` | 子进程可以获得比父进程更多的特权 |

### Restricted 额外要求

Basline 之上，Restricted 还强制：
- **必须 drop 所有 capabilities**（`drop: [ALL]`），然后按需加特定 capability（如 `NET_BIND_SERVICE`）
- **必须 runAsNonRoot**（容器不能用 root 用户运行）
- **必须 seccomp 配置**（限制系统调用白名单）

### 配置 PSS —— 分步收紧

```yaml
# 1. 给 kube-system 放宽（系统 Pod 需要特权）
apiVersion: v1
kind: Namespace
metadata:
  name: kube-system
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
---
# 2. 业务 namespace —— 逐步收紧
# 阶段 1：先 audit + warn，不 enforce（观察哪些 Pod 不兼容）
apiVersion: v1
kind: Namespace
metadata:
  name: health
  labels:
    pod-security.kubernetes.io/enforce: baseline       # 先只防最危险的
    pod-security.kubernetes.io/audit: restricted       # 审计 Restricted 违规（不改行为）
    pod-security.kubernetes.io/warn: restricted        # 用户 apply 时警告

---
# 阶段 2：enforce Restricted
# 给无法兼容的 workload 单独加豁免 namespace
apiVersion: v1
kind: Namespace
metadata:
  name: health
  labels:
    pod-security.kubernetes.io/enforce: restricted
```

三个模式的差异：

| mode | 行为 | kubectl apply 结果 |
|------|------|------|
| **enforce** | 拒绝创建/更新违反策略的 Pod | 报错：`forbidden: violates PodSecurity` |
| **audit** | 允许创建，但在审计日志中记录 | 无影响 |
| **warn** | 允许创建，但向用户显示警告 | 返回 Warning header |

### 豁免：处理无法兼容 Restricted 的 Pod

```yaml
# 方法 1：整个 namespace 豁免
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    pod-security.kubernetes.io/enforce: privileged     # Prometheus node-exporter 需要 hostNetwork

# 方法 2：精确豁免（K8s v1.30+，使用 Pod 级别的 SecurityContext）
apiVersion: v1
kind: Pod
metadata:
  name: node-exporter
  namespace: monitoring
spec:
  hostNetwork: true
  securityContext:
    seccompProfile:
      type: RuntimeDefault
    windowsOptions:
      hostProcess: false
  containers:
    - name: exporter
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: [ALL]
        readOnlyRootFilesystem: true
```

## 第二层：NetworkPolicy

NetworkPolicy 就像为 Pod 配置的防火墙规则。没有 NetworkPolicy = 集群内所有 Pod 可以互相访问。在一个 120+ 微服务的集群里，如果某个 frontend Pod 被入侵，在没有 NetworkPolicy 的情况下，攻击者可以连接到集群内的**任何** Pod。

### 默认拒绝所有（零信任起点）

```yaml
# 1. 先 deny-all（什么都不允许）
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all-ingress
  namespace: health
spec:
  podSelector: {}              # 匹配所有 Pod
  policyTypes:
    - Ingress
    - Egress
  # 空的 ingress/egress = 拒绝全部

---
# 2. 允许 DNS 出站（CoreDNS 的 kube-dns Service）
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: health
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
        - podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53

---
# 3. 逐服务白名单
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-backend
  namespace: health
spec:
  podSelector:
    matchLabels:
      app: health-ack        # 这个策略应用于 health-ack 的 Pod（入站）
  policyTypes:
    - Ingress
  ingress:
    # 允许来自 api-gateway namespace 的 Pod
    - from:
        - namespaceSelector:
            matchLabels:
              name: api-gateway
      ports:
        - protocol: TCP
          port: 8080

    # 允许同 namespace 的 bigdata Pod
    - from:
        - namespaceSelector:
            matchLabels:
              name: bigdata
      ports:
        - protocol: TCP
          port: 8080

    # 允许健康检查（ingress controller 或 kubelet）
    - from:
        - ipBlock:
            cidr: 10.0.0.0/8
      ports:
        - protocol: TCP
          port: 8080

---
# 4. 限制出站（防止被入侵的 Pod 连接外部或横向移动）
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: restrict-egress
  namespace: health
spec:
  podSelector:
    matchLabels:
      app: health-ack
  policyTypes:
    - Egress
  egress:
    # 只允许：
    # - 到同 namespace 的数据库 Service
    - to:
        - podSelector:
            matchLabels:
              app: postgres
      ports:
        - protocol: TCP
          port: 5432
    # - DNS
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
        - podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
    # - 到 Nacos（服务发现）
    - to:
        - namespaceSelector:
            matchLabels:
              name: middleware
        - podSelector:
            matchLabels:
              app: nacos
      ports:
        - protocol: TCP
          port: 8848
    # - 其他所有出站被拒绝
```

### Cilium NetworkPolicy —— 超越 K8s Native

在 Cilium CNI 中，可以用 L7 策略精确控制 HTTP Method 和 DNS 查询：

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: health-ack-l7
spec:
  endpointSelector:
    matchLabels:
      app: health-ack
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: payment-service
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: POST
                path: "/api/checkout"        # 只允许 POST /api/checkout
              - method: GET
                path: "/api/health"

  egress:
    # DNS 只能解析到公司内部域名
    - toFQDNs:
        - matchPattern: "*.internal.example.com"
    - toEndpoints:
        - matchLabels:
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
          rules:
            dns:
              - matchPattern: "*.svc.cluster.local"   # 禁止解析外部域名
```

## 第三层：RBAC —— 最小权限

### 排查当前的高权限 SA

```bash
# 找所有绑定了 cluster-admin 的 SA
kubectl get clusterrolebindings -o json | jq -r '.items[] | select(.roleRef.name=="cluster-admin") | .subjects[] | "\(.kind)/\(.name) in \(.namespace)"' | sort -u

# 每个 namespace 的 default SA 的权限
for ns in $(kubectl get ns -o name | cut -d/ -f2); do
  kubectl auth can-i --list --as=system:serviceaccount:$ns:default -n $ns 2>/dev/null | grep -v "\[\]"
done
# 如果 default SA 有 create/update/delete → 任何 Pod 都可以操作 K8s API
```

### 最小权限 RBAC 模板

```yaml
# 只读 Role（给监控、日志采集用）
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: read-only
  namespace: health
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "services", "endpoints", "configmaps"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list", "watch"]
---
# 给特定 SA 绑定
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: monitoring-read
  namespace: health
subjects:
  - kind: ServiceAccount
    name: grafana-agent
    namespace: monitoring
roleRef:
  kind: Role
  name: read-only
  apiGroup: rbac.authorization.k8s.io
```

### 禁止 Pod 访问 K8s API

```yaml
# 方法 1：不挂载 SA token（Pod spec）
automountServiceAccountToken: false

# 方法 2：阻止 Pod 的网络访问 API Server
# NetworkPolicy egress deny to Kubernetes API Server IP
egress:
  - to:
      - ipBlock:
          cidr: 0.0.0.0/0
          except:
            - <kube-apiserver-ip>/32   # 除了 API Server
```

## 第四层：镜像安全

### Trivy —— 镜像扫描

```bash
# 安装 Trivy
brew install aquasecurity/trivy/trivy

# 扫描本地镜像
trivy image health-ack:v2.3.1

# 扫描远程镜像（CI 中）
trivy image registry.example.com/health-ack:v2.3.1 \
  --severity HIGH,CRITICAL \
  --exit-code 1                     # 有高危漏洞 → CI 流水线失败
```

Trivy Operator 在集群内持续扫描：

```yaml
# Trivy Operator 自动扫描所有 namespace 中运行的镜像
# 结果写入 VulnerabilityReport CRD
kubectl get vulnerabilityreports -n health
# health-ack-7d8f9-abcde   registry.example.com/health-ack:v2.3.1   2 CRITICAL, 5 HIGH
```

### 镜像策略（准入控制）

用 Kyverno 或 OPA 在准入阶段拦截不安全镜像：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-image-registries
spec:
  validationFailureAction: Enforce
  rules:
    - name: validate-registries
      match:
        resources:
          kinds:
            - Pod
      validate:
        message: "Images must come from registry.example.com (not docker.io)"
        pattern:
          spec:
            containers:
              - image: "registry.example.com/*"       # 拒绝所有 docker.io 等外部镜像
    - name: validate-tag
      validate:
        message: "Image tag must not be 'latest'"
        pattern:
          spec:
            containers:
              - image: "!*:latest"
```

## 第五层：Secret 管理

### 永远不要把 Secret 明文放到 Git

**External Secrets Operator（ESO）** 从外部 Secret Store（Vault、AWS Secrets Manager、GCP Secret Manager）同步到 K8s Secret：

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-store
  namespace: health
spec:
  provider:
    vault:
      server: "https://vault.internal.example.com"
      path: "kv/health"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "health-reader"
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: health
spec:
  refreshInterval: 1h                  # 每小时从 Vault 拉新值
  secretStoreRef:
    name: vault-store
    kind: SecretStore
  target:
    name: db-credentials                # 在 K8s 创建的 Secret 名字
  data:
    - secretKey: DB_PASSWORD
      remoteRef:
        key: db/password               # Vault 中的路径
        property: value
```

### 加密 etcd 中的 Secret

默认 K8s Secret 在 etcd 中是 **base64 编码**（不是加密），获得 etcd 访问权限即可读取全部 Secret：

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - aescbc:
          keys:
            - name: key1
              secret: <base64-encoded-32-byte-key>
      - identity: {}            # 兜底：如果 aescbc 失败，允许不加密（保证不丢数据）
```

> 启用 etcd 加密后，已存在的 Secret 不会自动加密。需要 `kubectl get secret --all-namespaces -o json | kubectl replace -f -` 触发重写。

## 第六层：运行时安全（Falco）

当攻击者已经进入容器后，Falco 监控系统调用和内核事件，检测异常行为：

```yaml
# Falco 规则示例
- rule: Unauthorized Process in Container
  desc: 检测在容器中启动 shell
  condition: container and proc.name in (bash, sh, zsh) and not proc.tty != 0
  output: "SHELL spawned in container (user=%user.name container_id=%container.id shell=%proc.name)"
  priority: WARNING

- rule: Non-Allowed Program Execution
  desc: 运行不在预期白名单中的程序
  condition: container and not proc.name in (node, npm, java, python, nginx) and not trusted_image
  output: "Suspicious process %proc.name in container %container.id"
  priority: CRITICAL

- rule: Contact K8s API Server From Container
  desc: 容器中的进程尝试调用 K8s API
  condition: container and fd.sip.name = <kube-apiserver-ip> and k8s.ns.name != "kube-system"
  output: "Container contacted K8s API Server"
  priority: CRITICAL
```

## 生产安全加固清单

| # | 检查项 | 验证命令 | 状态 |
|:---:|------|------|:---:|
| 1 | 全局 PSS enforce ≥ baseline | `kubectl get ns -o jsonpath='{.items[*].metadata.labels}' \| grep baseline` | |
| 2 | 业务 namespace enforce restricted | 同上 | |
| 3 | 每个 namespace 有 at least deny-all NetworkPolicy | `kubectl get networkpolicies -A` | |
| 4 | 无 Pod 使用 `default` SA | `kubectl get pods -A -o json \| jq '[.items[] \| select(.spec.serviceAccountName=="default")]'` | |
| 5 | 无 SA 绑定 cluster-admin | `kubectl get clusterrolebindings -o json \| jq '[.items[] \| select(.roleRef.name=="cluster-admin")]'` | |
| 6 | SA token 非必要不挂载 | 检查 Pod spec 中 `automountServiceAccountToken` | |
| 7 | etcd 加密启用 | `kubectl get --raw /api/v1 \| grep encryption` | |
| 8 | Secret 通过 ESO/Vault 管理 | 检查集群中是否有 ExternalSecret CRD | |
| 9 | Trivy Operator 在所有 namespace 扫描 | `kubectl get vulnerabilityreports -A` | |
| 10 | Falco 或同等运行时检测部署 | `kubectl get pods -n falco` | |
| 11 | 所有业务容器 `readOnlyRootFilesystem: true` | 检查 Pod securityContext | |
| 12 | 所有业务容器 drop ALL capabilities | 同上 | |
| 13 | 镜像来自允许的 registry（禁止 docker.io） | Kyverno AdmissionPolicy `Enforce` | |
| 14 | 镜像 tag 不是 `latest` | 同上 | |
| 15 | 审计日志已启用并持久化 | `kubectl logs -n kube-system kube-apiserver-* \| grep audit-log` | |

## 关联知识

- [[Istio 服务网格详解]] — Istio AuthorizationPolicy + mTLS 是 NetworkPolicy 的 L7 补充
- [[CNI 网络插件对比与排障]] — NetworkPolicy 需要 Calico/Cilium 支持（Flannel 不支持）
- [[etcd 运维详解]] — etcd 加密需要 apiserver EncryptionConfiguration
- [[容器运行时深度对比]] — gVisor/Kata 是 Pod Security 的下一级防线
- [[../linux/cgroup v2 详解]] — seccomp + capability 的底层依赖

## 参考资源

- Pod Security Standards：https://kubernetes.io/docs/concepts/security/pod-security-standards/
- NetworkPolicy 教程：https://kubernetes.io/docs/concepts/services-networking/network-policies/
- Falco 规则：https://falco.org/docs/rules/
- Trivy Operator：https://github.com/aquasecurity/trivy-operator
- External Secrets Operator：https://external-secrets.io/latest/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 安全体系 | 2026-07-06 | 6 层纵深防御、PSS/RBAC/NetworkPolicy/镜像/Secret/运行时 + 15 项检查清单 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-13

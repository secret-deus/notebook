---
date: 2026-06-29
tags:
  - k8s
  - 安全
  - RBAC
  - KMS
  - SA Token
type: 学习笔记
category: 云原生/Kubernetes/安全
difficulty: 进阶
title: "K8s 安全增强 GA 特性合集"
---

# K8s 安全增强 GA 特性合集（v1.28-1.36）

覆盖 K8s 1.28→1.36 期间安全领域达到 GA 的特性。

## 特性总览

| # | 特性 | GA 版本 | 核心价值 |
|---|------|---------|----------|
| 1 | KMS v2 静态加密 | v1.29 | 加密密钥托管外部 KMS，防 etcd 泄露 |
| 2 | 结构化授权配置 | v1.32 | 声明式配置 authorizer 链 |
| 3 | 细粒度 kubelet API 授权 | v1.36 | 替代 `nodes/proxy` 宽泛权限 |
| 4 | 外部 SA Token 签名 API | v1.36 | 令牌签名委托外部系统 |

---

## 1. KMS v2 静态加密（v1.29 GA）

**解决的问题**：v1 无法验证密钥轮换、无状态加密、不支持密钥 ID。

```yaml
# EncryptionConfiguration（v2 格式）
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - kms:
          apiVersion: v2                   # ← v2 协议
          name: aws-kms
          endpoint: unix:///var/run/kmsplugin/socket.sock
          timeout: 3s
          cachesize: 1000
      - identity: {}                      # 兜底明文
```

**v2 新增能力**：
- **密钥 ID 和状态追踪**：etcd 中每个加密对象携带 `kms-key-id` 和加密状态
- **密钥轮换**：`--encryption-provider-config-automatic-reload=true` 分钟级热加载
- **性能**：减少 gRPC 调用（缓存 DEK）

**运维验证**：

```bash
# 检查 Secret 是否加密（查看 annotations）
kubectl get secret my-secret -o jsonpath='{.metadata.annotations}'
# 应有 encryption.kubernetes.io/kms-key-id annotation

# 验证密钥状态
kubectl get --raw /metrics | grep apiserver_envelope_encryption
```

---

## 2. 结构化授权配置（v1.32 GA）

**解决的问题**：authorizer 链通过多个命令行 flag 拼接（`--authorization-mode=Node,RBAC --authorization-webhook-*`），不声明式。

```yaml
# 新方式（v1.32 GA）：AuthorizationConfiguration 文件
apiVersion: apiserver.config.k8s.io/v1
kind: AuthorizationConfiguration
authorizers:
  - type: Node                           # 节点授权
    name: node
  - type: RBAC                           # RBAC 授权
    name: rbac
  - type: Webhook                        # 外部 webhook
    name: custom-policy
    webhook:
      endpoint: https://policy-engine.example.com/authorize
      cacheAuthorizedTTL: 5m
      cacheUnauthorizedTTL: 30s
      connectionInfo:
        type: InClusterConfig
  - type: AlwaysDeny
    name: default-deny
```

**apiserver 启动参数**：

```bash
kube-apiserver \
  --authorization-config=/etc/kubernetes/authorization.yaml \  # 替代旧的 mode flag
```

**优势**：
- 一条 YAML 看清所有 authorizer 和顺序
- 支持每个 webhook authorizer 独立的 TTL、超时
- 声明式、GitOps 友好

---

## 3. 细粒度 kubelet API 授权（v1.36 GA）

**解决的问题**：`nodes/proxy` 权限太宽泛——监控/日志系统为获取 Pod 指标，需要能代理所有节点请求，可执行任意命令。

### 旧方式（不安全）

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring
rules:
  - apiGroups: [""]
    resources: ["nodes/proxy"]      # ← 太宽！
    verbs: ["get"]
```

持有 `nodes/proxy` 的 service account 可以：
- `kubectl get --raw /api/v1/nodes/<node>/proxy/logs/kubelet` → 读任意节点日志
- `kubectl get --raw /api/v1/nodes/<node>/proxy/debug/pprof` → 读 heap profile
- 甚至可以执行节点命令（取决于 kubelet 配置）

### 新方式（v1.36 GA，最小权限）

```yaml
# 分离的细粒度资源
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-reader
rules:
  - apiGroups: [""]
    resources: ["nodes/log"]              # 仅读节点日志，不可执行命令
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["nodes/metrics"]          # 仅读指标
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["nodes/proxy"]           # 完全代理（仅在必要时授予）
    verbs: ["get"]
```

**可用细粒度资源**：

| 资源 | 说明 | 典型使用场景 |
|------|------|-------------|
| `nodes/log` | kubelet 日志 | 日志采集系统 |
| `nodes/metrics` | kubelet 指标 | Prometheus kubelet 抓取 |
| `nodes/stats` | kubelet 统计信息 | 资源监控 |
| `nodes/proxy` | 完整代理权限 | 仅限调试（不推荐） |

---

## 4. 外部 SA Token 签名 API（v1.36 GA）

**解决的问题**：ServiceAccount Token 由 kube-apiserver 的 service account key 签名。多集群或多 issuer 场景需要共享 key 或每个集群独立 key，管理复杂。

```yaml
# 外部签名者配置（apiserver flag）
apiVersion: apiserver.config.k8s.io/v1
kind: ServiceAccountKeyConfiguration
signers:
  - name: external-signer-1
    issuer: https://token-issuer.example.com
    jwksUri: https://token-issuer.example.com/.well-known/jwks.json
    audienceMatchPolicy: Strict
```

**工作流程**：

```
1. Pod 请求 SA Token（TokenRequest API）
2. kube-apiserver → 外部签名服务（如 HashiCorp Vault）→ 签名
3. 返回令牌
4. 验证方从 JWKS URI 获取公钥验证
```

**使用场景**：
- 多集群统一 issuer（同一签发机构跨集群令牌互信）
- 集成企业 PKI（令牌由公司 CA 签发）
- 审计和吊销（集中式令牌生命周期管理）

```bash
# 创建 token-bound ServiceAccount
kubectl create token my-sa --audience=https://api.example.com --duration=1h

# 验证 token 的 issuer
kubectl get --raw /openid/v1/jwks | jq '.'
```

---

## 关联知识

- [[Pod 用户命名空间详解]]（同属安全增强，1.36 GA）
- [[CEL 准入控制详解]]（ValidatingAdmissionPolicy 可用于安全策略）
- [[../versions/K8s 1.29 Mandala 详解]]（KMS v2 GA）
- [[../versions/K8s 1.32 Penelope 详解]]（结构化授权 GA）
- [[../versions/K8s 1.36 Haru 详解]]（kubelet API 授权 / SA Token 签名 GA）
- [[../K8s 1.28-1.36 版本更新总结#主线 4：安全与身份]]

## 参考资源

- KMS v2 KEP-3299：https://kep.k8s.io/3299
- 结构化授权 KEP-3221：https://kep.k8s.io/3221
- 细粒度 kubelet API KEP-2862：https://kep.k8s.io/2862
- 外部 SA Token KEP-740：https://kep.k8s.io/740

---

**状态**: 📖 已掌握

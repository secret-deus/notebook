---
date: 2026-06-29
tags:
  - k8s
  - 准入控制
  - CEL
  - admission
type: 学习笔记
category: 云原生/Kubernetes/API
source: https://kubernetes.io/blog/2026/04/22/kubernetes-v1-36-release/
difficulty: 进阶
title: "CEL 准入控制详解"
---

# CEL 准入控制详解（验证 + 变更）

## 概述

CEL 准入控制是利用 Common Expression Language 在 API 服务器内**原生实现资源验证和变更**的机制，用来替代传统的 admission webhook。分为两个阶段成熟：

| 阶段 | 版本 | 说明 |
|------|------|------|
| CEL 验证准入策略 | **v1.28 Beta → v1.30 GA** | `ValidatingAdmissionPolicy`：拒绝/警告不符合规则的请求 |
| CEL 变更准入策略 | **v1.32 Alpha → v1.36 GA** | `MutatingAdmissionPolicy`：修改资源（如注入标签、设默认值） |
| `validation-gen` 代码生成 | **v1.36 GA** | Go struct tags 中写 CEL 规则，自动生成验证代码 |

> 核心理念：从「外部 webhook 服务（需要维护、高可用、网络延迟）」转向「API 服务器内 CEL 表达式（零额外基础设施、毫秒级延迟）」。

## 为什么需要 CEL 准入控制

### 传统 Webhook 的痛点

```
API 请求 → kube-apiserver → 调 webhook (HTTPS) → webhook 服务 → 返回 allow/deny
                                  ↑
                            网络延迟 + 单点故障 + 需维护
```

| 痛点 | CEL 解决方式 |
|------|-------------|
| 需要额外部署 webhook 服务 | **零额外组件**——CEL 表达式在 apiserver 内执行 |
| 网络延迟（1-50ms） | **无网络跳转**——CPU 指令级别 |
| webhook 不可用时 API 全阻 | **无外部依赖**——不会因 webhook 宕机阻塞 |
| webhook 逻辑黑盒 | **策略即声明**——CEL 表达式写在 YAML 中，GitOps 友好 |
| 多个 webhook 调用链复杂 | **单策略多规则**——AND/OR 组合 |

## 核心概念

### ValidatingAdmissionPolicy（验证，v1.30 GA）

用于**拒绝或警告**不符合规则的资源变更。不会修改请求。

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-labels
spec:
  failurePolicy: Fail            # Fail = 不匹配则拒绝；Ignore = 不匹配仅跳过
  matchConstraints:
    resourceRules:
      - apiGroups:   ["apps"]
        apiVersions: ["v1"]
        operations:  ["CREATE", "UPDATE"]
        resources:   ["deployments"]
  validations:
    - expression: "has(object.metadata.labels) && has(object.metadata.labels.env)"
      message: "Deployment 必须包含 'env' 标签"
    - expression: "object.metadata.labels.env in ['dev', 'staging', 'prod']"
      message: "'env' 标签必须是 dev、staging 或 prod"
    - expression: "object.spec.replicas <= 10"
      messageExpression: "'副本数超过限制(10)，当前: ' + string(object.spec.replicas)"
      reason: Invalid
```

**绑定到具体资源**：

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-labels-binding
spec:
  policyName: require-labels
  validationActions: [Deny]       # Deny / Warn / Audit
  matchResources:
    namespaceSelector:
      matchLabels:
        environment: production
```

### MutatingAdmissionPolicy（变更，v1.36 GA）

用于**在资源持久化前修改**其内容（注入标签、设默认值、修改字段）。

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingAdmissionPolicy
metadata:
  name: inject-sidecar-label
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups:   [""]
        apiVersions: ["v1"]
        operations:  ["CREATE"]
        resources:   ["pods"]
  mutations:
    # 变更 1：注入 app 标签
    - patchType: Apply                       # Apply = JSON Merge Patch
      expression: >
        has(object.metadata.labels) &&
        !has(object.metadata.labels.app)
      applyConfiguration:
        expression: >
          Object.metadata.labels{
            metadata: Object.metadata{
              labels: Object.metadata.labels{
                app: object.metadata.labels['app.kubernetes.io/name']
              }
            }
          }
    # 变更 2：注入环境标签
    - patchType: Apply
      expression: >
        !has(object.metadata.labels.env)
      applyConfiguration:
        expression: >
          Object.metadata.labels{
            metadata: Object.metadata{
              labels: Object.metadata.labels{
                env: "dev"
              }
            }
          }
    # 变更 3：JSON Patch 方式修改
    - patchType: JSONPatch
      expression: "object.spec.containers.all(c, !has(c.securityContext) || !has(c.securityContext.runAsNonRoot))"
      jsonPatches:
        - expression: |
            JSONPatch([
              JSONPatchOperation{
                op: "add",
                path: "/spec/containers/0/securityContext/runAsNonRoot",
                value: true
              }
            ])
```

**绑定到资源**：

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingAdmissionPolicyBinding
metadata:
  name: inject-sidecar-label-binding
spec:
  policyName: inject-sidecar-label
  matchResources:
    namespaceSelector: {}
```

## CEL 表达式常用模式

### 对象访问

| 表达式 | 含义 |
|--------|------|
| `object` | 当前请求中的资源对象 |
| `oldObject` | 更新前的资源对象（UPDATE 操作） |
| `params` | `paramKind` 引用的参数对象 |
| `request` | 当前 admission request（含 userInfo, operation 等） |

### 常用内置函数

```yaml
# 字符串检查
expression: "object.metadata.name.matches('^[a-z0-9-]+$')"

# 列表遍历（all / exists / filter）
expression: "object.spec.containers.all(c, has(c.resources.requests.cpu))"
expression: "object.spec.containers.exists(c, c.image.contains('registry.internal'))"

# 类型检查
expression: "object.spec.replicas <= 10 && int(object.spec.replicas) >= 1"

# 正则
expression: "object.metadata.namespace.matches('^(dev|staging|prod)-[a-z]+$')"

# 数值计算
expression: "object.spec.containers.sum(c, c.resources.requests.cpu) <= 4000"

# 时间检查
expression: "object.metadata.creationTimestamp + duration('30d') > timestamp(now())"

# oldObject 对比（防止回退）
expression: "object.spec.replicas >= oldObject.spec.replicas"
```

## 实战场景

### 场景 1：强制 Deployment 副本数限制

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: limit-deployment-replicas
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups:   ["apps"]
        apiVersions: ["v1"]
        operations:  ["CREATE", "UPDATE"]
        resources:   ["deployments"]
  validations:
    - expression: "object.spec.replicas <= 20"
      message: "Deployment 副本数不能超过 20（联系平台团队申请豁免）"
    - expression: "object.spec.replicas >= 1"
      message: "Deployment 副本数不能为 0（使用 scale-to-zero 策略代替）"
```

### 场景 2：强制资源限制（所有 Pod）

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-resource-limits
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups:   [""]
        apiVersions: ["v1"]
        operations:  ["CREATE", "UPDATE"]
        resources:   ["pods"]
  validations:
    - expression: >
        object.spec.containers.all(c,
          has(c.resources) &&
          has(c.resources.requests) &&
          has(c.resources.requests.cpu) &&
          has(c.resources.requests.memory) &&
          has(c.resources.limits) &&
          has(c.resources.limits.cpu) &&
          has(c.resources.limits.memory)
        )
      message: "每个容器必须设置 CPU/内存的 requests 和 limits"
```

### 场景 3：禁止使用 latest 镜像标签

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: block-latest-image-tag
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups:   ["apps"]
        apiVersions: ["v1"]
        operations:  ["CREATE", "UPDATE"]
        resources:   ["deployments", "statefulsets", "daemonsets"]
  validations:
    - expression: >
        object.spec.template.spec.containers.all(c,
          !c.image.endsWith(':latest') && c.image.contains(':')
        )
      message: "禁止使用 'latest' 标签，必须指定具体版本号"
```

### 场景 4：MutatingAdmissionPolicy 注入默认 Sidecar

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingAdmissionPolicy
metadata:
  name: inject-istio-sidecar
spec:
  failurePolicy: Ignore
  matchConstraints:
    resourceRules:
      - apiGroups:   [""]
        apiVersions: ["v1"]
        operations:  ["CREATE"]
        resources:   ["pods"]
  paramKind:
    apiVersion: rules.example.com/v1
    kind: SidecarInjectionConfig
  mutations:
    - patchType: Apply
      expression: >
        !object.spec.initContainers.exists(c, c.name == 'istio-proxy')
      applyConfiguration:
        expression: >
          Object.spec.initContainers{
            spec: Object.spec{
              initContainers: object.spec.initContainers + [
                Object.initContainers{
                  name: "istio-proxy",
                  image: "istio/proxyv2:1.24",
                  restartPolicy: "Always",
                  resources: Object.resources{...}
                }
              ]
            }
          }
```

## 与 Webhook 对照

| 维度 | ValidatingWebhookConfiguration | ValidatingAdmissionPolicy |
|------|-------------------------------|--------------------------|
| 部署 | 需部署外部 webhook 服务 | 零额外组件，写在 YAML 里 |
| 语言 | 任意（Go/Python/Java） | CEL 表达式 |
| 复杂度 | 可实现任意复杂逻辑 | 适合常见检查（标签、字段验证） |
| 延迟 | 网络 RTT + 业务处理 | ~100μs（内存） |
| 可用性 | webhook 挂了 API 不可用（或 fail-open） | 无外部依赖 |
| 调试 | webhook 日志 + 网络抓包 | CEL 表达式错误信息 |
| 适合场景 | 复杂业务逻辑、外部系统调用 | 规范检查、标签强制、字段验证 |

## 调试 CEL 表达式

```bash
# 用 kubectl 测试 CEL 验证
kubectl create --dry-run=server -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test
spec:
  replicas: 100               # 超过 20 的限制！
  template: ...
EOF
# Error: admission webhook "validating.require-labels" denied:
#   Deployment 副本数不能超过 20（联系平台团队申请豁免）

# 查看策略和绑定
kubectl get validatingadmissionpolicy,validatingadmissionpolicybinding
kubectl describe validatingadmissionpolicy require-labels
```

## 迁移路线（Webhook → CEL）

```
阶段 1：Webhook 和 CEL 策略并存，CEL 用 Warn 模式观察
  └─ policyBinding.validationActions: [Warn]  ← 只告警不拒绝

阶段 2：CEL 策略改为 Deny，Webhook 仍保留
  └─ policyBinding.validationActions: [Deny]  ← 开始拒绝

阶段 3：观察 1-2 周，确认 CEL 策略无漏报，下线 Webhook
  └─ 删除旧的 ValidatingWebhookConfiguration
```

## 注意事项

| 注意 | 说明 |
|------|------|
| **CEL 不能调用外部 API** | 复杂逻辑（如查 CMDB、调 LDAP）仍需 webhook |
| **表达式长度限制** | 单个 expression 最大约 1KB（取决于 apiserver 配置） |
| **paramKind 引用的 CRD 必须存在** | 否则策略虽然创建但实际不生效 |
| **`failurePolicy: Fail` 的风险** | CEL 表达式编译/执行错误会拒绝所有匹配请求 |
| **Mutating + Validating 顺序** | MutatingAdmissionPolicy 先执行，ValidatingAdmissionPolicy 后执行 |

## 关联知识

- [[../versions/K8s 1.36 Haru 详解]]（MutatingAdmissionPolicies GA + validation-gen GA）
- [[../versions/K8s 1.30 Uwubernetes 详解]]（ValidatingAdmissionPolicies GA）
- [[../versions/K8s 1.28 Planternetes 详解]]（ValidatingAdmissionPolicies Beta）
- [[../K8s 1.28-1.36 版本更新总结#主线 7：准入控制 — Webhook → CEL 原生]]

## 参考资源

- CEL Spec：https://github.com/google/cel-spec
- ValidatingAdmissionPolicy 官方文档：https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/
- MutatingAdmissionPolicy：(待官方文档发布；v1.36 GA 后上线)
- CEL Playground（在线测试）：https://playcel.undistro.io/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 初次学习 | 2026-06-29 | 理解 CEL 语法 > 验证策略 > 变更策略 |
| 深入理解 | | 编写 3-5 个常见策略并测试 |
| 实战应用 | | 生产环境从 webhook 迁移到 CEL |

---

**状态**: 📖 已掌握

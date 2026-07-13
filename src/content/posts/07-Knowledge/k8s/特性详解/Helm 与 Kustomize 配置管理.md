---
date: 2026-07-01
tags:
  - k8s
  - helm
  - kustomize
  - 配置管理
  - yaml
type: 学习笔记
category: 云原生/Kubernetes/配置管理
source: https://helm.sh/docs/ / https://kustomize.io/
difficulty: 进阶
title: "Helm 与 Kustomize 配置管理"
---

# Helm 与 Kustomize 配置管理

## 概述

Helm 和 Kustomize 是 K8s 生态中两种主流的配置管理方式，解决同一个问题——**如何管理几十个微服务 × 3 个环境 = 上百套 YAML**——但走了不同的路。

| | Helm | Kustomize |
|------|------|------|
| 哲学 | **模板化**：写一次，填不同 values | **补丁叠加**：base 打底，overlay 覆盖 |
| 入口 | `helm install <release> <chart>` | `kubectl apply -k <dir>` |
| 状态管理 | Release 状态存储（Secret/ConfigMap） | 无状态，无服务器端组件 |
| 生命周期 | Hook 机制（pre-install, post-upgrade） | 无内置 Hook |
| 包分发 | Chart 仓库（HTTP/OCI） | Git 仓库 + `kustomization.yaml` |
| K8s 集成 | 外部工具 | `kubectl apply -k`（内置） |
| K8s v1.14+ | ✅ | ✅ 内置 |

> 一句话：Helm 是"模板 + 变量"，Kustomize 是"base + 补丁"。没有谁更好，场景决定选择。

## Helm

### Chart 结构

```
mychart/
├── Chart.yaml              # 元数据（name, version, apiVersion）
├── values.yaml             # 默认值（用户可覆盖）
├── values.schema.json      # 可选：values 的 JSON Schema 验证
├── charts/                 # 子 chart 依赖（手动管理）
├── crds/                   # CRD 定义（不能模板化）
├── templates/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── _helpers.tpl        # 复用模板片段（命名模板）
│   └── NOTES.txt           # install 后显示给用户的信息
├── .helmignore
└── Chart.lock              # 依赖锁定文件（helm dependency update 生成）
```

### 模板语法速查

Helm 使用 Go template + Sprig 函数库：

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "mychart.fullname" . }}
  labels:
    {{- include "mychart.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Values.appName }}
  template:
    spec:
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          {{- if .Values.resources }}
          resources: {{ toYaml .Values.resources | nindent 12 }}
          {{- end }}
```

| 模板指令 | 含义 |
|------|------|
| `{{ .Values.X }}` | 引用 values.yaml 中的值 |
| `{{ include "tpl" . }}` | 调用 `_helpers.tpl` 中的命名模板 |
| `{{- ... }}` | 吃掉前面的空白 |
| `{{ ... -}}` | 吃掉后面的空白 |
| `{{ if }}...{{ end }}` | 条件块 |
| `{{ range }}...{{ end }}` | 循环 |
| `{{ with }}...{{ end }}` | 改变作用域 |
| `{{ toYaml . \| nindent N }}` | 将对象序列化为 YAML 并缩进 N |
| `{{ default "foo" .Values.X }}` | 默认值 |

### values.yaml 多环境模式

**模式 1：多 values 文件**

```bash
helm install health-ack ./chart \
  -f values.yaml \             # 默认值
  -f values-prod.yaml \        # 生产环境覆盖
  --set image.tag=v2.3.1       # 命令行覆盖（优先级最高）
```

**模式 2：多 Chart（每个环境一个 Umbrella Chart）**

```
umbrella-prod/
├── Chart.yaml
├── values.yaml            # 生产环境 values
└── charts/
    ├── health-ack -> ../../charts/health-ack
    ├── api-tpa   -> ../../charts/api-tpa
    └── bigdata   -> ../../charts/bigdata
```

**模式 3：OCI Chart + values in Git**

```bash
# Chart 推送为 OCI artifact，values 存 Git（ArgoCD 常用）
helm push ./chart oci://registry.example.com/charts/

# 部署时
helm install health-ack oci://registry.example.com/charts/health-ack \
  --version 2.3.1 \
  -f gitops/values-prod.yaml
```

### Helm Hooks —— 生命周期干预

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    "helm.sh/hook": pre-upgrade           # Hook 时机
    "helm.sh/hook-weight": "5"            # 多个 Hook 的执行顺序
    "helm.sh/hook-delete-policy": hook-succeeded  # 成功后删除
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: myapp-migrate:v2.3.1
      restartPolicy: Never
```

| Hook 时机 | 触发点 |
|------|------|
| `pre-install` | 渲染后、资源创建前 |
| `post-install` | 所有资源创建后 |
| `pre-upgrade` | 升级前 |
| `post-upgrade` | 升级后 |
| `pre-rollback` | 回滚前 |
| `post-rollback` | 回滚后 |
| `pre-delete` | 删除前 |
| `test` | `helm test` 时 |

### 常用命令

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm search repo nginx
helm install my-release bitnami/nginx -f values.yaml -n default
helm upgrade my-release bitnami/nginx -f values.yaml
helm rollback my-release 2                         # 回滚到 revision 2
helm history my-release
helm list -A
helm template my-release ./chart -f values.yaml    # 只渲染不部署（dry-run）
helm lint ./chart                                  # 检查 Chart 语法
helm package ./chart                               # 打包为 .tgz
```

## Kustomize

### 核心理念：base + overlay

```
overlays/
├── base/
│   ├── kustomization.yaml      # 声明哪些资源 + 通用修改
│   ├── deployment.yaml
│   └── service.yaml
├── prod/
│   ├── kustomization.yaml      # 引用 base + 生产环境特定修改
│   ├── replica-count.yaml      # 覆盖 replicas
│   └── ingress.yaml            # 生产环境的额外资源
└── staging/
    ├── kustomization.yaml
    └── env-patch.yaml
```

### kustomization.yaml 完整示例

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../base                      # 引用 base

namespace: health-prod              # 统一设置 namespace

namePrefix: prod-                   # 所有资源名前加前缀
nameSuffix: "-v2"

commonLabels:                       # 所有资源加标签
  env: production
  team: health

commonAnnotations:
  reloader.stakater.com/auto: "true"

images:                             # 修改镜像 tag
  - name: health-ack
    newTag: v2.3.1
  - name: sidecar
    newName: registry.example.com/proxy
    newTag: v1.0.0

configMapGenerator:                 # 从文件生成 ConfigMap（自动 hash）
  - name: app-config
    files:
      - config.json
    literals:
      - LOG_LEVEL=info
      - ENV=production

secretGenerator:                    # 从文件生成 Secret（不存 Git 敏感信息）
  - name: app-secrets
    files:
      - db-password.txt
    type: Opaque

patchesStrategicMerge:              # 策略合并补丁
  - replica-count.yaml

patchesJson6902:                    # JSON Patch（精确操作）
  - target:
      group: apps
      version: v1
      kind: Deployment
      name: health-ack
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/resources/limits/cpu
        value: "2"
```

### 补丁（Patch）类型对比

| 补丁类型 | 语法 | 适用场景 |
|------|------|------|
| **strategicMerge** | 写一个部分 YAML，Kustomize 智能合并 | 最常见的场景，如改 replicas、加 env |
| **json6902** | RFC 6902 JSON Patch 数组 | 精确的字段级修改 |
| **patches** | 内联 patch，支持 target selector | 按标签/名称定位多个资源 |

```yaml
# patchesStrategicMerge 示例（replica-count.yaml）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: health-ack          # 靠 name 匹配
spec:
  replicas: 5               # 只覆盖 replicas 这一个字段
```

### Generator 与 Transformer

| 类型 | 作用 | 常见用法 |
|------|------|------|
| **configMapGenerator** | 从文件/literal 生成 ConfigMap | 配置文件 → ConfigMap，hash 自动更新触发滚动 |
| **secretGenerator** | 从文件生成 Secret | `.env` 文件 → Secret |
| **namePrefix/Suffix** | 资源名前缀/后缀 | `prod-health-ack` |
| **commonLabels** | 全局标签 | 所有资源加 `env: prod` |
| **images** | 修改镜像 | `health-ack:v1.0.0` → `health-ack:v2.3.1` |
| **replicas** | 批量改 replicas | 所有 Deployment 统一调整 |
| **namespace** | 统一改 namespace | base 不写 namespace，overlay 指定 |

### ArgoCD + Kustomize

ArgoCD 原生支持 Kustomize：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  source:
    repoURL: https://github.com/org/manifests.git
    path: overlays/prod/health-ack    # 包含 kustomization.yaml
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: health
```

ArgoCD 直接 `kustomize build overlays/prod/health-ack` → apply 结果。**不需要 Docker 镜像、不需要额外仓库，只需要 Git + Kustomize。**

## Helm vs Kustomize 决策

### 什么时候用 Helm

- ✅ 需要**分发给他人使用**的软件（如 MySQL、Redis、Istio）
- ✅ 需要**版本化打包**（Chart 版本号）：`helm install mysql bitnami/mysql --version 9.2.0`
- ✅ 需要**生命周期 Hook**（如数据库迁移）
- ✅ 团队中有复杂但固定的架构（一套 Chart 覆盖所有环境）
- ✅ 需要**测试框架**（`helm test`）

### 什么时候用 Kustomize

- ✅ 你 **拥有所有 YAML**（不需要分发给他人）
- ✅ **base 基本相同，环境间差异小**（replicas、镜像 tag、资源配置）
- ✅ 已在使用 **GitOps（ArgoCD/Flux）**
- ✅ 想用**最简单的 diff**：`git diff` 即可看到改了哪些资源
- ✅ 不想引入额外工具，`kubectl apply -k` 直接可用

### 最佳实践：组合使用

常见模式：**Helm Chart 定义基础设施软件，Kustomize 管理自有应用**。

更高级的模式：Helm + Kustomize post-renderer：

```yaml
# ArgoCD Application 中
spec:
  source:
    helm:
      valueFiles:
        - values-prod.yaml
    kustomize:
      # Helm 渲染后，Kustomize 对结果做二次修改
```

场景：用 Helm 装 Istio，但通过 Kustomize patch 关掉不需要的功能。

## 生产环境常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `helm upgrade` 报 revision not found | Helm Release Secret 被误删除 | `helm rollback` 重建状态，或用 `--force` |
| Helm chart 依赖冲突（旧 Deployment 用老 apiVersion） | `helm upgrade` 不会删多余资源 | 旧资源手动 `kubectl delete` |
| Kustomize `configMapGenerator` 导致频繁滚动 | 每次 `kustomize build` 生成不同 hash | 用 `disableNameSuffixHash: true` 或 `generatorOptions` |
| `secretGenerator` 的密码泄露到 Git | 误提交含有密码的文件 | 使用 `.gitignore`，或 External Secrets Operator |
| Kustomize patch 没有生效 | strategicMerge 的匹配字段写错 | 用 `kustomize build | grep` 验证输出 |

## 关联知识

- [[ArgoCD GitOps 实战]] — ArgoCD 原生支持 Helm 和 Kustomize
- [[../linux/Linux 内核调优总览]] — 内核参数脚本可通过 Helm ConfigMap 分发
- [[CNI 网络插件对比与排障]] — Cilium/Calico 均提供官方 Helm Chart
- [[etcd 运维详解]] — etcd 可用 Helm Chart 部署

## 参考资源

- Helm 文档：https://helm.sh/docs/
- Kustomize 文档：https://kustomize.io/
- Kustomize CLI：https://kubectl.docs.kubernetes.io/references/kustomize/
- Helm + ArgoCD：https://argo-cd.readthedocs.io/en/stable/user-guide/helm/
- ArgoCD + Kustomize：https://argo-cd.readthedocs.io/en/stable/user-guide/kustomize/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 对比与实战 | 2026-07-01 | 完成：Helm 模板+Hooks+部署模式、Kustomize base+overlay+patch、ArgoCD 集成 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-08

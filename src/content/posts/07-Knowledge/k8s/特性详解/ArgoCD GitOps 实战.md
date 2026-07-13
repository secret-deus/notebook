---
date: 2026-07-01
tags:
  - k8s
  - argocd
  - gitops
  - cicd
  - 运维
type: 学习笔记
category: 云原生/Kubernetes/GitOps
source: https://argo-cd.readthedocs.io/
difficulty: 进阶
title: "ArgoCD GitOps 实战"
---

# ArgoCD GitOps 实战

## 概述

ArgoCD 是 CNCF 毕业项目，实现声明式 GitOps —— Git 仓库是唯一的期望状态来源，ArgoCD 持续将集群实际状态与 Git 中的声明对齐。它是 **kagent Agent 落地交付管道的核心组件**（Agent → ArgoCD → K8s）。

> 一句话：Git 里有什么，集群就是什么。不是 `kubectl apply` 驱动的运维，而是 Git commit 驱动的运维。

## GitOps 四原则

| 原则 | ArgoCD 实现 |
|------|------------|
| **声明式描述** | Application CRD 声明"哪个 Git 仓库 + 哪个路径 + 哪个集群" |
| **版本化、不可变** | 每次变更 = git commit，完整审计日志 |
| **自动拉取** | 每 3 分钟（可配）自动检测 Git 变更并同步 |
| **持续调和** | `selfHeal: true` 时，手动改了集群也会被自动回滚 |

## 架构

```
Git Repo (Manifests/Helm/Kustomize)
      ↓ 1. ArgoCD 定期检测变更
[ArgoCD API Server]  ← Web UI / CLI / gRPC
      ↓
[ArgoCD Repo Server] → 2. Clone + 渲染（helm template/kustomize build）
      ↓
[ArgoCD Application Controller] → 3. Diff（期望 vs 实际）
      ↓ 4. Sync
Kubernetes API Server → Target Cluster
```

| 组件 | 职责 |
|------|------|
| **API Server** | REST/gRPC API + Web UI，对外暴露管理界面 |
| **Repo Server** | 从 Git 拉取仓库，执行 Helm/Kustomize/Jsonnet 渲染，生成最终 YAML |
| **Application Controller** | 持续对比期望状态 vs 实际状态，触发 Sync；管理 Application 生命周期 |
| **Redis** | 缓存 Git 仓库内容、Application 状态 |
| **ApplicationSet Controller** | 根据模板 + Generator 自动生成多个 Application |
| **Notifications Controller** | Sync 成功/失败/健康检查事件 → Slack/Webhook/邮件 |

## 核心 CRD

### Application —— 最小可用单元

一个 Application = 一个 Git 仓库 + 一个目标路径 + 一个目标集群。

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: health-ack
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/org/manifests.git
    targetRevision: main          # Git branch / tag / commit SHA
    path: overlays/prod/health-ack
    helm:
      valueFiles:
        - values-prod.yaml
      parameters:                 # 等价于 --set
        - name: image.tag
          value: "v2.3.1"
  destination:
    server: https://10.0.0.1:6443  # K8s API Server
    namespace: health
  syncPolicy:
    automated:
      prune: true                 # 自动删除 Git 中移除的资源
      selfHeal: true              # 集群中被手动改了 → 自动回滚
      allowEmpty: false           # 不允许 Git 目录为空
    syncOptions:
      - CreateNamespace=true      # 自动创建 namespace
      - PruneLast=true            # Sync 时先创建新资源再删旧资源
    retry:
      limit: 5
      backoff:
        duration: 5s
        maxDuration: 3m
```

### AppProject —— 权限与边界

限制 Application 可以访问哪些 Git 仓库和目标集群：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: prod
  namespace: argocd
spec:
  description: Production applications
  sourceRepos:                     # 允许的 Git 仓库白名单
    - 'https://github.com/org/manifests.git'
  destinations:                    # 允许的目标集群 + namespace
    - server: https://10.0.0.1:6443
      namespace: 'health-*'        # 支持通配符
  clusterResourceWhitelist:        # 允许的集群级资源
    - group: '*'
      kind: Namespace
  namespaceResourceWhitelist:      # 允许的 namespaced 资源
    - group: '*'
      kind: '*'
  roles:                           # RBAC 角色（给 CI / 开发者用）
    - name: developer
      policies:
        - p, proj:prod:developer, applications, sync, prod/*, allow
```

### ApplicationSet —— 批量管理

核心是 Generator（生成器），根据模板自动为多个集群/环境生成 Application：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: health-services
  namespace: argocd
spec:
  generators:
    # Git 目录生成器：该仓库下每多一个子目录就多一个 Application
    - git:
        repoURL: https://github.com/org/manifests.git
        revision: main
        directories:
          - path: overlays/prod/*
  template:
    metadata:
      name: '{{path.basename}}'          # 目录名 → Application 名
    spec:
      project: prod
      source:
        repoURL: https://github.com/org/manifests.git
        targetRevision: main
        path: '{{path}}'
      destination:
        server: https://10.0.0.1:6443
        namespace: '{{path.basename}}'
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

**Generator 类型速查**：

| Generator | 用途 | 适用场景 |
|------|------|------|
| **List** | 静态列表 | 少量固定环境 |
| **Git Directories** | Git 仓库子目录 | 按环境/应用分目录的仓库 |
| **Git Files** | 解析 Git 中的 JSON/YAML | 从配置文件中读取环境列表 |
| **Cluster** | 自动发现注册的 K8s 集群 | 多集群 Fleet 管理 |
| **Pull Request** | 为每个 PR 创建临时环境 | **预览环境（Preview Env）** |
| **Matrix** | 两个 Generator 的笛卡尔积 | 集群 × 应用 矩阵 |
| **Merge** | 多个 Generator 合并 | 覆盖部分字段 |

### App of Apps —— 应用树

"App of Apps" 模式：一个父 Application 管理多个子 Application。ArgoCD 自己管理自己。

```yaml
# bootstrap-app.yaml — 父 Application
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: bootstrap
  namespace: argocd
spec:
  source:
    repoURL: https://github.com/org/argocd-apps.git
    path: apps/           # 该目录下每个 YAML 定义一个 Application
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

```
bootstrap (Application)
  ├── apps/health-ack.yaml    → Application: health-ack
  ├── apps/api-tpa.yaml       → Application: api-tpa
  ├── apps/bigdata.yaml       → Application: bigdata
  └── apps/monitoring.yaml    → Application: monitoring
```

## 同步 (Sync) 机制

### syncPolicy 决策矩阵

| 场景 | prune | selfHeal | 结果 |
|------|:---:|:---:|------|
| Git 中删除 Deployment | ✅ | — | 集群中的 Deployment 自动删除 |
| 手动 `kubectl edit deploy` | — | ✅ | ArgoCD 自动回滚到 Git 版本 |
| Git 新增 Service | — | — | ArgoCD 自动创建 Service |
| Git 目录为空 | — | — | `allowEmpty=false` 时阻止 Sync |

### Sync 阶段与 Hook

Sync 分三个阶段，每个阶段可注入 Hook：

```
PreSync  → Sync  → PostSync
   ↓         ↓        ↓
 通知      应用 YAML   通知
 备份      等待健康    冒烟测试
```

```yaml
# PreSync Hook：同步前备份数据库
apiVersion: batch/v1
kind: Job
metadata:
  name: db-backup
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      containers:
        - name: backup
          image: postgres:16
          command: ["pg_dump", "-h", "db.prod", ">", "/backup/dump.sql"]
      restartPolicy: Never

---
# PostSync Hook：冒烟测试
apiVersion: batch/v1
kind: Job
metadata:
  name: smoke-test
  annotations:
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      containers:
        - name: test
          image: curlimages/curl
          command: ["curl", "-f", "http://health-ack:8080/health"]
      restartPolicy: Never
```

## 多集群管理

### Declarative Cluster Config

向 ArgoCD 注册外部集群：

```bash
# 获取目标集群的 kubeconfig context
argocd cluster add <target-context> --name=prod-shanghai
```

或通过 Secret 声明：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cluster-prod-shanghai
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
type: Opaque
stringData:
  name: prod-shanghai
  server: https://10.0.2.1:6443
  config: |
    {
      "bearerToken": "<service-account-token>",
      "tlsClientConfig": {
        "insecure": false,
        "caData": "<base64-ca-cert>"
      }
    }
```

Application 只需指定 `destination.server`，即可部署到对应集群。

### Cluster Generator

自动为所有已注册集群生成 Application：

```yaml
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            env: prod              # 只匹配打了 env=prod 标签的集群
  template:
    spec:
      destination:
        server: '{{server}}'       # 目标集群 API 地址
        namespace: health
```

### 多集群同步策略

| 策略 | 配置 | 行为 |
|------|------|------|
| **并行** | 默认 | 所有集群同时同步 |
| **蓝绿** | 手动分两批 sync | 首批成功后再同步第二批 |
| **金丝雀** | ApplicationSet + `maxUpdate` | 每次同步 N 个集群，逐步推进 |
| **进度式** | `rollingSync` + `maxUpdate` | ApplicationSet 按步骤逐步更新 |

## 通知与告警

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  annotations:
    notifications.argoproj.io/subscribe.on-sync-succeeded.slack: '#argocd'
    notifications.argoproj.io/subscribe.on-sync-failed.slack: '#argocd-alert'
    notifications.argoproj.io/subscribe.on-deployed.slack: '#releases'
    notifications.argoproj.io/subscribe.on-health-degraded.slack: '#oncall'
```

触发器类型：`on-sync-succeeded` / `on-sync-failed` / `on-sync-running` / `on-deployed` / `on-health-degraded`

## 日常运维

### CLI 速查

```bash
# 登录
argocd login argocd.example.com --sso

# 查看所有 Application
argocd app list

# 查看 Application 详情（含 diff）
argocd app get health-ack

# 手动同步
argocd app sync health-ack
argocd app sync health-ack --resource apps:Deployment:health-ack  # 只同步特定资源

# 回滚到上一个版本
argocd app rollback health-ack

# 查看历史
argocd app history health-ack

# 查看 diff（不操作）
argocd app diff health-ack

# 刷新（重新拉 Git）
argocd app get health-ack --refresh
```

### 常见故障处理

| 症状 | 原因 | 处理 |
|------|------|------|
| OutOfSync 但 Git 没问题 | `selfHeal=false` 时手动变更不会被回滚 | 手动 sync 或开启 selfHeal |
| Sync 卡住 | 资源正在等待条件（如 PVC 绑定、Pod 调度） | `argocd app get <app>` 查看卡在哪一步，解决 K8s 层面的问题 |
| 删除 Application 后资源还在 | `prune=false` 时只删 ArgoCD 元数据不删 K8s 资源 | 删除时加 `--cascade`，或开启 prune |
| Helm Chart 渲染失败 | `values.yaml` 语法错误或依赖缺失 | `helm dependency update` 或检查 values 文件 |
| repo 连接失败 | Git 仓库认证过期 | 更新 repo 凭据 Secret |

### 灾难恢复

ArgoCD 默认无状态（所有配置存 K8s），恢复只需重新部署 ArgoCD 并 kubectl apply 备份的 Application 清单：

```bash
# 备份所有 Application（定期执行）
argocd app list -o yaml > argocd-apps-backup-$(date +%Y%m%d).yaml

# 恢复
kubectl apply -f argocd-apps-backup-20260701.yaml
```

## 安全最佳实践

1. **最小权限 AppProject**：限制 sourceRepos、destinations、clusterResourceWhitelist
2. **Secret 管理**：不要 put Secret YAML 到 Git。使用 External Secrets Operator 或 Sealed Secrets，ArgoCD 只引用 Secret 名称
3. **OCI Helm Chart**：使用 `ref: oci://registry.example.com/charts/myapp` 替代 Git 中的 Chart，版本锁定
4. **SSO**：集成 Dex + OIDC（Okta/Keycloak/AD），禁用本地账户
5. **Network Policy**：限制 ArgoCD 组件只与目标集群 API Server 通信

## 关联知识

- [[../gateway-api/Gateway API 概述]] — Gateway API 配合 ArgoCD 做声明式流量管理
- [[CNI 网络插件对比与排障]] — ArgoCD 可管理 CNI 配置的声明式部署
- [[etcd 运维详解]] — ArgoCD 的 Application 状态存储在 etcd 中
- [[kagent 详解]] — kagent Agent 的交付管道 = kagent → ArgoCD → K8s
- [[../linux/Linux 内核调优总览]] — GitOps 管理的节点初始化脚本

## 参考资源

- ArgoCD 官方文档：https://argo-cd.readthedocs.io/
- ApplicationSet 文档：https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/
- ArgoCD 最佳实践：https://argo-cd.readthedocs.io/en/stable/operator-manual/best_practices/
- GitOps 工作组：https://opengitops.dev/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 架构与实战 | 2026-07-01 | 完成：核心 CRD、同步机制、多集群、App of Apps、故障处理 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-08

---
date: 2026-06-29
tags:
  - k8s
  - sidecar
  - pod
  - 容器生命周期
type: 学习笔记
category: 云原生/Kubernetes/工作负载
source: https://kubernetes.io/blog/2025/04/23/kubernetes-v1-33-release/
difficulty: 进阶
title: "Sidecar 容器详解"
---

# Sidecar 容器详解

## 概述

Sidecar 容器是 Kubernetes **v1.28 Alpha → v1.29 Beta（默认开启）→ v1.33 GA** 的特性，解决了一个长久以来的痛点：**init 容器结束后就退出，无法在 Pod 生命周期内持续运行**。通过 init 容器设置 `restartPolicy: Always`，实现真正的「边车」模式——先于应用容器启动、与应用容器同生命周期、晚于应用容器终止。

> 实现原理：KEP-753。本质上是在 init 容器之上增加 `restartPolicy` 字段，改变 kubelet 对该容器的生命周期管理行为。

## 为什么需要 Sidecar 容器

### 痛点：普通 init 容器 vs 普通容器的矛盾

| 容器类型 | 启动顺序 | 生命周期 | 探针 | 资源限制 |
|----------|:---:|----------|:---:|:---:|
| init 容器 | 先于 app 容器，**串行** | App 容器启动后**退出** | ❌ | ❌ |
| 普通容器 | 与 app 容器**并发** | 与 Pod 同生命周期 | ✅ | ✅ |
| **Sidecar 容器** | 先于 app 容器，但可与 init 容器**并行** | 与 Pod 同生命周期 | ✅ startup 探针 | ✅ |

**传统方案的问题**：

```yaml
# 旧方式：service mesh sidecar 用普通容器
spec:
  initContainers:
    - name: istio-init       # 配置 iptables，运行完退出
      image: istio/proxyv2
  containers:
    - name: app
      image: my-app
    - name: istio-proxy      # sidecar 作为普通容器
      image: istio/proxyv2   # 问题：可能与 app 并发启动，app 还没就绪
```

- 普通容器的 sidecar 与 app **并发启动**，app 可能在 sidecar 就绪前发出请求
- 没有原生的「sidecar 先于 app 就绪」保证
- 终止顺序不可控——kubelet 同时发 SIGTERM，sidecar 可能在 app 之前被杀死

## 核心概念

### Sidecar 容器的定义

在 `initContainers` 中将 `restartPolicy` 设为 `Always`：

```yaml
spec:
  initContainers:
    - name: sidecar-proxy
      image: envoyproxy/envoy:v1.30
      restartPolicy: Always              # ← 关键字段，将其标记为 sidecar
      startupProbe:                      # sidecar 可以有 startupProbe
        httpGet:
          path: /ready
          port: 15021
        failureThreshold: 30
      volumeMounts:
        - name: config
          mountPath: /etc/envoy
    - name: init-db                      # 普通 init 容器仍然串行执行
      image: busybox
      command: ["sh", "-c", "until nc -z db 5432; do sleep 1; done"]
      restartPolicy: OnFailure           # 默认值，或 Never
  containers:
    - name: app
      image: my-app:v2
```

### 与普通 init 容器的关键区别

| 行为 | init 容器 (restartPolicy=Never) | Sidecar 容器 (restartPolicy=Always) |
|------|-------------------------------|-------------------------------------|
| Pod 启动阶段 | 必须全部完成，app 容器才启动 | 启动后即进入 running，app 容器可并行启动 |
| startupProbe | ❌ 不支持 | ✅ 支持（v1.29+），决定 app 容器何时启动 |
| 终止顺序 | N/A | SIGTERM → 等 app 容器终止 → 再等 sidecar 终止 |
| Pod phase | 有一个 init 失败 → Pod Pending | Sidecar 失败 → 自动 restart |
| 资源 | 不计入 Pod 资源总和（init 串行） | 计入 Pod 资源总和（与 app 共享生命周期） |

## 生命周期详解

```
Pod 创建
  │
  ├─ 阶段 1：init 容器串行执行
  │     init-db (restartPolicy=OnFailure)  → 完成
  │     init-config (restartPolicy=Never)   → 完成
  │
  ├─ 阶段 2：sidecar 容器启动
  │     sidecar-proxy (restartPolicy=Always)  → 启动，开始 startupProbe
  │     sidecar-oauth (restartPolicy=Always)  → 启动，开始 startupProbe
  │
  ├─ 阶段 3：所有 sidecar 的 startupProbe 通过 → app 容器启动
  │     app 容器与 sidecar 容器并行运行
  │
  ├─ ...正常运行...
  │
  └─ Pod 终止
        kubelet 发 SIGTERM 给所有普通容器（按 terminationGracePeriodSeconds）
        ├─ app 容器先收到 SIGTERM
        ├─ 等 app 容器终止
        ├─ 再给 sidecar 容器发 SIGTERM（等 terminationGracePeriodSeconds）
        └─ 所有容器终止
```

**关键行为**：

1. **启动**：普通 init 容器（串行）→ sidecar 启动 → sidecar startupProbe 通过 → app 容器启动
2. **终止**：app 容器先收到 SIGTERM → 等待 app 终止 → sidecar 容器收到 SIGTERM → 等待 sidecar 终止
3. **重启**：sidecar 容器退出后自动重启（与普通容器行为一致）
4. **升级**：滚动更新时，新 Pod 的 sidecar 先就绪，旧 Pod 卸载时 sidecar 后终止

## 实战示例

### 示例 1：Istio / Envoy Sidecar（service mesh）

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app-with-envoy
  labels:
    app: my-app
spec:
  initContainers:
    # Sidecar: Envoy proxy
    - name: envoy-sidecar
      image: envoyproxy/envoy:v1.30
      restartPolicy: Always
      args:
        - -c
        - /etc/envoy/envoy.yaml
      startupProbe:
        httpGet:
          path: /ready
          port: 15021
        periodSeconds: 2
        failureThreshold: 30        # 最多等 60s
      volumeMounts:
        - name: envoy-config
          mountPath: /etc/envoy
    # 普通 init：等待外部依赖
    - name: wait-for-services
      image: busybox
      restartPolicy: Never
      command:
        - sh
        - -c
        - |
          echo "Waiting for auth service..."
          until wget -qO- http://auth-service:8080/health; do sleep 2; done
          echo "Auth service ready"
  containers:
    - name: app
      image: my-app:v2
      ports:
        - containerPort: 8080
      env:
        - name: ENVOY_ADMIN
          value: "http://localhost:15000"
  volumes:
    - name: envoy-config
      configMap:
        name: envoy-config
```

### 示例 2：日志采集 Sidecar（Fluent Bit）

```yaml
spec:
  initContainers:
    - name: log-agent
      image: fluent/fluent-bit:3.1
      restartPolicy: Always
      startupProbe:
        tcpSocket:
          port: 2020
        failureThreshold: 10
      volumeMounts:
        - name: app-logs
          mountPath: /var/log/app
        - name: fluent-bit-config
          mountPath: /fluent-bit/etc
      env:
        - name: LOG_DESTINATION
          value: "elasticsearch.logging.svc:9200"
  containers:
    - name: app
      image: my-app:v2
      volumeMounts:
        - name: app-logs
          mountPath: /var/log/app
  volumes:
    - name: app-logs
      emptyDir: {}
    - name: fluent-bit-config
      configMap:
        name: fluent-bit-config
```

### 示例 3：OAuth 代理 + 多 Sidecar

```yaml
spec:
  initContainers:
    # Sidecar 1: OAuth2 Proxy
    - name: oauth-proxy
      image: quay.io/oauth2-proxy/oauth2-proxy:v7.6
      restartPolicy: Always
      args:
        - --upstream=http://localhost:8080
        - --http-address=0.0.0.0:4180
        - --provider=oidc
      startupProbe:
        httpGet:
          path: /ready
          port: 4180
        failureThreshold: 15
      ports:
        - containerPort: 4180
    # Sidecar 2: Metrics Exporter
    - name: metrics-exporter
      image: prom/statsd-exporter:v0.26
      restartPolicy: Always
      args:
        - --statsd.listen-udp=:9125
        - --web.listen-address=:9102
      startupProbe:
        httpGet:
          path: /metrics
          port: 9102
        failureThreshold: 10
  containers:
    - name: app
      image: my-app:v2
      ports:
        - containerPort: 8080
```

## 注意事项与限制

| 限制 | 详情 |
|------|------|
| **资源计算** | Sidecar 容器的 request/limit **计入** Pod 总资源，影响调度 |
| **不可变** | Sidecar 容器在 Pod 运行期间不能修改镜像/资源（与普通容器同） |
| **startupProbe 必设** | 强烈建议为 sidecar 设置 startupProbe，否则 app 容器会等 sidecar 无限期 |
| **同时终止** | 同一 Pod 的所有 sidecar **并行**收到 SIGTERM（非串行），终止顺序不保证 |
| **kubectl logs** | Sidecar 日志可通过 `kubectl logs <pod> -c <sidecar-name>` 查看 |
| **Ephemeral Containers** | 不支持给 sidecar 注入临时容器调试 |
| **RestartPolicy 只支持 Always** | 不支持 `OnFailure`（就是普通 init 容器），不支持 `Never` |

## 与 In-place Pod Resize 的交互

从 v1.35 开始，In-place Pod 资源更新 GA，两者配合可实现：

```yaml
# Sidecar 容器可以原地调整资源
spec:
  initContainers:
    - name: envoy-sidecar
      image: envoyproxy/envoy:v1.30
      restartPolicy: Always
      resources:
        requests:
          cpu: "100m"
          memory: "128Mi"
        limits:
          cpu: "200m"
          memory: "256Mi"
  containers:
    - name: app
      image: my-app:v2
      resources:
        requests:
          cpu: "500m"
          memory: "512Mi"
        limits:
          cpu: "1000m"
          memory: "1Gi"
      resizePolicy:
        - resourceName: cpu
          restartPolicy: NotRequired   # 不重启即可改
        - resourceName: memory
          restartPolicy: NotRequired
---
# 后续通过 kubectl patch 原地调整（v1.35+）
# kubectl patch pod app-with-envoy --patch '
# spec:
#   containers:
#   - name: app
#     resources:
#       requests:
#         cpu: "1000m"
# '
```

## 常见问题 / 坑点

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| App 容器一直不启动，Pod 卡在 Init 阶段 | Sidecar 的 startupProbe 一直失败 | 检查 sidecar 日志，确保 startupProbe 端口/路径正确 |
| Sidecar 容器被 OOM Kill | Sidecar 的 memory limit 太小 | 增大 limit 或在 In-place Resize 场景下动态调整 |
| Sidecar 和普通 init 容器混用，顺序混乱 | 所有 `restartPolicy: Never/OnFailure` 串行完成 → sidecar 和 app 并行 | 不需要串行的检查项放 sidecar 的 startupProbe 里 |
| `kubectl exec` 进 sidecar 失败 | Sidecar 可能没有 shell | 使用 `kubectl debug` 或 ephemeral container |
| StatefulSet 中 sidecar 重启导致服务中断 | Sidecar 重启不影响 app 容器（但网络可能短暂中断） | 配合 `terminationGracePeriodSeconds` 和 readiness probe |

## 升级迁移指南（从普通容器 Sidecar → initContainers Sidecar）

### 迁移前（Istio 典型场景）

```yaml
spec:
  containers:
    - name: app
    - name: istio-proxy        # 普通容器 sidecar
```

### 迁移后

```yaml
spec:
  initContainers:
    - name: istio-proxy
      restartPolicy: Always
      startupProbe: {...}
  containers:
    - name: app
```

**迁移步骤**：
1. 确认集群 ≥ v1.33（Sidecar GA）
2. 将 sidecar 从 `containers` 移到 `initContainers`，加 `restartPolicy: Always`
3. 添加 `startupProbe`（确保 app 在 sidecar 就绪后启动）
4. 滚动更新验证

## 关联知识

- [[../versions/K8s 1.33 Octarine 详解]]（Sidecar GA 版本）
- [[../versions/K8s 1.28 Planternetes 详解]]（Sidecar Alpha 版本）
- [[In-place Pod 资源更新详解]]（配合 Sidecar 动态调整资源）
- [[../gateway-api/Gateway API 概述]]

## 参考资源

- KEP-753（Sidecar 容器）：https://kep.k8s.io/753
- 官方文档：https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/
- Istio Sidecar 迁移：https://istio.io/latest/blog/2024/native-sidecar-containers/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 初次学习 | 2026-06-29 | 核心概念 + 生命周期理解 |
| 深入理解 | | 动手迁移一个 Pod 的 sidecar |
| 实战应用 | | 生产环境 Pod sidecar 化 |

---

**状态**: 📖 已掌握

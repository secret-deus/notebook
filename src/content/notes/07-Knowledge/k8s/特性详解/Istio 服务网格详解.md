---
date: 2026-07-06
tags:
  - k8s
  - istio
  - service-mesh
  - mtls
  - gateway-api
type: 学习笔记
category: 云原生/Kubernetes/服务网格
source: https://istio.io/latest/docs/
difficulty: 高级
title: "Istio 服务网格详解"
---

# Istio 服务网格详解

## 概述

Istio 是 CNCF 中仅次于 Kubernetes 的毕业项目，解决了微服务通信的三个根本问题——**流量如何路由**（东西向 + 南北向）、**通信是否安全**（mTLS + 鉴权）、**发生了什么**（可观测性）。它正在从 Sidecar 模式向 Ambient Mesh（无 Sidecar）演进，同时是 Gateway API 最完整的实现者之一。

> 一句话：如果你有 120+ 微服务，每个服务自己管理重试/超时/熔断/mTLS/限流——那就是 120 套不一致的实现。Istio 把这些从应用代码中全部抽离到基础设施层。

## 架构演进：Sidecar → Ambient

### Sidecar 模式（v1.5+）

```
每个 Pod 注入一个 istio-proxy（Envoy）容器：
  Pod
  ├── app-container (health-ack)
  └── istio-proxy (Envoy)
       ├── 拦截所有进出流量（iptables/ebpf）
       ├── 执行路由规则（VirtualService）
       ├── 执行安全策略（AuthorizationPolicy）
       ├── 上报遥测数据
       └── 不与应用代码耦合

控制面：
  istiod (单个二进制，融合 Pilot + Citadel + Galley)
    ├── Pilot：xDS 服务器，向 Envoy 推送配置
    ├── Citadel：证书管理，自动签发和轮换 mTLS 证书
    └── Galley：配置校验和分发
```

Sidecar 的代价：
- 每个 Pod 增加 ~50MB 内存 + ~0.2 CPU 核
- Sidecar 升级 = 全部 Pod 重启
- Sidecar 与应用的启动顺序需要 `holdApplicationUntilProxyStarts`

### Ambient Mesh（v1.18+，2024 年 GA）

Ambient 将 Sidecar 的功能拆分为两个层级：

```
┌─────────────────────────────────────┐
│   Waypoint Proxy (L7)               │  ← 每 Service Account 一个，处理 L7 策略
│   (HTTP/gRPC 路由、鉴权、遥测)        │
├─────────────────────────────────────┤
│   ztunnel (L4)                       │  ← 每节点一个 DaemonSet，处理 mTLS + L4 策略
│   (加密隧道、简单 TCP 路由、身份)      │
└─────────────────────────────────────┘

ztunnel 用 Rust 重写（不是 Envoy），极致轻量：每个连接 ~0.5MB 内存
Waypoint 用 Envoy 但不是 Sidecar，按需部署
```

| 维度 | Sidecar | Ambient |
|------|:---:|:---:|
| Pod 额外资源 | ~50MB / 0.2 CPU | **0**（ztunnel 在节点级共享） |
| L7 策略 | ✅ per-Pod Envoy | ✅ 需要部署 Waypoint |
| mTLS | ✅ per-Pod | ✅ ztunnel 自动处理 |
| Sidecar 升级影响 | 全部 Pod 重启 | **无需重启应用 Pod** |
| 适用 | 所有版本 | Istio 1.18+，K8s 1.24+ |
| 成熟度 | 生产验证 5 年+ | 2024 GA，仍需生产验证积累 |

## 流量管理 —— 核心 CRD

### VirtualService：请求"去哪"

定义流量匹配规则和路由目标：

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: health-ack-vs
  namespace: health
spec:
  hosts:
    - health-ack                          # 这个 VirtualService 应用于访问 health-ack 的请求
  gateways:
    - istio-system/ingress-gateway        # 应用于哪些 Gateway
    - mesh                                # mesh = 集群内所有 Sidecar
  http:
    # 规则 1：精确匹配 /api/health → 路由到 v2 版本
    - match:
        - uri:
            exact: "/api/health"
      route:
        - destination:
            host: health-ack
            subset: v2                   # 指向 DestinationRule 定义的 subset
          weight: 100

    # 规则 2：Header 匹配 → 金丝雀流量
    - match:
        - headers:
            x-canary:
              exact: "true"
      route:
        - destination:
            host: health-ack
            subset: canary
          weight: 100

    # 规则 3：兜底 → 按权重分流到 v1 和 v2
    - route:
        - destination:
            host: health-ack
            subset: v1
          weight: 90
        - destination:
            host: health-ack
            subset: v2
          weight: 10

    # 全局重试策略
    retries:
      attempts: 3
      perTryTimeout: 2s
      retryOn: "connect-failure,refused-stream,5xx"

    # 全局超时
    timeout: 10s

    # 熔断
    fault:
      delay:
        percentage:
          value: 5                        # 5% 的请求注入 3 秒延迟（混沌测试）
        fixedDelay: 3s
```

### DestinationRule：目标"是什么"

定义流量到达后的处理策略——负载均衡、连接池、mTLS、subset（版本分组）：

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: health-ack-dr
  namespace: health
spec:
  host: health-ack
  # 版本分组（按 Pod label 定义 subset）
  subsets:
    - name: v1
      labels:
        version: v1
    - name: v2
      labels:
        version: v2
    - name: canary
      labels:
        version: canary

  # 流量策略
  trafficPolicy:
    loadBalancer:
      simple: LEAST_REQUEST             # 最少请求数（适合长连接和异构服务）
      # 其他选项: ROUND_ROBIN, RANDOM, CONSISTENT_HASH

    connectionPool:
      tcp:
        maxConnections: 100             # 上游最大连接数
        connectTimeout: 3s
      http:
        http1MaxPendingRequests: 1024
        http2MaxRequests: 1024
        maxRequestsPerConnection: 0     # 0=不限制（适合 HTTP/2 多路复用）
        maxRetries: 3

    outlierDetection:                   # 异常检测（被动健康检查）
      consecutive5xxErrors: 5          # 连续 5 个 5xx → 弹出
      interval: 30s                     # 每 30s 检查一次
      baseEjectionTime: 30s             # 弹出 30 秒
      maxEjectionPercent: 50            # 最多弹出 50% 的 endpoint
      minHealthPercent: 50              # 低于 50% healthy → 负载均衡退化为 panic mode

    tls:
      mode: ISTIO_MUTUAL                # Istio 自动管理的 mTLS
      # 选项: DISABLE, SIMPLE, MUTUAL, ISTIO_MUTUAL
```

### Gateway：集群入口

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: ingress-gateway
  namespace: istio-system
spec:
  selector:
    istio: ingressgateway               # 选择运行 Gateway 的 Pod（ingress-gateway Deployment）
  servers:
    - port:
        number: 443
        name: https
        protocol: HTTPS
      tls:
        mode: SIMPLE
        credentialName: health-wildcard-cert   # 从 K8s Secret 读取证书
      hosts:
        - "*.health.example.com"
    - port:
        number: 80
        name: http
        protocol: HTTP
      hosts:
        - "*"                           # 所有 HTTP 域名
```

### Gateway API 实现 —— 替代 Istio Gateway

Istio v1.22+ 原生支持 Gateway API。上面那个 Gateway CRD 可以用 Gateway API 等价表达：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: istio-gw
  namespace: istio-system
spec:
  gatewayClassName: istio                # 使用 Istio 作为 GatewayClass 实现
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: health-wildcard-cert
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              shared-gateway: "true"
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: All
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: health-ack-route
  namespace: health
spec:
  parentRefs:
    - name: istio-gw
      namespace: istio-system
  hostnames:
    - "api.health.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/health
      backendRefs:
        - name: health-ack-v2
          port: 8080
          weight: 90
        - name: health-ack-v1
          port: 8080
          weight: 10
```

> Gateway API 方式比 Istio CRD 方式更**供应商中立**——这套 HTTPRoute 可以不加修改地部署到任何支持 Gateway API 的实现（Cilium、Envoy Gateway、NGINX Gateway Fabric）。

### EnvoyFilter —— 终极定制

当 VirtualService + DestinationRule 不够用时，EnvoyFilter 可以**直接修改 Envoy 的 xDS 配置**：

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: custom-lua-filter
  namespace: health
spec:
  workloadSelector:
    labels:
      app: health-ack
  configPatches:
    - applyTo: HTTP_FILTER
      match:
        context: SIDECAR_INBOUND
        listener:
          filterChain:
            filter:
              name: "envoy.filters.network.http_connection_manager"
      patch:
        operation: INSERT_BEFORE
        value:
          name: envoy.filters.http.lua
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua
            inlineCode: |
              function envoy_on_request(request_handle)
                local headers = request_handle:headers()
                headers:add("x-custom-header", "injected-by-envoy")
              end
```

> EnvoyFilter 是双刃剑：强大但容易写错。错误配置会直接让 Envoy 拒绝所有 xDS 更新，**整个服务网络不可用**。

## 安全

### mTLS 自动管理

Istio 的安全模型是零信任：**默认所有服务间通信必须 mTLS**，除非显式声明为 `DISABLE`。

```
证书自动轮换过程:
  1. Citadel → 生成 CA 证书 (istio-ca-root-cert)
  2. Sidecar 启动 → 向 Citadel 请求证书 (CSR)
     → Citadel 签发短期证书 (默认 24h)
     → Sidecar 证书自动在到期前轮换
  3. 服务 A → 服务 B：
     Sidecar-A (持有服务 A 的证书) ←mTLS handshake→ Sidecar-B (持有服务 B 的证书)
     
验证：openssl s_client -connect health-ack.health.svc:8080
```

mTLS 的三种模式及其风险：

```yaml
# 模式 1：PERMISSIVE —— 同时接受 mTLS 和 plaintext（迁移阶段）
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system
spec:
  mtls:
    mode: PERMISSIVE       # 过渡期（接受明文 + mTLS）
---
# 模式 2：STRICT —— 全局强制 mTLS（最终状态）
spec:
  mtls:
    mode: STRICT           # 拒绝所有非 mTLS 连接

---
# 模式 3：portLevel —— 端口级精细控制
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: health-ack-mtls
  namespace: health
spec:
  selector:
    matchLabels:
      app: health-ack
  portLevelMtls:
    8080:
      mode: STRICT         # 业务端口必须 mTLS
    9090:
      mode: PERMISSIVE     # metrics 端口放行 Prometheus scrape
```

### AuthorizationPolicy —— 谁可以调什么

```yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: health-ack-policy
  namespace: health
spec:
  selector:
    matchLabels:
      app: health-ack                     # 这个策略应用于 health-ack 的 sidecar (入站)
  action: ALLOW                           # DENY 也可以
  rules:
    # 规则 1：api-gateway 可以调 POST /api/checkout
    - from:
        - source:
            principals: ["cluster.local/ns/api-gateway/sa/api-gateway"]
      to:
        - operation:
            methods: ["POST"]
            paths: ["/api/checkout"]
      when:
        - key: request.headers[x-api-key]
          values: ["*"]                   # 必须有 API Key header

    # 规则 2：bigdata namespace 的所有服务只能调 GET /api/health（只读）
    - from:
        - source:
            namespaces: ["bigdata"]
      to:
        - operation:
            methods: ["GET"]
            paths: ["/api/health"]

    # 规则 3：deny 规则（优先级高于 allow，在 allow 之前评估）
---
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: denylist
  namespace: health
spec:
  selector:
    matchLabels:
      app: health-ack
  action: DENY
  rules:
    - from:
        - source:
            ipBlocks: ["10.244.0.0/16", "10.245.0.0/16"]
      to:
        - operation:
            methods: ["DELETE"]           # 禁止 /16 网段的 DELETE 操作
```

### RequestAuthentication —— JWT 鉴权

```yaml
apiVersion: security.istio.io/v1beta1
kind: RequestAuthentication
metadata:
  name: jwt-auth
  namespace: health
spec:
  selector:
    matchLabels:
      app: health-ack
  jwtRules:
    - issuer: "https://auth.example.com"
      jwksUri: "https://auth.example.com/.well-known/jwks.json"
      audiences:
        - "health-api"
      forwardOriginalToken: true          # 把原始 JWT 转发给后端（后端做进一步校验）
      outputPayloadToHeader: "x-jwt-payload"
```

### 安全全景总结

```
请求 → Gateway
        ├── TLS termination（Gateway 做 HTTPS）
        └── JWT validation（RequestAuthentication）
              ↓
         Sidecar (istio-proxy)
              ├── mTLS handshake（PeerAuthentication STRICT）
              ├── AuthorizationPolicy allow/deny
              └── → upstream（携带原始 JWT）
```

## 可观测性

### Jaeger —— 分布式追踪

Istio 自动向所有经过 Sidecar 的 HTTP/gRPC 请求注入 trace headers（`x-request-id`、`x-b3-traceid`、`traceparent`）：

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: mesh-default
  namespace: istio-system
spec:
  tracing:
    - providers:
        - name: otel                    # 也可以用它自己的 jaeger
      randomSamplingPercentage: 1.0    # 生产建议 1-5%
```

Istio → Jaeger 的完整调用链可见：`Ingress Gateway → Service A → Service B → Service C`，每个跳转包括注入的延迟、重试次数、上游连接失败次数。

### Kiali —— 服务拓扑可视化

```bash
istioctl dashboard kiali
# 图形化展示：
# - 服务依赖拓扑（实时流量叠加）
# - 每对服务间的请求速率、错误率、延迟
# - mTLS 状态（哪些服务对已启用 mTLS，哪些还是明文）
# - Istio CRD 配置校验（VirtualService/DestinationRule 错误高亮）
```

### Prometheus + Grafana

Istio 自动暴露 Envoy 指标，生成的标准 Grafana Dashboard：

| Dashboard | 核心指标 |
|------|------|
| **Istio Mesh Dashboard** | 全局流量、错误率、延迟 |
| **Istio Service Dashboard** | 单个服务的 QPS、p50/p90/p99、上游连接池状态 |
| **Istio Workload Dashboard** | 单个 workload 的 CPU/Memory/Network |
| **Istio Performance Dashboard** | Sidecar 资源消耗、xDS 推送延迟 |
| **Istio Control Plane Dashboard** | istiod 的资源、Pilot 推送延迟、证书轮换 |

## 从 Ingress NGINX 迁移到 Istio

你现在的场景：管理 api-health、api-tpa 等 Ingress 资源，使用 Ingress NGINX Controller。

### 迁移路径

```
Phase 1: 共存（不中断现有 Ingress）
  → 部署 Istio + Gateway
  → 切 DNS 到新的 Istio Gateway LoadBalancer（5-10% 流量测试）
  → VirtualService 中配置金丝雀路由

Phase 2: 灰度
  → Ingress NGINX 和 Istio Gateway 同时存在
  → 逐步将 api-health → api-tpa → other 逐个服务切到 Istio 路由
  → 验证 mTLS、AuthorizationPolicy、可观测性

Phase 3: 下线
  → 所有服务流量切到 Istio
  → 删除 Ingress NGINX 相关资源
  → 启用 STRICT mTLS
```

### Ingress 到 VirtualService 的转换对照

```
# Ingress NGINX 配置：
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-health-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  tls:
    - hosts: [api.health.example.com]
      secretName: health-tls
  rules:
    - host: api.health.example.com
      http:
        paths:
          - path: /api/health
            pathType: Prefix
            backend:
              service:
                name: health-ack
                port:
                  number: 8080

# 等价的 Istio 配置：
---
# 1. Gateway（替代 Ingress 的 TLS + host 规则）
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: api-gateway
spec:
  selector:
    istio: ingressgateway
  servers:
    - port:
        number: 443
        name: https
        protocol: HTTPS
      tls:
        mode: SIMPLE
        credentialName: health-tls      # 复用同一个 Secret
      hosts:
        - "api.health.example.com"
---
# 2. VirtualService（替代 Ingress 的 path 规则 + rewrite + backend）
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: health-ack-vs
spec:
  hosts:
    - "api.health.example.com"
  gateways:
    - istio-system/api-gateway
  http:
    - match:
        - uri:
            prefix: "/api/health"
      rewrite:
        uri: "/"                          # 替代 rewrite-target
      route:
        - destination:
            host: health-ack.health.svc.cluster.local
            port:
              number: 8080
```

nginx annotation 到 Istio 的映射：

| NGINX annotation | Istio 等效配置 |
|------|------|
| `rewrite-target: /` | `VirtualService.http.rewrite.uri` |
| `ssl-redirect: "true"` | Gateway `httpsRedirect: true` |
| `proxy-body-size: 8m` | `EnvoyFilter` 修改 `max_request_bytes` |
| `proxy-read-timeout: 60s` | `VirtualService.http.timeout: 60s` |
| `cors-*` | `VirtualService.http.corsPolicy` |
| `rate-limit-*` | `EnvoyFilter` + `RateLimitService` 或 `local_rate_limit` |
| `whitelist-source-range` | `AuthorizationPolicy.ingress.ipBlocks` |

### 迁移中容易踩的坑

| 坑 | 原因 | 解决 |
|------|------|------|
| 切流量后发现 Service 返回 503 | 未注入 Sidecar 或 PERMISSIVE mTLS 未启用 | 先启用 PERMISSIVE，验证 Sidecar 注入后再切 STRICT |
| Ingress 原有的 annotation 行为消失 | Istio 不支持 NGINX 特定 annotation | 找到 Istio 等效配置，无法映射的用 EnvoyFilter |
| `ssl-redirect` 失效 | Gateway 必须显式配 HTTPS Listener + 端口 | Gateway 中同时配 80 和 443 Listener |
| 健康检查 probe 走 Istio mesh（应该绕开） | `rewriteAppHTTPProbe: true` 未启用 | IstioOperator 中 `sidecarInjectorWebhook.rewriteAppHTTPProbers: true` |
| Ingress NGINX 和 Istio Gateway 同时运行时路由冲突 | 两者用不同的 LoadBalancer IP，DNS 只能指向一个 | 分阶段切流，用 Istio 的 Header match 做金丝雀 |

## 生产排障

### istioctl 关键命令

```bash
# 检查 Sidecar 注入情况
istioctl proxy-status                          # 所有 Envoy 的 sync 状态
# SYNCED = 配置已同步，STALE = 配置过期

# 查看 xDS 配置（Sidecar 收到了什么配置）
istioctl proxy-config cluster <pod-name>       # Envoy 已知的 upstream cluster
istioctl proxy-config listener <pod-name>      # Envoy 监听的端口和 filter chain
istioctl proxy-config route <pod-name>         # Envoy 的路由表
istioctl proxy-config endpoints <pod-name>     # Envoy 的 endpoint 列表（就是 DNS 解析结果）

# dry-run 验证 VirtualService/DestinationRule
istioctl analyze -n health                      # 检查配置错误

# 模拟请求（验证路由规则是否生效）
istioctl proxy-config cluster <pod> --fqdn health-ack.health.svc.cluster.local -o json | jq '.[].edsClusterConfig.edsConfig.ads.backend'
```

### Common Issues

| 症状 | 定位 | 修复 |
|------|------|------|
| Service 间调用返回 503 | `istioctl proxy-status` 显示 STALE | 检查 istiod 是否正常、Envoy 是否 crash |
| mTLS 模式下明文请求被拒 | 发送端未注入 Sidecar | 注入 Sidecar 或将 mTLS 降到 PERMISSIVE |
| Gateway HTTP → HTTPS 重定向循环 | Health check probe 被重定向 | 设 `rewriteAppHTTPProbers: true` |
| Envoy OOM | `sidecar.istio.io/proxyMemory` 限制太小 | 增大至 256Mi + 检查是否有大路由表 |
| `istioctl analyze` 报 VirtualService 冲突 | 两个 VS 有重叠的 match 规则 | 合并或加 header match 区分 |
| Envoy 配置推送慢（> 5s） | 集群规模大，xDS 增量推送有瓶颈 | 切换到 delta xDS（v1.12+），减少 VirtualService 数量 |
| Gateway 证书过期 | 手动创建的 Secret 未自动更新 | 用 cert-manager 管理，或使用 Gateway API 自动 rotating |

## 关联知识

- [[../gateway-api/Gateway API 概述]] — Gateway API 在 Istio 中的原生实现
- [[../gateway-api/HTTPRoute 核心能力详解]] — HTTPRoute 替代 VirtualService 的详细对照
- [[CNI 网络插件对比与排障]] — Cilium 与 Istio 的 Sidecar-Less 互补
- [[OpenTelemetry 可观测性实践]] — OTel Collector 对接 Istio traces
- [[etcd 运维详解]] — Istio 配置存储在 etcd 中（通过 K8s CRD）
- [[kagent 详解]] — kagent 依赖 Istio Ambient 做 Agent mTLS

## 参考资源

- Istio 文档：https://istio.io/latest/docs/
- Istio + Gateway API：https://istio.io/latest/docs/tasks/traffic-management/ingress/gateway-api/
- Ambient Mesh：https://istio.io/latest/docs/ambient/
- EnvoyFilter 文档：https://istio.io/latest/docs/reference/config/networking/envoy-filter/
- Istio 安全：https://istio.io/latest/docs/concepts/security/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 架构与实战 | 2026-07-06 | Sidecar/Ambient、流量管理 CRD、安全模型、可观测性、Ingress 迁移路径、排障 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-13

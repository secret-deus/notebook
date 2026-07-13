---
date: 2026-06-29
tags:
  - k8s
  - gateway-api
  - httproute
  - 参考手册
type: 参考手册
category: 云原生/Kubernetes/网络
source: https://gateway-api.sigs.k8s.io/reference/spec/#gateway.networking.k8s.io/v1.HTTPRoute
difficulty: 进阶
title: "HTTPRoute 核心能力详解"
---

# HTTPRoute 核心能力详解

HTTPRoute 是 Gateway API 最核心的 Route 类型，拆分为**匹配（Matches）→ 过滤（Filters）→ 后端（BackendRefs）**三段处理管线。以下是 14 种能力的字段路径、选项和 YAML 示例。

> 速览：下表是所有能力的索引。

| # | 能力 | 所属阶段 | 核心字段路径 | 阶段 |
|---|------|----------|-------------|------|
| 1 | 路径匹配 | Matches | `matches[].path` | Standard |
| 2 | Header 匹配 | Matches | `matches[].headers` | Standard |
| 3 | Query 参数匹配 | Matches | `matches[].queryParams` | Standard |
| 4 | HTTP Method 匹配 | Matches | `matches[].method` | Standard |
| 5 | 流量权重拆分 | BackendRefs | `backendRefs[].weight` | Standard |
| 6 | 请求头修改 | Filters | `filters[].requestHeaderModifier` | Standard |
| 7 | 响应头修改 | Filters | `filters[].responseHeaderModifier` | Standard |
| 8 | URL 重写 | Filters | `filters[].urlRewrite` | Standard |
| 9 | HTTP 重定向 | Filters | `filters[].requestRedirect` | Standard |
| 10 | 流量镜像 | Filters | `filters[].requestMirror` | Standard |
| 11 | 后端 TLS | 独立 CRD | `BackendTLSPolicy` | Experimental |
| 12 | 超时与重试 | 实现特定 | 实现特定 Policy CRD | — |
| 13 | 会话保持 | 实现特定 | 实现特定 Policy CRD | — |
| 14 | CORS | 实现特定 | 实现特定 Policy CRD | — |

> 使用 Obsidian 大纲面板（Ctrl/Cmd + 鼠标悬停左侧）可直接导航到各小节。

## 处理管线总览

```
请求进入 → Matches（条件匹配，取第一条命中的 rule）
               ↓
          Filters（顺序执行，每个 filter 修改请求/响应）
               ↓
          BackendRefs（按 weight 加权分发到后端 Service）
```

- 一条 HTTPRoute 含多个 `rules`，按**从上到下**顺序匹配第一条命中的 rule。
- 每条 rule 含多个 `matches`，match 之间是 **AND** 关系，rule 之间是 **OR** 关系。
- `filters` 在每个 rule 内**顺序执行**，可组合多个 filter。

---

## 1. 路径匹配

**字段路径**：`spec.rules[].matches[].path`

| 参数 | 类型 | 说明 |
|------|------|------|
| `type` | string | `PathPrefix` / `Exact` / `RegularExpression` |
| `value` | string | 匹配值。不支持 query string，仅 URL 路径部分 |

**三种类型对比**：

| type | 行为 | 示例 value | 匹配 | 不匹配 |
|------|------|-----------|------|--------|
| `PathPrefix` | 前缀匹配 | `/foo` | `/foo`, `/foo/`, `/foo/bar` | `/foobar`, `/` |
| `Exact` | 精确匹配 | `/foo` | `/foo`, `/foo/` | `/foo/bar` |
| `RegularExpression` | RE2 正则 | `^/api/v[12]` | `/api/v1`, `/api/v2` | `/api/v3` |

```yaml
spec:
  rules:
    # 规则 A：精确匹配 /healthz
    - matches:
        - path:
            type: Exact
            value: /healthz
      backendRefs:
        - name: health-check
          port: 80
    # 规则 B：前缀匹配 /api
    - matches:
        - path:
            type: PathPrefix
            value: /api
      backendRefs:
        - name: api-service
          port: 80
```

**注意**：`PathPrefix` 匹配 `/foo` 时会匹配 `/foo/bar` 但**不匹配** `/foobar`，每个路径段独立匹配。

---

## 2. Header 匹配

**字段路径**：`spec.rules[].matches[].headers[]`

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | string | HTTP header 名称（大小写不敏感） |
| `value` | string | 精确匹配的值 |

**多个 header 是 AND 关系**（所有条件同时满足才命中）。

```yaml
spec:
  rules:
    # 单 header 匹配：金丝雀流量
    - matches:
        - headers:
            - name: x-canary
              value: "v2"
      backendRefs:
        - name: app-v2
          port: 80
    # 多 header AND 匹配：特定版本 + 特定区域
    - matches:
        - headers:
            - name: x-version
              value: "v3"
            - name: x-region
              value: "cn-east"
      backendRefs:
        - name: app-v3-cn
          port: 80
```

**注意**：Gateway API v1.3 已支持 Header 的 `type: RegularExpression` 正则匹配（需显式设置 `type`，默认 `Exact`）。正则匹配语法为 RE2。

---

## 3. Query 参数匹配

**字段路径**：`spec.rules[].matches[].queryParams[]`

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | string | query 参数名（大小写敏感） |
| `value` | string | 精确匹配的值 |

**多个 query 参数是 AND 关系**。

```yaml
spec:
  rules:
    # A/B 测试：?version=beta 的流量走新版
    - matches:
        - queryParams:
            - name: version
              value: beta
      backendRefs:
        - name: app-beta
          port: 80
    # 多参数组合：?env=staging&feature=new_ui
    - matches:
        - queryParams:
            - name: env
              value: staging
            - name: feature
              value: new_ui
      backendRefs:
        - name: app-staging
          port: 80
```

---

## 4. HTTP Method 匹配

**字段路径**：`spec.rules[].matches[].method`

| 枚举值 |
|--------|
| `GET` / `HEAD` / `POST` / `PUT` / `DELETE` / `CONNECT` / `OPTIONS` / `TRACE` / `PATCH` |

```yaml
spec:
  rules:
    # 只接收 POST 请求
    - matches:
        - method: POST
      backendRefs:
        - name: order-service
          port: 80
    # GET 和 HEAD
    - matches:
        - method: GET
        - method: HEAD
      backendRefs:
        - name: web-service
          port: 80
```

**注意**：同一 `match` 内不能同时指定多个 method，需拆成多个 match（OR 关系）。

---

## 5. 流量权重拆分

**字段路径**：`spec.rules[].backendRefs[].weight`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `weight` | int32 | 1 | 流量权重。范围为 0（零流量，仅用于蓝绿切换）～ … |

**权重计算**：所有 `backendRef.weight` 之和为分母。例如 weight=90 + weight=10 → 90% : 10%。

```yaml
spec:
  rules:
    - backendRefs:
        - name: app-v1
          port: 80
          weight: 90    # 90% 流量走 v1
        - name: app-v2
          port: 80
          weight: 10    # 10% 流量走 v2（金丝雀）
```

**金丝雀发布典型模式**：新建第二条 rule，仅用 header 匹配，权重设为 100。

```yaml
spec:
  rules:
    # 规则 1：普通用户 → 90% v1 + 10% v2
    - backendRefs:
        - name: app-v1
          port: 80
          weight: 90
        - name: app-v2
          port: 80
          weight: 10
    # 规则 2：测试用户 → 100% v2
    - matches:
        - headers:
            - name: x-test
              value: "enabled"
      backendRefs:
        - name: app-v2
          port: 80
          weight: 100    # 测试用户全部走 v2（含 header，第一条不命中）
```

**weight 为 0**：该 backend 不接收流量，但仍保持引用有效（可用于蓝绿部署中待命的后端）。

---

## 6. 请求头修改

**字段路径**：`spec.rules[].filters[]` → `type: RequestHeaderModifier`

| 操作 | 字段 | 说明 |
|------|------|------|
| `set` | `requestHeaderModifier.set[]` | **覆盖**已有值，无则添加 |
| `add` | `requestHeaderModifier.add[]` | **追加**新值，不会覆盖已有 |
| `remove` | `requestHeaderModifier.remove[]` | 删除指定 header |

```yaml
spec:
  rules:
    - filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            set:
              - name: x-forwarded-proto
                value: "https"           # 覆盖为 https
              - name: x-request-id
                value: ""               # 置空 header
            add:
              - name: x-from-gateway
                value: "true"           # 追加标记
            remove:
              - x-internal-token        # 删除敏感 header
      backendRefs:
        - name: api-service
          port: 80
```

**执行顺序**：同一个 RequestHeaderModifier 内部按 `set → add → remove` 顺序执行。

**多次修改同一 header**：如果需要先删再加（例如重命名 header），需分两个 filter，一个 remove，一个 add。

---

## 7. 响应头修改

**字段路径**：`spec.rules[].filters[]` → `type: ResponseHeaderModifier`

操作与请求头修改相同（`set` / `add` / `remove`），但作用在**后端返回的响应**上。

```yaml
spec:
  rules:
    - filters:
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            set:
              - name: x-content-type-options
                value: "nosniff"
              - name: strict-transport-security
                value: "max-age=31536000; includeSubDomains"
            remove:
              - server          # 隐藏服务器信息
              - x-powered-by
      backendRefs:
        - name: web-service
          port: 80
```

**组合使用**：请求头修改和响应头修改可以放在同一个 rule 的 filters 数组中。

```yaml
filters:
  - type: RequestHeaderModifier
    requestHeaderModifier:
      add:
        - name: x-request-start
          value: "true"
  - type: ResponseHeaderModifier
    responseHeaderModifier:
      add:
        - name: x-response-time
          value: "42ms"
```

---

## 8. URL 重写

**字段路径**：`spec.rules[].filters[]` → `type: URLRewrite`

| 参数 | 子字段 | 说明 |
|------|--------|------|
| `path.type` | `ReplacePrefixMatch` | 替换匹配到的路径前缀（最常用） |
| `path.type` | `ReplaceFullPath` | 替换整个路径 |
| `path.replacePrefixMatch` | string | 新的前缀值 |
| `path.replaceFullPath` | string | 新的完整路径 |
| `hostname` | string | 重写 Host 头 |

```yaml
spec:
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /v2          # /api/v1/users → /v2/users
            hostname: internal.example.com     # 同时重写 Host
      backendRefs:
        - name: api-v2
          port: 80
```

**ReplacePrefixMatch vs ReplaceFullPath**：

| 场景 | 输入 | 输出 |
|------|------|------|
| `ReplacePrefixMatch: /v2`，匹配 `/api/v1` | `/api/v1/users/123` | `/v2/users/123` |
| `ReplaceFullPath: /health` | `/any/path` | `/health` |

**注意**：URL 重写只影响发送到后端的请求，不改变浏览器地址栏（与 HTTP 重定向不同）。

---

## 9. HTTP 重定向

**字段路径**：`spec.rules[].filters[]` → `type: RequestRedirect`

| 参数 | 说明 |
|------|------|
| `scheme` | `http` 或 `https` |
| `hostname` | 重定向到的域名 |
| `port` | 重定向到的端口 |
| `path.type` | `ReplaceFullPath` / `ReplacePrefixMatch` |
| `statusCode` | `301`（永久）或 `302`（临时）。默认 302 |

```yaml
spec:
  rules:
    # 强制 HTTPS
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
      # 注意：有 redirect filter 的 rule 不能有 backendRefs！
    # 域名迁移
    - matches:
        - path:
            type: PathPrefix
            value: /old-site
      filters:
        - type: RequestRedirect
          requestRedirect:
            hostname: new.example.com
            statusCode: 301
```

**关键限制**：配置了 `RequestRedirect` 的 rule **不能同时配置 `backendRefs`**（重定向不到达后端）。

---

## 10. 流量镜像

**字段路径**：`spec.rules[].filters[]` → `type: RequestMirror`

```yaml
spec:
  rules:
    - filters:
        - type: RequestMirror
          requestMirror:
            backendRef:
              name: traffic-analyzer    # 镜像目标（不会被前端感知）
              port: 80
      backendRefs:
        - name: production-service     # 主流量（正常返回给前端）
          port: 80
```

**行为**：请求先复制一份发给镜像后端（异步，fire-and-forget），再正常发给主后端。前端只收到主后端的响应。适用于流量录制、回归测试。

**来自镜像后端的响应会被丢弃**。

---

## 11. 后端 TLS

Gateway API v1.3 引入 `BackendTLSPolicy`（Experimental 通道），用于配置 Gateway → backend Service 的 TLS 加密。

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: backend-tls
  namespace: app-team
spec:
  targetRefs:
    - group: ""
      kind: Service
      name: secure-api
  tls:
    caCertRefs:
      - name: backend-ca
        group: ""
        kind: ConfigMap
    hostname: api.internal.example.com   # SNI
```

**该策略自动匹配**：无需在 HTTPRoute 中显式引用。只要 Service 匹配 `targetRefs`，Gateway 发送给该 Service 的流量自动启用 TLS。

---

## 12. 超时与重试（实现特定）

**不属于 Gateway API 标准字段**，各实现通过自定义 Policy CRD 提供。由于是最常用的非标能力，以下覆盖 4 个主流实现的完整示例。

### 12.1 Envoy Gateway

**CRD**：`BackendTrafficPolicy`（per-route，绑定到 HTTPRoute）/ `ClientTrafficPolicy`（per-gateway，绑定到 Gateway）

```yaml
# BackendTrafficPolicy — 按 route 配置超时与重试
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-timeout-policy
  namespace: app-team
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: api-route
  timeout:
    http:
      requestTimeout: 30s              # 后端响应超时
      connectionIdleTimeout: 300s      # 空闲连接保活时间
      maxConnectionDuration: 600s      # 连接最大寿命
  retry:
    numRetries: 3
    retryOn:
      triggers:
        - "5xx"                        # 5xx 状态码
        - "gateway-error"              # 网关级错误（502/503/504）
        - "reset"                      # 连接重置
        - "retriable-4xx"              # 可重试 4xx（409）
        - "connect-failure"            # 连接后端失败
    perRetryTimeout: 5s                # 每次重试的超时
    retryBackOff:
      baseInterval: 1s
      maxInterval: 10s
---
# ClientTrafficPolicy — 按 Gateway 配置客户端侧超时
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: client-timeout
  namespace: gateway-system
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: prod-gateway
  timeout:
    http:
      requestReceivedTimeout: 60s      # 接收完整请求的超时
      idleTimeout: 300s                # 客户端空闲超时
```

### 12.2 NGINX Gateway Fabric

**CRD**：`ClientSettingsPolicy`

```yaml
apiVersion: gateway.nginx.org/v1alpha1
kind: ClientSettingsPolicy
metadata:
  name: timeout-policy
  namespace: app-team
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: api-route
  clientSettings:
    timeouts:
      read: 30s                        # 读取请求正文超时
      send: 30s                        # 发送响应到客户端超时
    keepAlive:
      requests: 1000                   # 单连接最大请求数
      time: 75s                        # 保活超时
    retry:
      attempts: 3
      statusCodes: "500,502,503,504"
      onMethods: "GET,HEAD"
```

### 12.3 Istio

**CRD**：`VirtualService` + `DestinationRule`

```yaml
# VirtualService — 路由级超时与重试
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: api-vs
  namespace: app-team
spec:
  hosts:
    - api.example.com
  gateways:
    - istio-system/gateway-api-gw       # 引用 Gateway API 的 Gateway 名称
  http:
    - match:
        - uri:
            prefix: /api
      route:
        - destination:
            host: api-service.app-team.svc.cluster.local
            port:
              number: 80
      timeout: 30s                      # 请求总超时
      retries:
        attempts: 3
        perTryTimeout: 5s
        retryOn: "5xx,gateway-error,reset,connect-failure"
      fault:
        delay:
          percentage:
            value: 10
          fixedDelay: 5s                # 故障注入（可选）
---
# DestinationRule — 连接池与负载均衡
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: api-dr
  namespace: app-team
spec:
  host: api-service.app-team.svc.cluster.local
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
        connectTimeout: 3s
      http:
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
        maxRequestsPerConnection: 10
```

### 12.4 Traefik

**CRD**：`Middleware`

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: api-timeout
  namespace: app-team
spec:
  retry:
    attempts: 3
    initialInterval: 100ms
  buffering:
    maxRequestBodyBytes: 10485760       # 10MB
    maxResponseBodyBytes: 10485760
    memRequestBodyBytes: 2097152
    memResponseBodyBytes: 2097152
```

> Traefik 通过 `traefik.ingress.kubernetes.io/router.middlewares` 注解在 HTTPRoute 上引用 Middleware。

---

## 13. 会话保持（实现特定）

**不属于 Gateway API 标准字段**。基于 Cookie、Header 或源 IP 的会话保持，以下是 4 个实现的配置方式。

### 13.1 Envoy Gateway

**CRD**：`BackendTrafficPolicy.spec.sessionPersistence`

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: sticky-session
  namespace: app-team
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: stateful-route
  sessionPersistence:
    cookieName: SESSION_STICKY          # Cookie 名称
    cookieTTL: 3600s                    # Cookie 生命周期
    cookiePath: /app                    # Cookie 作用路径（可选）
    cookieDomain: example.com           # Cookie 作用域（可选）
    cookieSameSite: Lax                 # None / Lax / Strict
    cookieSecure: true                  # 仅 HTTPS 发送
```

### 13.2 NGINX Gateway Fabric

**CRD**：`ClientSettingsPolicy`

```yaml
apiVersion: gateway.nginx.org/v1alpha1
kind: ClientSettingsPolicy
metadata:
  name: sticky-session
  namespace: app-team
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: stateful-route
  sessionPersistence:
    cookieName: NGINX_STICKY
    expires: 3600s
    path: /
    domain: .example.com
    httpOnly: true                      # 防 XSS
    secure: true
    sameSite: Strict
```

### 13.3 Istio

**CRD**：`DestinationRule.spec.trafficPolicy.loadBalancer.consistentHash`

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: sticky-dr
  namespace: app-team
spec:
  host: stateful-service.app-team.svc.cluster.local
  trafficPolicy:
    loadBalancer:
      consistentHash:
        httpCookie:
          name: ISTIO_STICKY
          ttl: 3600s
          path: /app
        # 也可用 httpHeaderName 或 useSourceIp：
        # httpHeaderName: x-user-id
        # useSourceIp: true
    connectionPool:
      tcp:
        maxConnections: 100
```

### 13.4 Traefik

**CRD**：`Middleware.sticky`

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: sticky-cookie
  namespace: app-team
spec:
  sticky:
    cookie:
      name: TRAEFIK_STICKY
      httpOnly: true
      secure: true
      sameSite: Lax
      maxAge: 3600
```

---

## 14. CORS（实现特定）

**不属于 Gateway API 标准字段**。标准层面的 CORS 仍在 [GEP-1762](https://github.com/kubernetes-sigs/gateway-api/issues/1762) 讨论中（计划纳入 `filters` 标准字段，但目前没有时间表）。以下覆盖 4 个实现的完整 YAML 示例。

### 14.1 Envoy Gateway

**CRD**：`SecurityPolicy.spec.cors`

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: cors-policy
  namespace: app-team
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: api-route
  cors:
    allowOrigins:
      - "https://app.example.com"
      - "https://admin.example.com"
    allowMethods:
      - GET
      - POST
      - PUT
      - DELETE
      - OPTIONS
    allowHeaders:
      - "Authorization"
      - "Content-Type"
      - "X-Requested-With"
    exposeHeaders:
      - "X-Request-Id"
      - "X-Response-Time"
    maxAge: 86400s                      # 86400s = 24h
    allowCredentials: true               # 允许携带 Cookie/Authorization
```

### 14.2 NGINX Gateway Fabric

**CRD**：`ClientSettingsPolicy`

```yaml
apiVersion: gateway.nginx.org/v1alpha1
kind: ClientSettingsPolicy
metadata:
  name: cors-policy
  namespace: app-team
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: api-route
  cors:
    allowOrigins:
      - "https://*.example.com"
    allowMethods:
      - GET
      - POST
      - PUT
      - DELETE
      - OPTIONS
    allowHeaders:
      - "Authorization"
      - "Content-Type"
    exposeHeaders:
      - "X-Request-Id"
    maxAge: 3600s
    allowCredentials: true
```

### 14.3 Istio

**CRD**：`VirtualService.corsPolicy`（Istio 1.18+，推荐方式）或 `EnvoyFilter`（精细控制）

```yaml
# 方式 A：通过 VirtualService CORS policy（最简单）
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: api-vs
  namespace: app-team
spec:
  hosts:
    - api.example.com
  http:
    - corsPolicy:
        allowOrigins:
          - exact: "https://app.example.com"
        allowMethods:
          - GET
          - POST
          - PUT
          - DELETE
          - OPTIONS
        allowHeaders:
          - "Authorization"
          - "Content-Type"
        exposeHeaders:
          - "X-Request-Id"
        maxAge: 86400s
        allowCredentials: true
      route:
        - destination:
            host: api-service.app-team.svc.cluster.local
            port:
              number: 80
---
# 方式 B：通过 EnvoyFilter（更精细，支持正则 Origin）
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: cors-filter
  namespace: app-team
spec:
  workloadSelector:
    labels:
      app: api-service
  configPatches:
    - applyTo: HTTP_FILTER
      match:
        context: SIDECAR_INBOUND
        listener:
          filterChain:
            filter:
              name: "envoy.filters.network.http_connection_manager"
              subFilter:
                name: "envoy.filters.http.router"
      patch:
        operation: INSERT_BEFORE
        value:
          name: envoy.filters.http.cors
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.http.cors.v3.Cors
```

### 14.4 Traefik

**CRD**：`Middleware.headers`

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: cors-headers
  namespace: app-team
spec:
  headers:
    customResponseHeaders:
      Access-Control-Allow-Origin: "https://app.example.com"
      Access-Control-Allow-Methods: "GET,POST,PUT,DELETE,OPTIONS"
      Access-Control-Allow-Headers: "Authorization,Content-Type"
      Access-Control-Expose-Headers: "X-Request-Id"
      Access-Control-Max-Age: "86400"
      Access-Control-Allow-Credentials: "true"
```

> Traefik 需要额外配置 OPTIONS 请求处理（另一条 rule 或 Middleware 返回 204）。

### 各实现 CORS 配置对比

| 能力 | Envoy Gateway | NGINX GW Fabric | Istio (VirtualService) | Traefik |
|------|:---:|:---:|:---:|:---:|
| Allow Origins | `cors.allowOrigins[]` | `cors.allowOrigins[]` | `corsPolicy.allowOrigins[]` | `customResponseHeaders` |
| Allow Methods | `cors.allowMethods[]` | `cors.allowMethods[]` | `corsPolicy.allowMethods[]` | 同上 |
| Allow Headers | `cors.allowHeaders[]` | `cors.allowHeaders[]` | `corsPolicy.allowHeaders[]` | 同上 |
| Expose Headers | `cors.exposeHeaders[]` | `cors.exposeHeaders[]` | `corsPolicy.exposeHeaders[]` | 同上 |
| Credentials | `cors.allowCredentials` | `cors.allowCredentials` | `corsPolicy.allowCredentials` | 同上 |
| Max Age | `cors.maxAge` | `cors.maxAge` | `corsPolicy.maxAge` | 同上 |
| Wildcard Origin | ✅ | ✅ | ❌ 仅 Exact/Prefix | ✅ 手动设 `*` |

> **趋势**：[GEP-1762](https://github.com/kubernetes-sigs/gateway-api/issues/1762) 正在推进将 CORS 纳入 Gateway API 的 `HTTPRouteRule.Filters` 标准字段。在此之前，Envoy Gateway 的 `SecurityPolicy.cors` 是最接近标准化的实践。

---

> **关键优势**：以上第 1～10 项能力均为 **Gateway API 标准字段**，不依赖实现特定注解，跨实现可移植。

## 关联知识

- [[Gateway API 概述]]
- [[../K8s 1.28-1.36 版本更新总结]]

## 参考资源

- HTTPRoute 规范：https://gateway-api.sigs.k8s.io/reference/spec/#gateway.networking.k8s.io/v1.HTTPRoute
- Envoy Gateway Policy：https://gateway.envoyproxy.io/docs/tasks/traffic/backend-traffic-policy/
- NGINX Gateway Fabric：https://docs.nginx.com/nginx-gateway-fabric/reference/api-reference/
- Istio Gateway API 集成：https://istio.io/latest/docs/tasks/traffic-management/ingress/gateway-api/
- Traefik Gateway API：https://doc.traefik.io/traefik/routing/providers/kubernetes-gateway/
- GEP-1762（CORS 标准化）：https://github.com/kubernetes-sigs/gateway-api/issues/1762

---

**状态**: 📖 已掌握

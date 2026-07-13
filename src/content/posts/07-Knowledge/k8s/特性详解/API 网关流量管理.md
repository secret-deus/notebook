---
date: 2026-07-08
tags:
  - envoy
  - api-gateway
  - 限流
  - 熔断
  - 认证
type: 学习笔记
category: 云原生/Kubernetes/流量管理
source: https://www.envoyproxy.io/docs/
difficulty: 高级
title: "API 网关流量管理"
---

# API 网关流量管理

## 概述

Istio 的 Sidecar 是 Envoy，Cilium 的 Gateway 实现也是 Envoy，Envoy Gateway 本身也是一个独立项目。不管选哪个上层框架，**底层面 Data Plane 都是 Envoy**。理解 Envoy 的核心概念就等于理解了 K8s 生态中所有 API 网关的"最大公约数"。

> 一句话：K8s 的 API 网关有三个本质问题——谁可以进来（认证）、进来后能调什么（路由）、调不动时怎么办（限流熔断）。Envoy 通过 Listener → Route → Cluster → Endpoint 四层抽象解决了这三个问题。

## Envoy 四层抽象

```
Listener (监听器) —— 绑定 IP:Port，接收请求
  ↓
Route (路由) —— 根据 Host/Path/Header 匹配，决定去哪个 Cluster
  ↓
Cluster (上游集群) —— 一组 Endpoint 的集合 + 负载均衡 + 连接池 + 熔断
  ↓
Endpoint (端点) —— 具体的 IP:Port（就是 Pod IP）
```

```
请求到达 Listener (0.0.0.0:443)
  → TLS 终止
  → HTTP Connection Manager (filter chain)
  → Router filter 匹配路由表:
      match: host=api.health.example.com && path=/api/checkout
      → route to Cluster: health-ack-cluster
      → load_balancer: LEAST_REQUEST
      → circuit_breaker: max_connections=100
      → 选一个 Endpoint: 10.244.1.5:8080
      → 发起 upstream 请求
```

### 类比 Ingress NGINX

| Envoy 概念 | Ingress NGINX 等价 | Istio CRD |
|------|------|------|
| Listener | `server { listen 443; }` | Gateway |
| Route | `location /api/ { proxy_pass ...; }` | VirtualService |
| Cluster | `upstream backend { server x; server y; }` | DestinationRule |
| Endpoint | upstream 中的每个 `server` | Pod IP |
| Filter Chain | `proxy_set_header`, `rewrite`, `rate_limit` | EnvoyFilter |

## 限流 —— 防止雪崩的第一道闸

### Envoy 本地限流（per-Envoy）

每个 Envoy 进程独立计数的限流，不跨 Pod 协调。适合防护单 Envoy 实例被单客户端打爆的场景。

```yaml
# Envoy 配置中定义限流规则（典型用于 EnvoyFilter）
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: rate-limit
  namespace: health
spec:
  workloadSelector:
    labels:
      app: health-ack
  configPatches:
    - applyTo: HTTP_FILTER
      match:
        context: SIDECAR_INBOUND
      patch:
        operation: INSERT_BEFORE
        value:
          name: envoy.filters.http.local_ratelimit
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.http.local_ratelimit.v3.LocalRateLimit
            stat_prefix: http_local_rate_limiter
            token_bucket:
              max_tokens: 100        # 桶容量
              tokens_per_fill: 10    # 每 fill_interval 补的令牌数
              fill_interval: 1s      # 补令牌间隔
            
            # 按规则匹配限流
            filter_enabled:
              runtime_key: local_rate_limit_enabled
              default_value:
                numerator: 100
                denominator: HUNDRED
            filter_enforced:
              runtime_key: local_rate_limit_enforced
              default_value:
                numerator: 100
                denominator: HUNDRED
            
            # 限制 header 匹配的请求
            request_headers_to_add_when_not_enforced:
              - header:
                  key: x-rate-limited
                  value: "true"
```

本地限流的局限：3 个 Envoy 副本 × 各 100 req/s = 总计 300 req/s 的实际吞吐。如果上游只能承受 200 req/s，本地限流保护不了上游。

### 全局限流（Redis-backed Rate Limit Service）

所有 Envoy 共享同一个计数器（Redis），精确全局限流：

```
Envoy-A → gRPC → Rate Limit Service → Redis (原子计数器)
Envoy-B → gRPC → Rate Limit Service → Redis
Envoy-C → gRPC → Rate Limit Service → Redis
```

```yaml
# rate-limit-service config
domain: health-api
descriptors:
  # 规则 1: 全局限制——所有 /api/checkout 请求，每秒 1000
  - key: generic_key
    value: checkout-global
    rate_limit:
      unit: second
      requests_per_unit: 1000

  # 规则 2: 按用户限制——每 API Key 每秒 10 请求
  - key: header_match
    header_name: x-api-key
    rate_limit:
      unit: second
      requests_per_unit: 10

  # 规则 3: 按路径 + 方法限制
  - key: header_match
    header_name: :path
    descriptors:
      - key: header_match
        header_name: :method
        value: POST
        rate_limit:
          unit: minute
          requests_per_unit: 100
```

Envoy 端配置 filter chain 调用 Rate Limit Service：

```yaml
http_filters:
  - name: envoy.filters.http.ratelimit
    typed_config:
      "@type": type.googleapis.com/envoy.extensions.filters.http.ratelimit.v3.RateLimit
      domain: health-api
      stage: 0                           # 多个限流 stage 可以叠加（0 先于 1）
      rate_limit_service:
        grpc_service:
          envoy_grpc:
            cluster_name: rate-limit-cluster
      request_type: external             # 每次都调用外部限流服务
```

## 熔断 —— 防止故障传播

Envoy 的熔断是**被动健康检查**（outlier detection）：不是 ping 上游看是否健康，而是根据实际请求的结果判断。连续失败 N 次 → 认为不健康 → 弹出负载均衡池 N 秒 → 放回。

```yaml
# Envoy Cluster 的熔断配置
circuit_breakers:
  thresholds:
    - priority: DEFAULT
      max_connections: 1024              # 最大并发连接数
      max_pending_requests: 1024          # 最大排队请求（等待可用连接）
      max_requests: 1024                  # 最大并发请求（HTTP/2 多路复用）
      max_retries: 3                      # 最大并发重试
  thresholds:
    - priority: HIGH                     # 高优先级连接单独控制
      max_connections: 512

outlier_detection:                       # 异常检测（熔断）
  consecutive_5xx: 5                     # 连续 5 个 5xx → 弹出
  interval: 5s                           # 每 5s 检查一次
  base_ejection_time: 30s                # 弹出 30 秒
  max_ejection_percent: 50               # 最多弹出 50% 的 endpoint
  # 当 50% 都被弹出后，剩余的 50% 进入 "panic mode"
  # panic mode: 不接受熔断规则，接受所有流量作为保底（宁可慢不能全挂）
  
  # 按成功/失败率弹出
  success_rate_minimum_hosts: 5          # 至少 5 个 host 才计算成功率
  success_rate_stdev_factor: 1900         # 成功率低于 mean - 1.9*std → 弹出
```

### Panic Mode

Envoy 的 Panic Mode 是设计亮点——当超过 `max_ejection_percent` 的 endpoint 被熔断时，Envoy **不再遵守熔断规则**，把请求发给剩余的 endpoint，保底不中断全局服务。

```
正常: 10 个 endpoint，5 个返回 5xx → 5 个被弹出 → 只有 5 个服务流量
Panic: 10 个 endpoint，8 个返回 5xx → max_ejection_percent=50 → 最多弹出 5 个
       剩余 5 个在 panic mode → 实际 3 个健康的 + 2 个被强制保留的在跑
       全局服务中断概率从 100% 降至 ~40%
```

## 认证鉴权 —— 谁可以进、能调什么

### 模式 1：JWT 在 Gateway 层验证（推荐）

```
Client → Gateway
           ↓ 验证 JWT (iss/aud/exp/signature)
           ↓ 提取 claims → 注入 x-auth-user header
           ↓ 转发到 upstream（upstream 信任 header 中的用户信息）
         Upstream Service
```

Envoy JWT filter 配置：

```yaml
http_filters:
  - name: envoy.filters.http.jwt_authn
    typed_config:
      "@type": type.googleapis.com/envoy.extensions.filters.http.jwt_authn.v3.JwtAuthentication
      providers:
        okta:
          issuer: https://dev-xxx.okta.com
          audiences:
            - health-api
          from_headers:
            - name: Authorization
              value_prefix: "Bearer "
          remote_jwks:
            http_uri:
              uri: https://dev-xxx.okta.com/.well-known/jwks.json
              cluster: okta-jwks-cluster              # 需要预定义可出外网的 Cluster
              timeout: 5s
            cache_duration: 300s                       # 缓存 JWKS 5 分钟
          forward: true                                # 把原始 JWT 转发给 upstream
          payload_in_metadata: okta_payload            # Claims 存在动态 metadata 中

      rules:
        # 规则 1: /api/health 不需要认证
        - match:
            prefix: /api/health
          requires: {}
        # 规则 2: 其他所有路径需要 Okta JWT
        - match:
            prefix: /
          requires:
            provider_name: okta
```

### 模式 2：API Key 鉴权（M2M 通信）

```yaml
# Envoy lua filter 或其他自定义 filter 提取 API Key
http_filters:
  - name: envoy.filters.http.lua
    typed_config:
      inline_code: |
        function envoy_on_request(request_handle)
          local key = request_handle:headers():get("x-api-key")
          if key == nil or key == "" then
            request_handle:respond({[":status"] = "401"}, "Missing API Key")
            return
          end
          -- 在实际生产中使用 Redis 查 key 的有效性
          request_handle:headers():add("x-authenticated", "true")
        end
```

### 模式 3：mTLS（Istio 自动管理）

这是你迁移到 Istio 后的默认模式——不需要在 Envoy 层额外配置，Istio PeerAuthentication STRICT 自动生效。Gateway 层验证客户端证书是否由 Citadel CA 签发。

## 超时与重试的正确组合

超时和重试必须协同配置，否则会放大故障：

```yaml
# Envoy Route 配置
routes:
  - match:
      prefix: "/api/checkout"
    route:
      cluster: payment-cluster
      timeout: 5s                           # 请求总超时
      idle_timeout: 60s                     # 空闲连接超时

      retry_policy:
        retry_on: "5xx,connect-failure,refused-stream,reset"
        num_retries: 2                      # 最多重试 2 次（共 3 次尝试）
        per_try_timeout: 2s                 # 每次尝试超时 2s
        # 关键：per_try_timeout < route.timeout
        # 如果 perTryTimeout >= timeout → 重试永远等不到超时

        # 重试预算（防止重试风暴）
        retry_budget:
          budget_percent:
            value: 20                       # 最多 20% 的额外请求用于重试
          min_retry_concurrency: 3          # 最少保证 3 个并发重试

      # 对冲（hedge）——同 request 发多份，取最快返回的
      hedge_policy:
        initial_requests: 1                 # 正常只发 1 份
        additional_request_chance:          # 1% 的概率额外发第 2 份（对冲）
          numerator: 1
          denominator: 100
```

重试的最大风险——**重试放大（retry amplification）**：

```
请求 → Gateway → Service A → Service B → Service C
                  retries=3      retries=3      retries=3

1 个上游请求失败 → Service A 重试 2 次
  → 每次重试到 Service B → Service B 可能也重试 2 次
    → 每次到 Service C → Service C 再重试 2 次

最坏: 1 次失败 → 3 × 3 × 3 = 27 次请求到达 Service C
```

解决方案：`x-envoy-attempt-count` header（每层重试次数递增），下游根据这个 header 在自己的 retry policy 中跳过。

## 从 Ingress NGINX 到 Envoy 的配置迁移

| 功能 | NGINX annotation | Envoy / Istio 配置 |
|------|------|------|
| 路径重写 | `nginx.ingress.kubernetes.io/rewrite-target` | VirtualService `rewrite.uri` |
| CORS | `nginx.ingress.kubernetes.io/enable-cors` | VirtualService `corsPolicy` |
| 限流 | `nginx.ingress.kubernetes.io/limit-rps` | EnvoyFilter (local rate limit) 或 Rate Limit Service |
| 白名单 | `nginx.ingress.kubernetes.io/whitelist-source-range` | AuthorizationPolicy `ipBlocks` |
| 基本认证 | `nginx.ingress.kubernetes.io/auth-type: basic` | RequestAuthentication (JWT) 或 EnvoyFilter (basic auth) |
| 限 body 大小 | `nginx.ingress.kubernetes.io/proxy-body-size` | EnvoyFilter 修改 `max_request_bytes` |
| 连接超时 | `nginx.ingress.kubernetes.io/proxy-read-timeout` | VirtualService `timeout` |
| 自定义错误页 | `nginx.ingress.kubernetes.io/custom-http-errors` | EnvoyFilter `local_reply_config` |
| Sticky Session | `nginx.ingress.kubernetes.io/affinity: cookie` | DestinationRule `consistentHash.httpCookie` |
| 连接数限制 | `nginx.ingress.kubernetes.io/limit-connections` | DestinationRule `connectionPool.tcp.maxConnections` |

## 关联知识

- [[../gateway-api/Gateway API 概述]] — Gateway API 的 HTTPRoute 替代 Ingress annotation 的声明式方式
- [[../gateway-api/HTTPRoute 核心能力详解]] — HTTPRoute 中 header/query match、weight、redirect 的实现
- [[Istio 服务网格详解]] — Envoy 作为 Istio Sidecar 的配置（VirtualService/DestinationRule）
- [[K8s 安全加固实战]] — NetworkPolicy + AuthorizationPolicy 的流量管控组合

## 参考资源

- Envoy 文档：https://www.envoyproxy.io/docs/
- Envoy Filter Chain：https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/listeners/network_filters
- Rate Limit Service：https://github.com/envoyproxy/ratelimit
- Envoy Circuit Breaking：https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 流量管理 | 2026-07-08 | Envoy 四层抽象、限流/熔断/重试/认证、NGINX→Envoy 迁移对照 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-15

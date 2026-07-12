---
date: 2026-06-29
tags:
  - k8s
  - gateway-api
  - ingress
  - 网络
type: 学习笔记
category: 云原生/Kubernetes/网络
source: https://gateway-api.sigs.k8s.io/
difficulty: 进阶
title: "Gateway API 概述"
---

# Gateway API 概述

## 概述

Gateway API 是 Kubernetes SIG-Network 主导的**下一代入口网关与流量路由 API 标准**，用于取代 Ingress。它是一组声明式、角色导向、可扩展的 CRD，解决 Ingress 模型「过于简陋、缺少多租户、不可移植」三大痛点。v1.0 于 2023-10 发布（GA），2026 年进入 **v1.3**，已成为生产就绪的标准。

> 与你的运维关联：**Ingress NGINX 已于 2026-03-24 退役**，Gateway API 是官方推荐的迁移方向。

## 为什么需要 Gateway API（vs Ingress）

| 痛点 | Ingress | Gateway API |
|------|---------|-------------|
| **模型粒度** | 单资源（Ingress），规则与实现耦合 | 多资源分层（GatewayClass → Gateway → Route），关注点分离 |
| **能力表达** | 基于注解（`nginx.ingress.kubernetes.io/...`）不可移植 | 原生字段定义流量拆分、header 匹配、权重、重定向等 |
| **角色分离** | 全部混在一起，无 RBAC 边界 | 基础设施管理员管理 Gateway，应用开发者管理 Route |
| **协议支持** | 仅 HTTP/HTTPS | HTTP、TCP、UDP、TLS、gRPC（多 Route 类型） |
| **多租户** | 每个 Ingress 无隔离，冲突靠实现 | Route 可绑定到命名空间级别的 Gateway，天然隔离 |
| **可移植性** | 注解绑定具体实现，迁移成本高 | 核心字段标准，跨实现可移植 |

## 核心概念

Gateway API 围绕**三个角色 + 四类资源**设计。

### 角色模型（Personas）

```
┌─────────────────────┐
│  基础设施管理员        │ → 管理 GatewayClass（集群级能力池）
│  (Infra Admin)       │
└─────────┬───────────┘
          │ 定义能力
┌─────────▼───────────┐
│  集群运维             │ → 管理 Gateway（部署网关实例、分配域名/证书）
│  (Cluster Operator)  │
└─────────┬───────────┘
          │ 提供接入点
┌─────────▼───────────┐
│  应用开发者           │ → 管理 Route（定义路由规则、流量策略）
│  (App Developer)     │
└─────────────────────┘
```

### 四类核心资源

#### 1. GatewayClass — 集群级能力定义
- **管理者**：基础设施管理员
- **作用**：定义「用什么实现」，类比 StorageClass
- **示例**：`gateway.networking.k8s.io/gateway-class` 指向一个 controller（如 nginx-gateway-fabric、istio、contour）

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nginx
spec:
  controllerName: gateway.nginx.org/nginx-gateway-controller
```

#### 2. Gateway — 网关实例部署
- **管理者**：集群运维
- **作用**：定义「网关在哪，监听什么」，实际部署数据面（Pod/Deployment）
- **关键字段**：`listeners`（协议 + 端口 + 域名 + TLS）、`addresses`、`infrastructure`（副本数等）
- **Gateway 监听器**：每个 listener 绑定一组 Route

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: gateway-system
spec:
  gatewayClassName: nginx
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: "*.example.com"
      tls:
        mode: Terminate
        certificateRefs:
          - name: wildcard-example-tls
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              share-gateway: "true"
```

#### 3. Route — 路由规则（核心）
- **管理者**：应用开发者
- **作用**：定义「流量怎么走到服务」，完全在应用命名空间
- **类型**：
  - **HTTPRoute**（最常用）：HTTP/HTTPS L7 路由
  - **GRPCRoute**：gRPC 流量路由，v1.3 GA
  - **TLSRoute**：TLS 透传（SNI 路由）
  - **TCPRoute** / **UDPRoute**：L4 流量路由

**HTTPRoute 示例**（体现 Gateway API 的核心能力）：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app-route
  namespace: app-team
spec:
  parentRefs:
    - name: prod-gateway           # 绑定到哪个 Gateway
      namespace: gateway-system
      sectionName: https           # 绑定到具体 listener
  hostnames:
    - "api.example.com"
  rules:
    # 规则 1：header 匹配 + 流量拆分
    - matches:
        - headers:
            - name: "x-canary"
              value: "v2"
      backendRefs:
        - name: app-service-v2
          port: 80
          weight: 100
    # 规则 2：URL 路径前缀匹配 + 权重
    - matches:
        - path:
            type: PathPrefix
            value: "/api"
      backendRefs:
        - name: app-service-v1
          port: 80
          weight: 90
        - name: app-service-v2
          port: 80
          weight: 10
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: "x-from-gateway"
                value: "true"
    # 规则 3：精确匹配 + 重定向
    - matches:
        - path:
            type: Exact
            value: "/old"
      filters:
        - type: RequestRedirect
          requestRedirect:
            statusCode: 301
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: "/new"
```

#### 4. 扩展资源（Policy、BackendTLSPolicy 等）
- **ReferenceGrant**（原 ReferencePolicy）：跨命名空间引用授权
- **BackendTLSPolicy**（v1.3 Alpha）：后端 mTLS/Gateway → Service 加密
- **各种 Policy**：超时、重试、健康检查等（部分由实现自定义）

## 协议路由类型总览

| Route 类型 | 版本 | 协议 | 典型场景 |
|-----------|------|------|----------|
| HTTPRoute | v1.0 GA | HTTP/HTTPS | Web API、微服务、REST |
| GRPCRoute | v1.3 GA | gRPC over HTTP/2 | 微服务间 gRPC 通信 |
| TLSRoute | v1.2 GA | TLS 透传 (SNI) | 基于 SNI 的 TCP+TLS 路由 |
| TCPRoute | v1.0 GA | TCP | 数据库代理、非 HTTP 流量 |
| UDPRoute | v1.0 GA | UDP | DNS、游戏、流媒体 |

## 核心能力矩阵（HTTPRoute）

HTTPRoute 是 Gateway API 最核心的 Route 类型，处理管线为 **Matches → Filters → BackendRefs**。共 14 种能力：前 10 项是 Standard 标准字段（跨实现可移植），后 4 项由各实现通过 Policy CRD 提供。

> 每种能力的**字段路径、参数表、完整 YAML 示例**已独立为 [[HTTPRoute 核心能力详解]]，作为参考手册随时查阅。

### 能力速览

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

### 处理管线

```
请求进入 → Matches（rule 间 OR，match 间 AND，取第一条命中）
               ↓
          Filters（顺序执行，可组合多个 filter）
               ↓
          BackendRefs（按 weight 加权分发）
```

## Gateway API vs Ingress 迁移对照

| Ingress 概念 | Gateway API 等价物 |
|-------------|-------------------|
| Ingress | HTTPRoute |
| IngressClass | GatewayClass |
| `host` 字段 | `hostnames` |
| `paths` | `matches[].path` |
| `backend` | `backendRefs` |
| `nginx.ingress.kubernetes.io/canary: "true"` | `backendRefs[].weight` |
| `nginx.ingress.kubernetes.io/rewrite-target: /` | `filters[].requestRedirect` 或 `URLRewrite` |
| TLS Secret 注解 | `Gateway.spec.listeners[].tls.certificateRefs` |
| 默认后端 | 实现特定 |

## 版本演进与通道模型

Gateway API 不在 Kubernetes 核心仓库开发，**有独立的发布节奏**，但 API 版本号与 K8s 无关。

### 通道模型（Channel Model）

| 通道 | 含义 | 当前状态 |
|------|------|----------|
| **Standard** | 所有实现必须支持的**稳定核心** | HTTPRoute、Gateway、GatewayClass v1 GA |
| **Experimental** | 可选实验性特性，可用于测试 | BackendTLSPolicy、扩展字段等 |

### 版本发布历史

| 版本 | 时间 | 关键里程碑 |
|------|------|-----------|
| v0.5 | 2022-06 | 首个 beta，HTTPRoute beta |
| v0.8 | 2023-03 | GRPCRoute 引入 |
| **v1.0** | **2023-10** | **GA！Gateway、GatewayClass、HTTPRoute Standard Channel** |
| v1.1 | 2024-05 | GRPCRoute GA、TLSRoute/TCPRoute/UDPRoute GA、Session Persistence |
| v1.2 | 2024-10 | TLSRoute 正式 GA；BackendTLSPolicy、命名空间级 Gateway、反代 TLS |
| v1.3 | 2025-10 | GRPCRoute GA、更多匹配/过滤器特性 |

## 主流实现（比你想象的多）

| 实现 | 类型 | 说明 |
|------|------|------|
| **nginx-gateway-fabric** | 数据面代理 | NGINX 官方 Gateway API 实现，Ingress NGINX 的直接接替者 |
| **Envoy Gateway** | 数据面代理 | Envoy 官方 Gateway API 实现，Tetrate 主导 |
| **Istio** | Service Mesh | v1.15+ 支持 Gateway API 作为入口网关，已 GA |
| **Contour** | 数据面代理 | VMware 维护的 Envoy 方案，Gateway API 原生 |
| **Traefik** | 数据面代理 | v3.0+ 原生支持 Gateway API |
| **Cilium** | eBPF CNI | 内置 Gateway API 控制器，数据面在 eBPF |
| **HAProxy Ingress** | 数据面代理 | HAProxy 实现 Gateway API |
| **Kong** | API 网关 | Kong 支持 Gateway API |
| **GKE / AKS / EKS** | 云服务 | 三家云厂商均提供托管的 Gateway API 控制器 |

## 从 Ingress NGINX 迁移要点

由于 Ingress NGINX 已于 2026-03-24 退役，你需要评估如下方案：

### 迁移路径

```
Ingress NGINX ──→  nginx-gateway-fabric（NGINX 官方 Gateway API 实现）
              ──→  Envoy Gateway（Envoy 生态，功能最丰富）
              ──→  Cilium Gateway API（如果已用 Cilium CNI）
              ──→  云 LB 控制器（AKS ALB / GKE Gateway / AWS VPC Lattice）
```

### 迁移步骤（高风险，需分阶段验证）

1. **审计现有 Ingress**：`kubectl get ingress -A -o yaml`，列出所有域名、路径规则、注解
2. **映射注解 → Gateway API 字段**：逐条对照迁移表（见上）
3. **部署 Gateway API CRD + 选择实现**：安装选定的控制器
4. **双写验证**：Gateway + HTTPRoute 与旧 Ingress 并存，A/B 流量对比
5. **灰度切流**：逐步将 DNS/外部 LB 指向新 Gateway
6. **下线旧 Ingress**

> **对你当前环境的影响**：你负责 `api-health.qingsongbaojian.com`、`api-tpa.qingsongjkkj.com` 等域名的 Ingress 配置，这些需要作为第一批迁移对象。

## 关联知识

- [[../K8s 1.28-1.36 版本更新总结]]（Ingress NGINX 退役在 1.35/1.36）
- [[../PSA详解]]
- Gateway API HTTPRoute 详解（待细化）
- Gateway API 迁移实战（待细化）
- 常用实现对比（待细化）

## 参考资源

- 官方文档：https://gateway-api.sigs.k8s.io/
- 实现列表：https://gateway-api.sigs.k8s.io/implementations/
- 从 Ingress 迁移指南：https://gateway-api.sigs.k8s.io/guides/migrating-from-ingress/
- nginx-gateway-fabric：https://github.com/nginxinc/nginx-gateway-fabric
- Envoy Gateway：https://gateway.envoyproxy.io/
- Ingress NGINX 退役公告：https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 初次学习 | 2026-06-29 | 概述通读，理解核心概念与角色模型 |
| 深入理解 | | 选一个实现动手部署 |
| 实战应用 | | 迁移一个生产 Ingress 到 Gateway API |
| 复习回顾 | | 对比实现选型 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-06

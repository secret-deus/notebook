---
title: "Ingress_reload_失败_health_api-tpa"
publish: true
---

# Ingress reload 失败问题总结（health controller / api-tpa）

> 事件时间：2026-06-11（上周四）

## 0. 排查工具：查 Ingress controller 内部 upstream / backend

通过 controller 的 10246 端口可以直接拿到 controller 内存里的 backend / upstream 状态：

```bash
# 列出 controller 当前所有 backend
curl -s http://localhost:10246/configuration/backends | jq .

# 找具体 Ingress 对应的 backend
curl -s http://localhost:10246/configuration/backends | \
  jq '.[] | select(.name | contains("api-tpa"))'

# 看某个 service 的 endpoints 是否被正确解析
curl -s http://localhost:10246/configuration/backends | \
  jq '.[] | {name, endpoints: .endpoints, service: .service}'
```

适用场景：

```text
- Ingress reload 失败时，确认 controller 端是否已经生成了新的 backend
- 502 排查时，看 controller 选中的 upstream endpoint 是否和 Service 实际 endpoints 一致
- 后端 Pod 扩缩容后，看 controller 端 endpoints 是否及时刷新
- upstream_addr 显示 upstream group 名字（不是具体 IP）时，配合这个接口看是否所有 peer 都被标记 failed
```

> 10246 是 ingress-nginx controller 内部 metrics / debug 端口，需要在 controller Pod 本机（或 kubectl port-forward）访问。

## 1. 直接故障现象

Ingress controller reload Nginx 失败：

```bash
directive "error_log" is not terminated by ";" in /tmp/nginx/nginx-cfg2489516325:7086
nginx: configuration file /tmp/nginx/nginx-cfg2489516325 test failed
```

这说明 **Ingress controller 生成出来的 nginx 配置语法错误**，导致 Nginx 无法 reload。

---

## 2. 直接原因

生成的 nginx 配置里有这段：

```nginx
# Custom code snippet configured for host api-tpa.qingsongjkkj.com
access_log /var/log/ingress/api-tpa.qingsongjkkj.com-access.log upstreaminfo; error_log /var/log/ingress/api-tpa.qingsongjkkj.com-error.log
```

问题是最后这一句：

```nginx
error_log /var/log/ingress/api-tpa.qingsongjkkj.com-error.log
```

末尾少了分号：

```nginx
;
```

正确应该是：

```nginx
error_log /var/log/ingress/api-tpa.qingsongjkkj.com-error.log error;
```

所以 Nginx 解析到下一段配置时，认为 `error_log` 指令没有正常结束，最终 reload 失败。

---

## 3. 为什么 Ingress YAML 里没看到 snippet

查 `api-tpa.qingsongjkkj.com` 这个 Ingress 时，发现 metadata annotations 里没有：

```yaml
nginx.ingress.kubernetes.io/server-snippet
nginx.ingress.kubernetes.io/configuration-snippet
```

但生成的 nginx 配置里却有：

```nginx
# Custom code snippet configured for host api-tpa.qingsongjkkj.com
```

说明这段自定义日志配置可能不是来自当前 Ingress YAML 本身，而可能来自：

```text
1. controller ConfigMap
2. 自定义 nginx template
3. 自动生成/注入逻辑
4. 其他配置管理脚本
```

所以后续要继续 grep 来源：

```bash
kubectl get cm -A -o yaml | grep -nA10 -B10 "api-tpa.qingsongjkkj.com-error.log"

kubectl get ingress -A -o yaml | grep -nA10 -B10 "api-tpa.qingsongjkkj.com-error.log"

grep -R "api-tpa.qingsongjkkj.com-error.log" /data/build/k8s/prod/ingress/health -n
```

---

## 4. 为什么 admission 没提前拦住

集群里确实有 ValidatingWebhookConfiguration：

```text
VWC: ingress-nginx-admission
service: ingress-nginx/ingress-nginx-controller-admission
failurePolicy: Fail
```

但是这个 Service 的 selector 太宽：

```yaml
selector:
  app.kubernetes.io/component: controller
  app.kubernetes.io/instance: ingress-nginx
  app.kubernetes.io/name: ingress-nginx
```

它没有带：

```yaml
qsc-platform: health
```

所以这个 admission Service 会选中多套 ingress controller，而不只是 health controller。

查到的 endpoints 是：

```text
10.111.138.21:8443,10.111.138.22:8443,10.111.138.23:8443 + 9 more...
```

说明 admission Service 后面挂了多个 controller Pod。

而 health controller 本身确实开了 webhook：

```bash
--controller-class=k8s.io/health-ingress-nginx
--ingress-class=health
--validating-webhook=:8443
--validating-webhook-certificate=/usr/local/certificates/cert
--validating-webhook-key=/usr/local/certificates/key
```

也就是说：**health controller 有校验能力，但 apiserver 调 admission 时不一定打到 health controller。** 

---

## 5. 真实问题本质

本质是：

```text
IngressClass health 对应 health-nginx-controller

但是 ValidatingWebhookConfiguration 只配置了一个公共 admission Service

这个 Service selector 太宽，选中了所有平台的 ingress-nginx controller

所以提交 health Ingress 时，admission 请求可能被转发到 crm / med / baoxian / bigdata 等 controller

这些 controller 发现 ingressClassName=health 不是自己负责的 class，可能直接跳过/放行

最终坏 snippet 没有在 kubectl apply 阶段被拦截

等 health controller 真正 reload nginx 时，才暴露语法错误
```

一句话总结：

**不是 admission 完全没开，而是 health 这套 Ingress 的 admission 校验链路不可靠，存在漏检。**

---

## 6. 影响

影响主要是：

```text
1. 新的 Ingress 配置无法 reload 生效
2. controller 继续使用旧 nginx 配置
3. 后续 Ingress 变更可能被阻塞
4. 如果错误配置持续存在，controller 每次 reload 都会失败
5. snippet 少一个分号就可能影响整套 health ingress controller
```

旧配置一般还能继续跑，但新变更不会生效。

---

## 7. 正确修复方向

短期修复：

```text
找到产生 api-tpa 那段 access_log/error_log 的来源
把 error_log 末尾补上分号
最好写完整日志级别
```

正确格式：

```nginx
access_log /var/log/ingress/api-tpa.qingsongjkkj.com-access.log upstreaminfo;
error_log /var/log/ingress/api-tpa.qingsongjkkj.com-error.log error;
```

长期修复：

```text
每个平台 ingress controller 单独拆 admission Service + ValidatingWebhookConfiguration
```

比如 health 单独建：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: health-nginx-controller-admission
  namespace: ingress-nginx
spec:
  type: ClusterIP
  ports:
    - name: https-webhook
      port: 443
      targetPort: webhook
  selector:
    app.kubernetes.io/component: controller
    app.kubernetes.io/instance: ingress-nginx
    app.kubernetes.io/name: ingress-nginx
    qsc-platform: health
```

然后 ValidatingWebhookConfiguration 指向：

```yaml
clientConfig:
  service:
    namespace: ingress-nginx
    name: health-nginx-controller-admission
    path: /networking/v1/ingresses
    port: 443
failurePolicy: Fail
```

但要注意：**证书也要重新匹配新的 Service DNS 名称**，否则 apiserver 调 webhook 会报 x509 证书不匹配。

---

## 8. 最终结论

这次问题可以总结成：

```text
health ingress controller 生成的 nginx 配置中，自定义日志 snippet 的 error_log 少了分号，导致 nginx reload 失败。

本应由 admission webhook 在提交 Ingress 时提前拦截，但当前 admission Service selector 过宽，混选了多套 ingress controller，导致 health Ingress 的校验请求可能打到非 health controller，从而被跳过放行。

所以问题根因有两个：
1. snippet 配置错误；
2. admission webhook 配置不可靠，未按 ingressClass/platform 隔离。
```

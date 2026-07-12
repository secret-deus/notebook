---
date: 2026-06-29
tags:
  - k8s
  - 安全
  - user-namespace
  - 容器隔离
type: 学习笔记
category: 云原生/Kubernetes/安全
source: https://kubernetes.io/blog/2026/04/22/kubernetes-v1-36-release/
difficulty: 进阶
title: "Pod 用户命名空间详解"
---

# Pod 用户命名空间详解

## 概述

用户命名空间（User Namespace）是 Kubernetes **v1.25 Alpha → v1.33 Beta 默认开启 → v1.36 GA** 的安全特性。它通过 Linux 内核的 user namespace 机制，将容器内的 root 用户（UID 0）映射到主机上的非特权 UID，从而彻底消除「容器逃逸后获得主机 root 权限」的威胁。

> KEP-127，同样历时多年达 GA。启用后：容器内 `root` → 主机上 `UID 65534 (nobody)` 或其他非特权 UID。

## 为什么需要用户命名空间

### 问题：容器 root = 主机 root（没有 user namespace 时）

```bash
# 以 root 运行的容器
docker run -it --rm alpine sh
whoami       # root
id           # uid=0(root) gid=0(root)

# 如果存在容器逃逸漏洞（CVE-2019-5736, CVE-2022-0492 等）
# 攻击者在容器内能做的事：
cat /etc/shadow          # ❌ 受能力限制
mount /dev/sda1 /mnt     # ❌ 需要 CAP_SYS_ADMIN
reboot                   # ❌ 需要 CAP_SYS_BOOT

# 但容器逃逸后（如 runc 漏洞）：
ps aux                   # ✅ 可以看到主机上所有进程
cat /etc/shadow          # ✅ 可以直接读主机 shadow 文件
kill -9 1                # ✅ 可以杀主机 init 进程
```

### 启用 user namespace 后

```bash
# 容器内仍然是 root
whoami       # root（容器视角）
id           # uid=0(root)

# 但容器进程在主机上的真实身份：
# 主机上运行 ps aux | grep <container-pid>
# 显示为 uid=65534 (nobody)   ← root 被映射成了非特权用户

# 容器逃逸后：
cat /etc/shadow          # ❌ Permission denied（真实 UID 是 nobody）
kill -9 1                # ❌ Operation not permitted
```

### 威胁缓解

| 攻击场景 | 无 User Namespace | 有 User Namespace |
|----------|:---:|:---:|
| runc 容器逃逸（CVE-2019-5736） | 主机 root | 主机非特权用户 |
| 内核漏洞提权 | 主机 root | 主机非特权用户 + 需再提权一次 |
| 错误挂载的 hostPath | 可写 /etc、/bin 等 | Permission denied |
| `--privileged` 容器 | 几乎全能力 | 能力受限（真实 UID 无 CAP_SYS_ADMIN 等） |

## 核心概念

### UID 映射机制

```yaml
spec:
  hostUsers: false                  # v1.36 GA！启用 user namespace
  containers:
    - name: app
      image: my-app
      securityContext:
        runAsUser: 1000             # 容器内 UID=1000
```

启用 `hostUsers: false` 后，内核自动生成映射：

```
容器内 UID     →   主机 UID
   0 (root)    →   65534 (nobody) 或 kubelet 分配的范围
   1000        →   对应主机的某个非特权 UID
```

### 启用方式

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
spec:
  hostUsers: false                    # ← 核心字段
  containers:
    - name: app
      image: nginx:alpine
      ports:
        - containerPort: 80
      securityContext:
        allowPrivilegeEscalation: false
        runAsNonRoot: false           # 容器内可以是 root（被映射）
        capabilities:
          drop:
            - ALL
```

**前置条件**：
- kubelet 启用了 `UserNamespacesSupport` feature gate（v1.33+ 默认开启）
- 容器运行时支持（containerd ≥ 1.7，CRI-O ≥ 1.26）
- 节点内核支持 user namespace（Linux 3.8+，实际上所有现代内核都支持）

### 与 securityContext 的交互

| securityContext 字段 | User Namespace 开启后 |
|---------------------|----------------------|
| `runAsUser: 0` | 容器内 root → 主机非特权 UID |
| `runAsNonRoot: true` | 与 user namespace 无关，仍生效 |
| `allowPrivilegeEscalation: true` | 冲突！**必须设为 false** |
| `capabilities.add: [NET_ADMIN]` | 仅容器内命名空间有效，无法影响主机网络 |
| `privileged: true` | 同 `allowPrivilegeEscalation`，不兼容 |
| `readOnlyRootFilesystem` | 推荐同时设置（纵深防御） |

## 实战示例

### 示例 1：生产级安全 Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hardened-app
spec:
  hostUsers: false
  containers:
    - name: app
      image: my-app:v3
      securityContext:
        allowPrivilegeEscalation: false
        runAsNonRoot: true
        runAsUser: 1000
        capabilities:
          drop:
            - ALL
        readOnlyRootFilesystem: true
      volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: cache
          mountPath: /var/cache
  volumes:
    - name: tmp
      emptyDir: {}
    - name: cache
      emptyDir: {}
```

### 示例 2：Pod Security Standards Restricted + User Namespace

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: pss-restricted
  labels:
    pod-security.kubernetes.io/enforce: restricted
spec:
  hostUsers: false
  containers:
    - name: app
      image: my-app:v3
      securityContext:
        allowPrivilegeEscalation: false
        runAsNonRoot: true
        capabilities:
          drop:
            - ALL
        seccompProfile:
          type: RuntimeDefault
```

使用 PSA（Pod Security Admission）的 `restricted` 级别，配合 `hostUsers: false`，实现多层防御：
- PSA Restricted → 禁止 privileged、hostNetwork、hostPID 等
- User Namespace → root 映射为非特权
- Seccomp RuntimeDefault → 限制系统调用
- Capabilities drop ALL → 零能力启动

## 实际验证

```bash
# 创建测试 Pod
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: test-userns
spec:
  hostUsers: false
  containers:
    - name: test
      image: busybox
      command: ["sleep", "3600"]
      securityContext:
        allowPrivilegeEscalation: false
EOF

# 在容器内查看 UID
kubectl exec test-userns -- id
# uid=0(root) gid=0(root) groups=0(root)
#   ← 容器内看到自己是 root

# 在主机上查看真实 UID
NODE=$(kubectl get pod test-userns -o jsonpath='{.spec.nodeName}')
PID=$(ssh $NODE "crictl pods --name test-userns -q | xargs crictl inspectp | jq -r '.info.pid'")
ssh $NODE "ps -o uid,pid,cmd -p $PID"
# UID   PID   CMD
# 65534 12345 sleep 3600
#   ← 主机上看到的是 nobody (65534)

# 尝试验证隔离
kubectl exec test-userns -- cat /proc/1/status | head -5
# Name:   systemd
# State:  S (sleeping)
# Tgid:   1
# ...
# 即使看到主机进程，也无法 kill（真实 UID 是 nobody）
kubectl exec test-userns -- kill -9 1
# kill: can't kill pid 1: Operation not permitted
```

## 限制与不兼容场景

| 限制 | 说明 |
|------|------|
| **不兼容 `privileged: true`** | 必须 `allowPrivilegeEscalation: false` |
| **不兼容 hostPath 写入** | hostPath 文件系统 UID 映射可能不匹配 |
| **不兼容 hostNetwork / hostPID / hostIPC** | 这些共享主机命名空间，与 user namespace 隔离矛盾 |
| **部分卷类型受限** | hostPath、local、部分 CSI 驱动需验证 |
| **Windows 不支持** | 仅 Linux |
| **StatefulSet 持久卷** | PVC 的 fsGroup 和 user namespace 交互需注意（chown 行为不同） |
| **不存在于 v1.27 及以下集群** | 需 ≥ v1.33 默认开启，≥ v1.36 GA |

## 常见问题 / 坑点

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| Pod 创建失败 "hostUsers and privileged" | `securityContext.privileged: true` | 改为 `false` 或移除 |
| 文件权限 Permission denied | hostPath / PVC 中文件归主机 root 所有 | 使用 `fsGroup` 或运行 `chown` init container |
| 容器内 `ping` 不可用 | user namespace 中默认无 `CAP_NET_RAW` | 显式 `capabilities.add: [NET_RAW]`（但降低安全） |
| `kubectl cp` 权限错误 | 文件从 Pod 拷贝到主机时 UID 映射 | 使用 emptyDir 临时目录中转 |

## 关联知识

- [[../versions/K8s 1.36 Haru 详解]]（User Namespace GA 版本）
- [[../versions/K8s 1.33 Octarine 详解]]（User Namespace Beta 版本）
- [[Sidecar 容器详解]]
- [[../PSA详解]]

## 参考资源

- KEP-127（User Namespaces）：https://kep.k8s.io/127
- 官方文档：https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/
- man user_namespaces(7)：https://man7.org/linux/man-pages/man7/user_namespaces.7.html

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 初次学习 | 2026-06-29 | 理解 UID 映射机制 |
| 深入理解 | | 在测试集群实际验证隔离效果 |
| 实战应用 | | 生产环境安全基线 + hostUsers: false |

---

**状态**: 📖 已掌握

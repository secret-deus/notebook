---
date: 2026-07-02
tags:
  - container
  - runc
  - oci
  - 镜像
  - containerd
type: 学习笔记
category: 云原生/Kubernetes/容器运行时
source: https://github.com/opencontainers/runtime-spec
difficulty: 高级
title: "OCI Runtime 与镜像内部机制"
---

# OCI Runtime 与镜像内部机制

## 概述

上一层的「容器运行时对比」看了 containerd 和 CRI-O 的外部差异。但这层看的是 CRI 适配层——真正干活的是它下面的 OCI Runtime（runc / crun）和 OCI Image Spec。理解这一层才能解释为什么某个镜像 pull 不下来、为什么 overlayfs 磁盘爆炸、为什么 containerd gc 不干活。

> 一句话：CRI 回答了"什么时候创建 Pod"，OCI Runtime 回答了"怎么创建容器"。两者的关系就像 kube-scheduler 和 kubelet——一个拍板，一个干活。

## OCI Runtime Spec：从 JSON 到容器进程

### 容器 = config.json + rootfs

runc（或 crun、gVisor）只做一件事：读 `config.json` → 创建命名空间 → pivot_root → exec 用户进程。

```
config.json:
  ├── ociVersion
  ├── process              # 进程定义
  │   ├── args             # ["nginx", "-g", "daemon off;"]
  │   ├── env              # ["PATH=/usr/sbin:/usr/bin", ...]
  │   ├── cwd              # "/"
  │   ├── capabilities     # CAP_NET_BIND_SERVICE, ...
  │   └── user             # {uid: 101, gid: 101}
  ├── root                 # 根文件系统路径
  │   └── path: "rootfs"   # bundle/rootfs/
  ├── mounts               # 挂载点
  ├── linux                # Linux 特定配置
  │   ├── namespaces       # [pid, net, ipc, uts, mount] + 可选 [user, cgroup]
  │   ├── cgroupsPath      # /sys/fs/cgroup/kubepods/.../pod-xxx/container-yyy
  │   ├── resources        # CPU shares, memory limit, pids limit
  │   ├── seccomp          # 系统调用白名单
  │   ├── maskedPaths      # /proc/kcore（禁止访问）
  │   └── readonlyPaths    # /proc/sys（只读）
  └── hooks                # prestart / poststart / poststop
```

### runc 的执行流程（源码级）

```c
// 简化的执行路径：
main()
  → startContainer()
    → createContainer()         // 创建容器（不运行）
      → prepareRootfs()          // 准备 rootfs（mount /proc, /sys, /dev 等）
      → setupSeccomp()           // 加载 seccomp profile
      → setupNamespaces()        // unshare() 创建新 namespace
      → setupCgroups()           // 写入 cgroup 限制
      → fork()                   // fork 子进程
        → child: pivot_root()    // 切换根文件系统
        → child: execve()        // 执行用户命令（nginx）
    → startContainer()
      → 向子进程发送 SIGCONT
```

关键区别：`runc create` ≠ `runc start`。kubelet 通过 CRI 先 `RunPodSandbox` → `CreateContainer`（此时容器已创建但未运行）→ `StartContainer`（发送信号启动）。这个两阶段设计让 CNI 插件有机会在容器启动前配置网络。

### crun：更快但非默认

crun 用 C 语言实现 OCI Runtime（runc 是 Go），启动延迟更低：

| 操作 | runc (Go) | crun (C) |
|------|:---:|:---:|
| 创建 + 启动容器 | ~120ms | ~35ms |
| 内存占用（单容器） | ~5MB | ~1MB |
| 功能兼容性 | 参考实现 | 完全兼容 OCI |
| libcgroup 依赖 | ❌ 自己写 cgroup | ✅ 使用 libcgroup（更快更标准） |

CRI-O 默认支持 crun，containerd 也可以切换。

## 镜像内部机制

### OCI Image Spec：Manifest + Config + Layers

一个镜像 = 一个 Manifest + 一个 Config + N 个 Layer：

```
alpine:latest
  ├── Manifest (application/vnd.oci.image.manifest.v1+json)
  │   ├── config:
  │   │   mediaType: "application/vnd.oci.image.config.v1+json"
  │   │   digest: sha256:abc123...         ← 指向 Config
  │   │   size: 702
  │   └── layers:
  │       ├── {mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
  │       │   digest: sha256:def456..., size: 2812345}
  │       └── ...
  ├── Config (application/vnd.oci.image.config.v1+json)
  │   ├── Env: ["PATH=/usr/sbin:/usr/bin"]
  │   ├── Cmd: ["/bin/sh"]
  │   ├── WorkingDir: "/"
  │   └── rootfs.diff_ids: [sha256:def456...]  ← 每层的未压缩 sha256
  └── Layer 1: tar+gzip blob (sha256:def456...)
      Layer 2: tar+gzip blob (sha256:789012...)
      ...
```

### 镜像拉取的全流程

```
crictl pull alpine:latest
  ↓
1. DNS 解析 registry → 建立 HTTPS → auth
  ↓
2. GET /v2/alpine/manifests/latest
   (Accept: application/vnd.oci.image.manifest.v1+json)
  ↓
3. 解析 Manifest → 得到 config digest + layer digests
  ↓
4. GET /v2/alpine/blobs/sha256:abc... (Config)
  ↓
5. for each layer:
     GET /v2/alpine/blobs/sha256:def... (Layer blob)
     ↓
     解压 → overlayfs 写入 → 验证 sha256
  ↓
6. containerd: 记录 image metadata → 标记为可用的 image
```

加速策略：

```toml
# /etc/containerd/config.toml
[plugins."io.containerd.grpc.v1.cri".registry.mirrors]
  # 1. 镜像 mirror（国内云环境必备）
  [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
    endpoint = ["https://mirror.ccs.tencentyun.com", "https://docker.io"]

  # 2. 跳过 TLS 验证（镜像代理常自签证书）
  [plugins."io.containerd.grpc.v1.cri".registry.configs."mirror.internal".tls]
    insecure_skip_verify = false

# 3. 最大并发拉取（默认 3）
[plugins."io.containerd.grpc.v1.cri"]
  max_concurrent_downloads = 10
```

### Layer 的 overlayfs 挂载

每层在 overlayfs 中是一个 lowerdir，最终容器的 rootfs 是：

```
lowerdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/5/fs:\
         /var/lib/containerd/.../snapshots/4/fs:\
         /var/lib/containerd/.../snapshots/3/fs
upperdir=/var/lib/containerd/.../snapshots/6/fs    ← 容器可写层
workdir=/var/lib/containerd/.../snapshots/6/work
merged=/run/containerd/.../rootfs                   ← 最终呈现给容器的根文件系统
```

**overlayfs 的引用计数陷阱**：

```bash
# 场景：一个镜像被 10 个容器使用
# 10 个容器的 lowerdir 都指向同一个 layer 目录
# containerd 通过 refcount 管理：使用中的 layer 不能被 gc

# 查看 snapshot 引用关系
ctr -n k8s.io snapshot ls
# KEY      PARENT   KIND
# sha256:a base     Committed
# snap-1   sha256:a Active     ← 某容器正在使用
# snap-2   sha256:a Active     ← 另一个容器也在用同一个 base
```

## Snapshotter 对比：不只是"文件系统"选择

containerd 的 snapshotter 实现了镜像 layer 到容器 rootfs 的映射。不同 snapshotter 的选择直接影响磁盘使用、启动速度和故障恢复。

| Snapshotter | 原理 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|------|
| **overlayfs** | 多层联合挂载 | 快、省空间（layer 共享） | 不能跨文件系统 | **默认，95% 场景** |
| **devmapper** | 精简置备的块设备 + 快照 | 支持配额限制（每个容器固定大小） | 需要独立磁盘分区、预分配慢 | 需要严格按容器限磁盘的场景 |
| **btrfs** | 子卷 + CoW 快照 | 原生快照、子卷配额 | 内核 bug 多、社区小 | 实验性 |
| **native** | 复制整个目录 | 简单、无依赖 | 慢、占空间 | 不支持 overlayfs 的环境（如 tmpfs） |
| **stargz** | 拉取时懒加载（eStargz） | **镜像不 pull 完就能启动** | 运行时读取延迟、兼容性 | 超大镜像（GPU 训练镜像 10GB+） |

### overlayfs 磁盘分析

```bash
# 查看 containerd snapshot 磁盘使用
du -sh /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/

# 查看每个 snapshot 的大小
for snap in /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/*; do
  echo "$(basename $snap): $(du -sh $snap/fs 2>/dev/null | cut -f1)"
done | sort -t: -k2 -hr | head -20

# 大的 snapshot 通常来自日志或临时文件
# 容器内写入了大量数据但没有及时清理
```

### stargz：超大镜像的解决方案

GPU 训练镜像（CUDA + PyTorch + 训练代码）动辄 15-20GB。传统 `crictl pull` 需要完全下载 + 解压才能启动容器，`stargz`（eStargz / lazy pulling）允许**边拉取边启动**：

```bash
# 转换镜像为 eStargz 格式
nerdctl pull alpine:latest
nerdctl push --estargz alpine:latest registry.example.com/alpine:estargz

# containerd 配置 stargz snapshotter
# 容器启动时间：15GB 镜像从 3 分钟降到 15 秒
```

## containerd Content Store 与 GC

### Content Store 三张表

containerd 内部用 Content Store 管理所有 blob：

```
Content Store (metadata DB):
  ┌────────────┐     ┌─────────────┐     ┌──────────┐
  │ blobs       │ ←── │ images       │ ←── │ containers│
  │ (原始数据)   │     │ (镜像元数据)  │     │ (容器引用) │
  └────────────┘     └─────────────┘     └──────────┘
                                ↑
                         GC 从 images 出发
                         标记可达的 blob
                         其余 → 删除
```

### GC 触发条件

containerd 的 GC 不是后台定时任务，而是**事件驱动**：

| 触发事件 | 动作 |
|------|------|
| 删除 image（`crictl rmi`） | 立即检查该 image 的 blob 是否还有其他 image 引用 |
| 删除容器（container stop + remove） | 减少 snapshot refcount |
| 手动触发 | `ctr -n k8s.io content gc` |
| kubelet 镜像 GC | 磁盘使用 > `--image-gc-high-threshold` → 删除最久未使用的 image |

```bash
# kubelet 镜像 GC 配置
# /var/lib/kubelet/config.yaml
imageGCHighThresholdPercent: 85   # 磁盘使用 > 85% 触发
imageGCLowThresholdPercent: 80    # 回收到 80%
imageMinimumGCAge: 2m             # 镜像至少存在 2 分钟才能被回收

# containerd GC 配置
# /etc/containerd/config.toml
[plugins."io.containerd.grpc.v1.cri"]
  discard_unpacked_layers = true   # pull 后释放解压的 layer（节省空间）
```

### 磁盘满了的紧急处理

```bash
# 1. 查明是谁在吃磁盘
du -sh /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/
du -sh /var/lib/containerd/io.containerd.content.v1.content/

# 2. 列出所有镜像（按大小）
crictl images | sort -k4 -hr | head -20

# 3. 安全清理
crictl rmi --prune                              # 清理未使用镜像
ctr -n k8s.io content gc                        # 触发 containerd GC

# 4. 如果 snapshot 泄漏（删除容器后 snapshot 未释放）
ctr -n k8s.io snapshot ls | grep -v "Active\|Committed" | awk '{print $1}' | xargs -I {} ctr -n k8s.io snapshot rm {}

# 5. 终极手段：重启 containerd（会强制清理）
systemctl restart containerd
```

## cgroup v2 运行时集成细节

### 从 Pod Spec → cgroup path 的完整映射

```yaml
# Pod spec
apiVersion: v1
kind: Pod
metadata:
  uid: abc-123
spec:
  containers:
    - name: app
      resources:
        requests: {cpu: "2", memory: "4Gi"}
        limits:   {cpu: "4", memory: "8Gi"}
```

映射到 cgroup v2：

```
/sys/fs/cgroup/kubepods.slice/
  └── kubepods-burstable.slice/              ← QoS: Burstable
      └── kubepods-burstable-podabc_123.slice/  ← Pod cgroup
          ├── cpu.weight: 205                  ← requests.cpu 的映射
          ├── cpu.max: 400000 100000            ← limits.cpu = 4 cores
          ├── memory.max: 8589934592            ← limits.memory = 8GiB
          ├── memory.high: 4294967296           ← requests.memory = 4GiB
          └── cgroup.procs                      ← pause + app 进程
```

QoS 对应的 cgroup 路径：

| QoS Class | cgroup path |
|------|------|
| Guaranteed | `kubepods.slice/kubepods-pod<uid>.slice/` |
| Burstable | `kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<uid>.slice/` |
| BestEffort | `kubepods.slice/kubepods-besteffort.slice/kubepods-besteffort-pod<uid>.slice/` |

### CPU Manager + cpuset 集成

当 CPU Manager static policy 分配独占 CPU 时，containerd 需要：

1. kubelet → CRI → `UpdateContainerResources(linux.cpuset_cpus="4-7")`
2. containerd → runc → 写入 `cpuset.cpus` 到容器的 cgroup
3. 容器进程只能用 CPU 4-7

如果 containerd 的 `SystemdCgroup` 设为 false，这些 cgroup 操作会走 `cgroupfs` driver，可能与 systemd 的 cgroup 树冲突。这就是为什么 K8s v1.31+ 强制 `SystemdCgroup=true`。

## 关联知识

- [[容器运行时深度对比]] — 本文是其内部机制补充
- [[../linux/cgroup v2 详解]] — cgroup v2 的 CPU/memory 映射在容器运行时中的实现
- [[../linux/CPU 隔离与中断亲和性]] — CPU Manager 依赖 runc 写 cpuset
- [[../linux/大页内存与透明大页详解]] — HugePages 通过 containerd 的 hugetlb cgroup 控制器暴露

## 参考资源

- OCI Runtime Spec：https://github.com/opencontainers/runtime-spec
- OCI Image Spec：https://github.com/opencontainers/image-spec
- containerd 架构：https://github.com/containerd/containerd/blob/main/PLUGINS.md
- eStargz：https://github.com/containerd/stargz-snapshotter

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| OCI 深入 | 2026-07-02 | OCI Runtime Spec、runc 执行流程、镜像 Manifest/Layer、Snapshotter、Content Store GC、cgroup v2 映射 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-09

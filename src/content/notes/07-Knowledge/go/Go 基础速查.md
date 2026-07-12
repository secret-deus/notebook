---
date: 2026-07-01
tags:
  - go
  - 编程语言
  - kubernetes
  - 运维开发
type: 学习笔记
category: 编程语言/Go
source: https://go.dev/doc/
difficulty: 入门
title: "Go 基础速查"
---

# Go 基础速查

## 概述

Go 是 Kubernetes 及其生态圈（etcd、containerd、Helm、ArgoCD、kagent-controller）的通用语言。作为 DevOps/SRE，不需要成为 Go 专家，但**需要能读懂 K8s 源码、理解 Controller 模式、排查 Operator 问题**。本文聚焦于此视角。

> 一句话：Go 是为「等待 I/O 的并发」设计的语言。goroutine 不是因为要并行才用，是因为要在等一个东西时不阻塞另外一千个东西。

## 模块与项目结构

### go.mod —— 项目的身份证

```go
module github.com/myorg/myoperator

go 1.23

require (
    k8s.io/client-go v0.31.0
    sigs.k8s.io/controller-runtime v0.19.0
)
```

- `module`：包路径 = import path = 同时也是 `go install` 的路径
- `go 1.23`：声明最低 Go 版本
- `require`：直接依赖
- `indirect`：间接依赖（自动生成，不手写）

关键命令：

```bash
go mod init github.com/xxx/yyy   # 初始化
go mod tidy                       # 清理未用依赖 + 下载缺失的
go mod download                   # 只下载，不修改 go.mod
go get k8s.io/client-go@v0.31.0  # 添加/更新依赖
```

### 项目布局（K8s Controller / Operator 典型结构）

```
myoperator/
├── go.mod
├── go.sum                         # 依赖校验和
├── main.go                        # 入口：初始化 + 启动 controller
├── api/
│   └── v1alpha1/
│       ├── types.go               # CRD 结构体定义
│       ├── register.go            # Scheme 注册
│       └── zz_generated.deepcopy.go  # 自动生成的 DeepCopy
├── internal/
│   └── controller/
│       └── reconciler.go          # Reconcile 逻辑（核心）
└── config/
    ├── crd/                       # 生成的 CRD YAML
    └── rbac/                      # 生成的 RBAC
```

## 关键语法（K8s 场景视角）

### struct + json tag —— K8s 资源的本体

Go 没有 class，用 struct 定义数据结构。`json:"fieldName"` tag 控制序列化/反序列化。

```go
type PodSpec struct {
    Containers    []Container  `json:"containers"`           // 切片（动态数组）
    RestartPolicy RestartPolicy `json:"restartPolicy,omitempty"` // omitempty: 空值时忽略
}

type Container struct {
    Name  string              `json:"name"`                 // 字符串
    Image string              `json:"image"`
    Ports []ContainerPort     `json:"ports,omitempty"`
    Env   []EnvVar            `json:"env,omitempty"`
}
```

**K8s 源码中必见模式**：`+kubebuilder:` annotation 在 Go 注释中声明 CRD 验证：

```go
// +kubebuilder:validation:Required
// +kubebuilder:validation:MaxLength=63
Name string `json:"name"`
```

### interface —— K8s 的"鸭子类型"

Go 的 interface 是隐式实现的——不需要 `implements` 关键字。只要 struct 实现了 interface 要求的所有方法，它就自动满足该 interface。

```go
// runtime.Object 是 K8s 中最核心的 interface
// 任何可以被序列化/反序列化的 K8s 资源都实现它
type Object interface {
    GetObjectKind() schema.ObjectKind
    DeepCopyObject() Object
}

// Pod 自动实现 Object（因为它有上面两个方法）
// 不需要声明 "Pod implements Object"
```

**读懂 K8s 源码的关键 interface**：

| interface | 作用 |
|------|------|
| `runtime.Object` | 所有 K8s 资源的根基，能深拷贝 + 获取 GVK |
| `client.Client` | controller-runtime 的客户端，Get/List/Create/Update/Delete |
| `reconcile.Reconciler` | Controller 的核心：`Reconcile(ctx, req) (Result, error)` |
| `http.RoundTripper` | HTTP 传输层，可以做注入、限流、metrics |

### defer —— 资源清理

`defer` 确保函数退出前必定执行，常用于关闭文件、释放锁、恢复 panic。

```go
func readConfig(path string) ([]byte, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()  // 函数返回前必定执行，无论正常返回还是 panic

    data, err := io.ReadAll(f)
    if err != nil {
        return nil, err  // f.Close() 仍会执行
    }
    return data, nil
}
```

K8s 中常见的 defer 模式：
- `defer lock.Unlock()` —— 释放锁
- `defer cancel()` —— 取消 context
- `defer queue.Done(key)` —— workqueue 完成处理

### error handling —— if err != nil

Go 没有 try/catch。函数返回 `(result, error)`，"快乐路径"在 if 后面：

```go
pod, err := clientset.CoreV1().Pods("default").Get(ctx, "my-pod", metav1.GetOptions{})
if err != nil {
    return fmt.Errorf("failed to get pod: %w", err)  // %w 包装错误链
}
// 快乐路径：正常处理 pod
```

**K8s 错误模式**：

```go
// 1. 可重试错误 → 返回 error，controller-runtime 自动重试
return ctrl.Result{}, err

// 2. 不需重试（如资源不存在）→ 不返回 error
if apierrors.IsNotFound(err) {
    return ctrl.Result{}, nil
}

// 3. 延迟重试
return ctrl.Result{RequeueAfter: 30 * time.Second}, nil

// 4. 等待资源就绪
return ctrl.Result{Requeue: true}, nil
```

### goroutine + channel —— 并发但不乱

goroutine 是轻量级协程（2KB 初始栈），channel 是 goroutine 间的通信管道。

```go
// 启动 3 个 goroutine 并发处理
var wg sync.WaitGroup
results := make(chan Result, 3)

for i := 0; i < 3; i++ {
    wg.Add(1)
    go func(id int) {
        defer wg.Done()
        result, err := process(id)
        results <- Result{ID: id, Data: result, Err: err}
    }(i)
}

go func() {
    wg.Wait()
    close(results)
}()

for r := range results {
    if r.Err != nil {
        log.Error(r.Err, "processing failed")
    }
}
```

**K8s 中的 goroutine 模式**：
- Controller 的 Reconcile 循环在独立 goroutine 中运行
- Informer 的事件处理在 goroutine pool 中执行
- `client-go` 的 `workqueue` 本身就是 channel 的高级封装

### context.Context —— 超时和取消

K8s 中每个 API 调用、每次 Reconcile 都带有 context：

```go
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    // ctx 携带超时、取消信号、请求追踪信息

    // 创建带超时的子 context
    childCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    var pod corev1.Pod
    if err := r.Get(childCtx, req.NamespacedName, &pod); err != nil {
        return ctrl.Result{}, err
    }
}
```

### K8s 的 controller-runtime 最小骨架

理解这段代码就能读懂 80% 的 K8s Operator：

```go
func main() {
    // 1. 创建 Manager（管理所有 Controller + Webhook）
    mgr, _ := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,    // 注册你的 CRD 类型
    })

    // 2. 创建 Reconciler 并注册
    r := &MyReconciler{Client: mgr.GetClient()}
    ctrl.NewControllerManagedBy(mgr).
        For(&myv1.MyResource{}).   // 监听的资源
        Owns(&appsv1.Deployment{}). // 子资源（自动跟踪）
        Complete(r)

    // 3. 启动
    mgr.Start(ctrl.SetupSignalHandler())
}

// Reconciler —— 每个 Operator 的核心
type MyReconciler struct {
    client.Client
}

func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    // 1. 获取目标资源
    var obj myv1.MyResource
    if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // 2. 构建期望状态（往往是生成 Deployment/Service 的 spec）
    desired := buildDeployment(&obj)

    // 3. 对比实际状态
    var existing appsv1.Deployment
    err := r.Get(ctx, types.NamespacedName{Name: obj.Name, Namespace: obj.Namespace}, &existing)
    if apierrors.IsNotFound(err) {
        return ctrl.Result{}, r.Create(ctx, desired)   // 不存在 → 创建
    }

    // 4. 更新（如果需要）
    if !reflect.DeepEqual(desired.Spec, existing.Spec) {
        existing.Spec = desired.Spec
        return ctrl.Result{}, r.Update(ctx, &existing)
    }

    return ctrl.Result{}, nil
}
```

## 常用工具链

```bash
# 编译
go build -o bin/myapp ./cmd/myapp
GOOS=linux GOARCH=amd64 go build ./...        # 跨平台编译

# 测试
go test ./...                                  # 全部测试
go test -v -run TestReconcile ./internal/...   # 运行指定测试

# 代码质量
go vet ./...                                   # 静态分析
golangci-lint run                              # 综合 linter
go fmt ./...                                   # 格式化

# 依赖
go mod tidy                                    # 整理依赖
go mod why -m k8s.io/client-go                 # 为什么引入这个依赖

# 代码生成（K8s 项目必用）
# DeepCopy: controller-gen object paths=./api/...
# CRD YAML: controller-gen crd paths=./api/... output:dir=./config/crd
```

## K8s 源码阅读路径

从易到难：

```
1. client-go/examples/out-of-cluster-client-configuration/
   → 理解 Kubernetes client 的最简用法

2. controller-runtime 的 pkg/reconcile/reconcile.go
   → Reconciler interface（只有 17 行）

3. controller-runtime 的 pkg/builder/controller.go
   → Controller 如何注册：For()、Owns()、Watches()

4. controller-runtime 的 pkg/internal/controller/controller.go
   → Controller 内部：workqueue、reconcile loop

5. k8s.io/kubernetes 的 pkg/controller/deployment/
   → K8s 内置 Deployment Controller（最经典的控制器实现）

6. k8s.io/kubernetes 的 staging/src/k8s.io/apiserver/
   → API Server 内部实现
```

## 关联知识

- [[../k8s/特性详解/ArgoCD GitOps 实战]] — ArgoCD 核心组件（repo-server、application-controller）均用 Go 编写
- [[../k8s/特性详解/etcd 运维详解]] — etcd 源码完全用 Go 编写
- [[../k8s/特性详解/kagent 详解]] — kagent-controller 是典型 Go CRD Controller
- [[../k8s/特性详解/CEL 准入控制详解]] — 准入 Webhook 通常用 Go 编写

## 参考资源

- Go Tour：https://go.dev/tour/
- Effective Go：https://go.dev/doc/effective_go
- client-go 示例：https://github.com/kubernetes/client-go/tree/master/examples
- controller-runtime：https://github.com/kubernetes-sigs/controller-runtime
- kubebuilder book：https://book.kubebuilder.io/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 基础速查 | 2026-07-01 | 完成：模块结构、关键语法、K8s controller 骨架、源码阅读路径 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-08

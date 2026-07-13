---
date: 2026-07-02
tags:
  - terraform
  - iac
  - devops
  - 基础设施
type: 学习笔记
category: 基础设施/Terraform
source: https://developer.hashicorp.com/terraform
difficulty: 进阶
title: "Terraform 基础设施即代码"
---

# Terraform 基础设施即代码

## 概述

Terraform 是 HashiCorp 开发的开源 IaC（Infrastructure as Code）工具，通过声明式 HCL 配置管理云资源（计算、网络、存储、K8s 集群）的生命周期。它是 K8s 集群"下层基础设施"的标准管理方式。

> 一句话：ArgoCD 管 K8s 集群**内部**的资源（Pod/Deployment/Service），Terraform 管 K8s 集群**本身**以及它依赖的 VPC/子网/安全组/节点池。

## 核心概念

### 工作流

```
Write (编写)  →  Plan (计划)  →  Apply (应用)
  HCL 配置       terraform plan    terraform apply
                  ↓                  ↓
              预览变更（不操作）    执行变更 + 更新 State
```

### HCL 基础语法

```hcl
# variables.tf —— 变量定义
variable "cluster_name" {
  type        = string
  description = "K8s cluster name"
  default     = "prod-cluster"
}

variable "node_pools" {
  type = map(object({
    machine_type = string
    node_count   = number
    disk_size_gb = number
  }))
  default = {
    general = { machine_type = "n1-standard-4", node_count = 3, disk_size_gb = 100 }
    gpu     = { machine_type = "a2-highgpu-1g", node_count = 2, disk_size_gb = 200 }
  }
}

# output.tf —— 输出值
output "kubeconfig" {
  value     = module.gke.kubeconfig
  sensitive = true
}

output "cluster_endpoint" {
  value = module.gke.endpoint
}
```

### State —— Terraform 的核心

Terraform State 文件记录了"Terraform 管理了哪些资源，它们当前的状态是什么"。不直接调云 API 查询，而是读 State——快且免费。

| State 存储方式 | 适用场景 | 锁机制 |
|:---|------|:---:|
| **本地** `terraform.tfstate` | 个人开发、学习 | ❌ 无锁 |
| **S3 + DynamoDB** | AWS 生产环境 | ✅ DynamoDB 锁 |
| **GCS** | GCP 生产环境 | ✅ 内置锁 |
| **Terraform Cloud** | 企业级，GUI + VCS 集成 | ✅ 内置 |
| **Azure Storage** | Azure 生产环境 | ✅ 租赁锁 |
| **GitLab Managed State** | GitLab CI 用户 | ✅ 内置 |

```hcl
# backend.tf —— S3 远程 State 示例
terraform {
  backend "s3" {
    bucket         = "my-terraform-state"
    key            = "prod/kubernetes/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"  # 防止并发 apply
  }
}
```

### Module —— 可复用的基础设施

```hcl
# 定义一个可复用的 K8s 集群 Module
module "gke" {
  source  = "terraform-google-modules/kubernetes-engine/google"
  version = "~> 30.0"

  project_id        = var.project_id
  name              = var.cluster_name
  region            = "asia-southeast1"
  network           = module.vpc.network_name
  subnetwork        = module.vpc.subnets_names[0]
  ip_range_pods     = "pods"
  ip_range_services = "services"

  node_pools = [
    for name, config in var.node_pools : {
      name               = name
      machine_type       = config.machine_type
      node_count         = config.node_count
      disk_size_gb       = config.disk_size_gb
      initial_node_count = 1
    }
  ]
}
```

## K8s 集群创建实战

### 完整项目结构

```
terraform/
├── backend.tf              # State 配置
├── provider.tf             # Provider 配置
├── variables.tf            # 输入变量
├── outputs.tf              # 输出
├── vpc.tf                  # 网络层
├── gke.tf                  # K8s 集群
├── iam.tf                  # 权限
└── terraform.tfvars        # 环境特定变量值
```

### 典型配置

```hcl
# provider.tf
terraform {
  required_version = ">= 1.8"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.30"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.30"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.14"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
```

```hcl
# vpc.tf —— 网络层
resource "google_compute_network" "main" {
  name                    = "${var.cluster_name}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.cluster_name}-subnet"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = "10.0.0.0/16"

  private_ip_google_access = true   # GCR/Artifact Registry 出公网

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.1.0.0/16"   # Pod CIDR
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.2.0.0/20"   # Service CIDR
  }
}
```

```hcl
# gke.tf —— GPU 节点池
resource "google_container_node_pool" "gpu" {
  name     = "gpu-pool"
  cluster  = google_container_cluster.main.id
  location = var.region

  node_config {
    machine_type = "a2-highgpu-1g"          # A100 40GB × 1
    disk_size_gb = 200
    disk_type    = "pd-ssd"

    # GPU 驱动自动安装
    guest_accelerator {
      type  = "nvidia-tesla-a100"
      count = 1
    }

    # Taint：只允许带 GPU toleration 的 Pod 调度
    taint {
      key    = "nvidia.com/gpu"
      value  = "present"
      effect = "NO_SCHEDULE"
    }

    labels = {
      "node-pool" = "gpu"
      "gpu-type"  = "a100"
    }

    # 启动时运行 GPU 驱动安装
    metadata = {
      "install-nvidia-driver" = "true"
    }
  }

  autoscaling {
    min_node_count = 0
    max_node_count = 8
  }

  management {
    auto_repair  = true
    auto_upgrade = false   # GPU 节点：手动升级，避免训练中断
  }
}
```

## Terraform + ArgoCD 组合模式

### Bootstrapping 流程

```
Step 1: Terraform 创建集群 + 安装 ArgoCD
  → terraform apply（创建 VPC → GKE → Helm Release: ArgoCD）

Step 2: Terraform 创建 "Bootstrap Application"
  → kubectl_manifest（在 ArgoCD 中创建 Application CRD，指向 GitOps 仓库）

Step 3: ArgoCD 接管
  → Bootstrap App sync → 部署所有业务应用
```

```hcl
# argo.tf —— 在 Terraform 中安装 ArgoCD
resource "helm_release" "argocd" {
  name       = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  version    = "7.3.0"
  namespace  = "argocd"
  create_namespace = true

  set {
    name  = "server.service.type"
    value = "LoadBalancer"
  }

  depends_on = [google_container_cluster.main]
}

# 创建 Bootstrap Application（让 ArgoCD 安装其余所有）
resource "kubectl_manifest" "bootstrap" {
  yaml_body = yamlencode({
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "Application"
    metadata = {
      name      = "bootstrap"
      namespace = "argocd"
    }
    spec = {
      project = "default"
      source = {
        repoURL        = "https://github.com/org/gitops.git"
        path           = "apps"
        targetRevision = "main"
      }
      destination = {
        server    = "https://kubernetes.default.svc"
        namespace = "argocd"
      }
      syncPolicy = {
        automated = {
          prune    = true
          selfHeal = true
        }
      }
    }
  })

  depends_on = [helm_release.argocd]
}
```

### K8s Provider 管理集群内资源

```hcl
# 用 Terraform 管理部分基础 K8s 资源（如 Namespace、RBAC、SecretStore）
provider "kubernetes" {
  host                   = google_container_cluster.main.endpoint
  cluster_ca_certificate = base64decode(google_container_cluster.main.master_auth[0].cluster_ca_certificate)
  token                  = data.google_client_config.default.access_token
}

resource "kubernetes_namespace" "apps" {
  for_each = toset(["health", "bigdata", "ingress", "monitoring"])
  metadata {
    name = each.key
    labels = {
      "managed-by" = "terraform"
    }
  }
}
```

## Terraform Workspace —— 多环境

```bash
# 创建 workspace
terraform workspace new prod
terraform workspace new staging

# 切换 workspace（不同 workspace 使用不同 State）
terraform workspace select prod

# 配合 tfvars 区分环境
terraform plan -var-file="env/prod.tfvars"
terraform apply -var-file="env/prod.tfvars"
```

```hcl
# env/prod.tfvars
cluster_name = "prod-gke"
region       = "asia-southeast1"
node_pools = {
  general = { machine_type = "n1-standard-8",  node_count = 5, disk_size_gb = 200 }
  gpu     = { machine_type = "a2-highgpu-1g",  node_count = 4, disk_size_gb = 500 }
}
```

## 日常运维命令

```bash
# 初始化（首次或修改 backend/provider 后）
terraform init

# 格式化代码
terraform fmt -recursive

# 验证语法
terraform validate

# 预览变更
terraform plan -out=tfplan

# 应用（仅执行预览过的计划）
terraform apply tfplan

# 销毁所有资源（危险操作！）
terraform destroy

# 显示某个资源的状态
terraform state show google_container_cluster.main

# 列出所有管理的资源
terraform state list

# 把已存在的资源导入 Terraform（不用重建）
terraform import google_compute_network.main projects/my-project/global/networks/my-vpc

# 把资源从 State 移除（不删除实际资源）
terraform state rm google_container_cluster.main

# 解锁被锁的 State（force-unlock 只能在确定无人执行时使用）
terraform force-unlock <lock-id>
```

## 常见问题与最佳实践

| 问题 | 根因 | 最佳实践 |
|------|------|------|
| 团队并发 apply 导致 State 损坏 | 多人同时用本地 State | **使用远程 State + 锁** |
| 生产环境误 `destroy` | 权限过大、无确认机制 | `terraform apply` 前强制 `plan` review + CI 审批 |
| Secret 泄漏到 State | `sensitive` 未标记 | 所有凭证类输出标记 `sensitive = true` |
| `terraform plan` 慢（> 5 分钟） | 大型 GKE 集群 refresh 慢 | `-refresh=false` 跳过 refresh，或拆分 State |
| K8s Provider 资源从 State 消失 | ArgoCD selfHeal 覆盖了 Terraform 变更 | 明确分界：集群本身 → Terraform，集群内 → ArgoCD |
| Module 版本管理混乱 | 未锁定版本 | `version = "~> X.Y"` 锁定大版本 |

## 关联知识

- [[Terraform 生产级实践]] — 本文的生产级补充（State 恢复、Atlantis、Terragrunt、Import SOP）
- [[../k8s/特性详解/ArgoCD GitOps 实战]] — Terraform 创建集群，ArgoCD 部署应用
- [[../k8s/特性详解/CNI 网络插件对比与排障]] — Terraform 创建 VPC，CNI 在 VPC 上运行
- [[../k8s/特性详解/etcd 运维详解]] — GKE 的 etcd 由云厂商管理，裸金属集群由 Terraform 创建
- [[../k8s/特性详解/K8s 可观测性栈]] — Terraform 可部署 Grafana Agent 做基础设施级监控

## 参考资源

- Terraform 官方文档：https://developer.hashicorp.com/terraform/docs
- Terraform Registry：https://registry.terraform.io/
- GKE Terraform Module：https://registry.terraform.io/modules/terraform-google-modules/kubernetes-engine/google
- Terraform + GitOps 最佳实践：https://developer.hashicorp.com/terraform/tutorials/kubernetes/kubernetes-gitops

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| IaC 基础 | 2026-07-02 | 完成：HCL 语法、State 管理、Module、GKE 创建、Terraform+ArgoCD 组合 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-09

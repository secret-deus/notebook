---
date: 2026-07-02
tags:
  - terraform
  - iac
  - state
  - cicd
  - 高级
type: 学习笔记
category: 基础设施/Terraform
source: https://developer.hashicorp.com/terraform
difficulty: 高级
title: "Terraform 生产级实践"
---

# Terraform 生产级实践

## 概述

单机 `terraform apply` 能做的事，在团队协作 + CI/CD 流水线里会变得危险得多。State 锁冲突、多人 apply 覆盖、误 destroy 生产环境——这些事故不是 Terraform 的 bug，是 State 管理和协作流程的 bug。本文聚焦生产环境中真正棘手的问题。

> 一句话：Terraform 入门是学会 `plan` 和 `apply`，入门之后的全部精力都在管 State。

## State 管理深潜

### State 锁：DynamoDB / GCS 的锁机制

多人同时 `terraform apply` 会损坏 State 文件。Terraform 通过后端锁防止并发写：

```hcl
# S3 + DynamoDB 锁（AWS 标配）
terraform {
  backend "s3" {
    bucket         = "my-tfstate"
    key            = "prod/vpc/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}
```

锁的完整生命周期：

```
terraform plan/apply
  → 客户端向 DynamoDB 写 LockID=state-path（带 ConditionExpression 防覆盖）
  → 获取锁 → 执行操作
  → 释放锁（删除 DynamoDB item）
  
锁过期机制（防止客户端崩溃后死锁）:
  - DynamoDB: TTL 自动删除过期锁
  - GCS: 锁文件自带超时，GCS 定时清理
  - HTTP（Terraform Cloud）: 服务端管理
```

### State 文件损坏的 4 种场景与恢复

**场景 1：apply 中途网络断开**

State 处于不完整状态：部分资源已创建但 State 未记录，或 State 记录了但创建失败。

```bash
# 症状
terraform plan
# Error: Resource 'xxx' exists but is not in state

# 恢复
terraform import aws_instance.broken i-1234567890abcdef
# 手动把该资源"认领"回 State
```

**场景 2：两人同时 apply（锁未正确配置）**

State 回滚到上一个版本（S3 versioning 必备）：

```bash
# 前提：S3 bucket 已开启 versioning
# 查找最近的完好版本
aws s3api list-object-versions \
  --bucket my-tfstate \
  --prefix prod/vpc/terraform.tfstate \
  --query 'Versions[?IsLatest==`false`]|[0].VersionId'

# 恢复
aws s3api get-object \
  --bucket my-tfstate \
  --key prod/vpc/terraform.tfstate \
  --version-id "abc123" \
  terraform.tfstate.restored
```

**场景 3：手动删除了 State 文件**

```bash
# 没有备份 → 只能逐个 import
# 先列出当前所有资源
terraform state list  # 空（State 已丢失）

# 在云控制台逐个找到资源 ID，import 回来
# 写一个脚本批量处理
for resource in $(cat resource-list.txt); do
  terraform import "$resource" "$(get_resource_id "$resource")"
done
```

> ⚠️ 这是最痛苦的恢复方式，预防措施：S3 versioning + 定期备份 State 到另一个 bucket。

**场景 4：State 中有"幽灵资源"（Terraform 不再管理但资源还在）**

```bash
# 把资源从 State 中移除但不删除
terraform state rm aws_instance.old-server

# 之后 terraform destroy 不会删它
# 手动管理或在另一个 State 中 import
```

### State 拆分策略

单体 State 的风险：改一个 DNS 记录可能因为 State 太大而 `plan` 需要 10 分钟。大型基础设施必须拆分：

```
单体 State (bad):
  prod/terraform.tfstate  ← 2000+ resources

拆分 State (good):
  prod/vpc/terraform.tfstate          ← VPC、子网、路由
  prod/eks/terraform.tfstate          ← EKS 集群
  prod/eks-node-pools/terraform.tfstate ← 节点池
  prod/rds/terraform.tfstate          ← 数据库
  prod/dns/terraform.tfstate          ← Route53 / DNS
```

拆分原则：
- **"改啥只影响啥"**：经常改动的（节点池、Ingress）和基本不改的（VPC、子网）分开
- **"炸了不连坐"**：一组资源的故障不影响其他组的 `apply`
- **State 之间通过 `data` source 引用**，不用 `terraform_remote_state`（耦合太强）

```hcl
# vpc/ 输出
output "vpc_id" { value = aws_vpc.main.id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }

# eks/ 引用
data "terraform_remote_state" "vpc" {
  backend = "s3"
  config = {
    bucket = "my-tfstate"
    key    = "prod/vpc/terraform.tfstate"
    region = "ap-southeast-1"
  }
}
# 弱耦合替代：把 output 写成 SSM Parameter 或 ConfigMap
# data "aws_ssm_parameter" "vpc_id" { name = "/prod/vpc/id" }
```

## CI/CD 集成方案

### Atlantis —— GitOps for Terraform

Atlantis 是一个专门为 Terraform 设计的 GitOps 工具。它监听 GitHub/GitLab PR，自动 `plan`，PR 评论中展示结果，评论 `atlantis apply` 触发执行。

```
工作流:
  Developer → Push PR (改 HCL)
  GitHub → Webhook → Atlantis
  Atlantis → terraform plan → 评论到 PR
  Reviewer → 检查 plan 输出 → 评论 "atlantis apply"
  Atlantis → terraform apply → 合并 PR
```

```hcl
# atlantis.yaml（仓库根目录）
version: 3
projects:
  - name: vpc
    dir: prod/vpc
    workspace: prod
    autoplan:
      when_modified: ["*.tf", "*.tfvars"]
      enabled: true

  - name: eks
    dir: prod/eks
    workspace: prod
    autoplan:
      when_modified: ["*.tf"]
      enabled: true

  - name: node-pools
    dir: prod/eks-node-pools
    workspace: prod
    autoplan:
      enabled: true
    # 这个需要生产审批
    apply_requirements: ["approved", "mergeable"]
```

Atlantis 的服务器配置：

```bash
# docker-compose.yml
services:
  atlantis:
    image: ghcr.io/runatlantis/atlantis:latest
    environment:
      ATLANTIS_REPO_ALLOWLIST: github.com/org/*
      ATLANTIS_GH_USER: atlantis-bot
      ATLANTIS_GH_TOKEN: ${GH_TOKEN}
      ATLANTIS_ATLANTIS_URL: https://atlantis.example.com
      # State backend 凭证（从环境变量注入）
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
    volumes:
      - /data/atlantis:/data
```

### GitHub Actions 流水线

```yaml
name: Terraform CI

on:
  pull_request:
    paths:
      - 'prod/**/*.tf'
      - 'prod/**/*.tfvars'

jobs:
  terraform:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.8.0"

      - name: Terraform fmt
        run: terraform fmt -check -recursive
        continue-on-error: true

      - name: Terraform init
        working-directory: prod/vpc
        run: terraform init
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}

      - name: Terraform plan
        id: plan
        working-directory: prod/vpc
        run: |
          terraform plan -no-color -out=tfplan \
            2>&1 | tee plan-output.txt

      - name: Comment plan output
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const output = fs.readFileSync('prod/vpc/plan-output.txt', 'utf8');
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## Terraform Plan\n\n\`\`\`hcl\n${output}\n\`\`\``
            });

  apply:
    needs: terraform
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production            # GitHub Environment 审批门
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - name: Terraform apply
        working-directory: prod/vpc
        run: terraform apply -auto-approve tfplan
```

## Terragrunt —— 消除 Terraform 的重复

Terragrunt 是 Terraform 的包装器，解决原生 Terraform 最大的痛点：**后端配置重复**和**多环境 Module 调用重复**。

### 痛点：原生 Terraform 的重复地狱

每个环境的文件夹都要复制一遍 `provider.tf` 和 `backend.tf`：

```
prod/vpc/terraform.tf    ← 复制粘贴
staging/vpc/terraform.tf ← 复制粘贴
dev/vpc/terraform.tf     ← 复制粘贴
```

Terragrunt 解决：在根目录写一份，自动生成。

### 目录结构

```
infrastructure-live/
├── terragrunt.hcl                           # 根配置（全局）
├── prod/
│   ├── env.hcl                              # 环境变量（region、account_id）
│   └── vpc/
│       └── terragrunt.hcl                   # 只写 source + inputs
└── staging/
    ├── env.hcl
    └── vpc/
        └── terragrunt.hcl
```

### 配置文件

```hcl
# terragrunt.hcl（根）
remote_state {
  backend = "s3"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite"
  }
  config = {
    bucket         = "my-tfstate"
    key            = "${path_relative_to_include()}/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite"
  contents  = <<EOF
provider "aws" {
  region = "${local.env_vars.region}"
  assume_role {
    role_arn = "arn:aws:iam::${local.env_vars.account_id}:role/TerraformAdmin"
  }
}
EOF
}
```

```hcl
# prod/env.hcl
locals {
  env_vars = {
    region     = "ap-southeast-1"
    account_id = "111111111111"
    env        = "prod"
    vpc_cidr   = "10.0.0.0/16"
  }
}
```

```hcl
# prod/vpc/terragrunt.hcl（实际模块调用——简洁到极致）
include "root" {
  path = find_in_parent_folders()
}

include "env" {
  path = "${find_in_parent_folders("env.hcl")}"
}

terraform {
  source = "git::git@github.com:org/terraform-modules.git//vpc?ref=v2.1.0"
}

inputs = {
  name       = "${local.env_vars.env}-vpc"
  cidr_block = local.env_vars.vpc_cidr

  # 依赖其他 Terragrunt 模块的输出
  transit_gateway_id = dependency.tgw.outputs.tgw_id
}

dependency "tgw" {
  config_path = "../tgw"    # 自动处理模块间依赖顺序
}
```

常用命令：

```bash
# 对所有环境执行 plan（预览但不操作）
terragrunt run-all plan

# 只对 prod 环境 apply
cd prod && terragrunt run-all apply

# 查看模块依赖图
terragrunt graph-dependencies

# hclfmt（格式化所有 terragrunt.hcl）
terragrunt hclfmt
```

## terraform import —— 把"手动建的"变成"代码管的"

### 危险性

`terraform import` 的流程是反直觉的：

```
1. 在 .tf 文件中写 resource（此时 State 为空，这个 resource 还不存在）
2. terraform import <tf-resource> <cloud-id>
3. terraform plan → 检查差异是否正确
4. 如果 plan 不是 "No changes"，说明你的 HCL 描述的和云上实际不一致
   → 修改 HCL 直到 plan 显示 "No changes"
   → 然后才能放心地 apply
```

如果在 import 后**没有**让 plan 显示 "No changes" 就直接 apply，Terraform 会尝试"修复"云上资源——删除它认为多余的配置，添加它认为缺失的配置。这就是 destroy 生产环境的常见方式。

### 安全 Import 流程（SOP）

```bash
# Step 1: 写 resource 块
cat > import-target.tf << 'EOF'
resource "aws_security_group" "imported" {
  name        = "placeholder"     # 会被真实值覆盖
  description = "placeholder"
  vpc_id      = "placeholder"
}
EOF

# Step 2: import
terraform import aws_security_group.imported sg-12345678

# Step 3: 读取导入后的 state
terraform state show aws_security_group.imported
# 复制上面的真实值 → 写到 .tf 文件

# Step 4: 验证
terraform plan
# 必须显示 "No changes. Your infrastructure matches the configuration."
# 如果不是 → 修改 HCL，回到 Step 3

# Step 5: 只有在 plan 为空时才提交
```

## 关联知识

- [[Terraform 基础设施即代码]] — 本文是其生产级实践补充
- [[../k8s/特性详解/ArgoCD GitOps 实战]] — Terraform 建集群，ArgoCD 管集群
- [[../k8s/特性详解/etcd 运维详解]] — etcd 的备份思想同样适用于 State 备份

## 参考资源

- Atlantis 文档：https://www.runatlantis.io/docs/
- Terragrunt 文档：https://terragrunt.gruntwork.io/docs/
- Terraform State 管理：https://developer.hashicorp.com/terraform/language/state
- Terraform import：https://developer.hashicorp.com/terraform/cli/import

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 生产级实践 | 2026-07-02 | State 恢复、Atlantis、Terragrunt、Import SOP |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-09

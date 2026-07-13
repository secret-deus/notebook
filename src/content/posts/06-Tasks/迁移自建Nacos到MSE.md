---
date: 2026-04-09
tags: [任务计划, Nacos, MSE, 迁移]
status: 待开始
type: 任务执行
title: "迁移自建Nacos到MSE"
---

# 迁移自建 Nacos 到 MSE

## 任务概述

| 字段   | 内容                  |
| ---- | ------------------- |
| 任务名称 | 迁移自建 Nacos 到阿里云 MSE |
| 创建时间 | 2026-04-09          |
| 计划完成 | 待定（夜间低谷窗口）          |
| 实际完成 |                     |
| 负责人  |                     |
| 关联系统 | Nacos 配置中心、93 个注册服务 |

## 背景与目标

**现状**：
- 自建 Nacos 1.3.2 集群（3 节点）
- 内置 Derby 存储
- 约 100 个配置项，93 个服务注册
- K8s 内通过 ConfigMap/硬编码访问

**目标**：
- 迁移至阿里云 MSE Nacos
- 内网地址：`mse-97f57750-nacos-ans.mse.aliyuncs.com:8848`
- 鉴权方式：无
- 全量迁移历史配置

**停机窗口**：30 分钟（夜间低谷）
**准备周期**：1 周

---

## 现状评估

| 评估项 | 状态 | 备注 |
|--------|------|------|
| 配置导出 | ✅ 已完成 | 控制台导出所有配置 |
| MSE 实例 | ✅ 已购买 | 地址已确认 |
| 服务影响 | ⚠️ 高风险 | 93 个服务需重启 |
| 回滚能力 | ⚠️ 待准备 | 需保留自建集群 |

**潜在风险**：
1. 部分服务硬编码 Nacos 地址，需逐个排查
2. 批量重启 93 个服务，脚本必须经过充分测试
3. 脚本逻辑错误可能导致批量故障

---

## 执行步骤

### 阶段一：准备（D-7 到 D-1，共 7 天）

#### D-7：任务启动 & 信息收集

- [ ] **成立迁移小组**，明确分工
- [ ] **收集完整信息**：
  - 自建 Nacos 内网地址（完整集群地址列表）
  - K8s 集群访问出口 IP 段（用于 MSE 白名单）
  - 当前所有 Namespace 列表
  - 各服务负责人联系方式

- [ ] **MSE 基础配置**：
  - [ ] MSE 控制台添加 K8s 出口 IP 白名单
  - [ ] 测试网络连通性：`telnet mse-97f57750-nacos-ans.mse.aliyuncs.com 8848`
  - [ ] 导入配置到 MSE（控制台导入已导出文件）
  - [ ] 核对配置项数量（应 ≈ 100 个）
  - [ ] 抽查 5-10 个关键配置内容

#### D-6：全量扫描 & 清单整理

- [ ] **扫描所有 Nacos 引用**：
  ```bash
  # 扫描 ConfigMap
  kubectl get cm -A -o json | jq -r '.items[] | select(.data | tostring | contains("nacos")) | "\(.metadata.namespace)/\(.metadata.name)"' | sort | uniq > /tmp/cm-with-nacos.txt
  
  # 扫描 Deployment 环境变量
  kubectl get deploy -A -o json | jq -r '.items[] | select(.spec.template.spec.containers[].env[]?.value | contains("nacos")) | "\(.metadata.namespace)/\(.metadata.name)"' | sort | uniq > /tmp/deploy-with-nacos.txt
  
  # 扫描硬编码在 args/command 中的
  kubectl get deploy -A -o yaml | grep -B10 -A10 "nacos" | grep -E "(name:|namespace:|nacos)" > /tmp/deploy-nacos-details.txt
  ```

- [ ] **整理服务清单**：
  - [ ] 汇总所有涉及的服务（去重后应 ≈ 93 个）
  - [ ] 按业务域分组（订单/支付/用户/商品/...）
  - [ ] 按优先级分级（P0 核心 / P1 重要 / P2 普通）
  - [ ] 标注每个服务的 ConfigMap 引用方式（统一 ConfigMap / 独立 ConfigMap / 硬编码）

- [ ] **输出《服务清单表》**：

| 序号  | 服务名 | Namespace |   优先级    |      配置方式       | 负责人 | 重启批次 |
| :-: | :-: | :-------: | :------: | :-------------: | :-: | :--: |
|  1  |     |           | P0/P1/P2 | ConfigMap / 硬编码 |     | 第1批  |
|  2  |     |           | P0/P1/P2 | ConfigMap / 硬编码 |     | 第1批  |
| ... | ... |    ...    |   ...    |       ...       | ... | ...  |

#### D-5：脚本开发（第 1 天）

- [ ] **开发脚本 1：ConfigMap 批量替换脚本**
  ```bash
  #!/bin/bash
  # update-nacos-cm.sh
  # 功能：批量更新所有包含 nacos 的 ConfigMap
  ```
  要求：
  - 支持 dry-run 模式（只打印不执行）
  - 支持指定 Namespace
  - 支持回滚（保存原 ConfigMap 到 backup）
  - 输出变更清单

- [ ] **开发脚本 2：服务分批重启脚本**
  ```bash
  #!/bin/bash
  # restart-services-batch.sh
  # 功能：按批次重启服务，等待就绪后再下一批
  ```
  要求：
  - 从文件读取服务列表
  - 支持指定批次大小（默认 10 个）
  - 每批等待 rollout status 成功（超时 120s）
  - 失败时暂停，记录失败服务
  - 输出执行报告

- [ ] **开发脚本 3：状态检查脚本**
  ```bash
  #!/bin/bash
  # check-mse-status.sh
  # 功能：检查 MSE 服务注册状态
  ```
  要求：
  - 调用 MSE/Nacos OpenAPI 查询服务数量
  - 对比预期服务列表，输出缺失服务
  - 检查配置项数量

- [ ] **开发脚本 4：一键回滚脚本**
  ```bash
  #!/bin/bash
  # rollback-nacos.sh
  # 功能：紧急回滚到自建 Nacos
  ```
  要求：
  - 从 backup 恢复 ConfigMap
  - 批量重启所有服务
  - 验证回滚结果

#### D-4：脚本开发（第 2 天）

- [ ] **完成所有脚本开发**
- [ ] **代码评审**：至少 1 人 review 脚本逻辑
- [ ] **异常场景处理**：
  - ConfigMap 不存在时的处理
  - rollout 超时处理
  - 网络中断重试机制
  - 部分失败继续还是停止

#### D-3：脚本测试（测试环境）

- [ ] **搭建测试环境**：
  - 找一个非生产 Namespace
  - 部署 3-5 个测试服务
  - 配置指向测试 Nacos

- [ ] **执行全量脚本测试**：
  - [ ] 测试脚本 1：ConfigMap 替换（dry-run + 实际执行）
  - [ ] 测试脚本 2：分批重启（验证批次控制、超时处理）
  - [ ] 测试脚本 3：状态检查（验证 API 调用、数据准确性）
  - [ ] 测试脚本 4：回滚（验证备份恢复逻辑）

- [ ] **记录测试结果 & 修复问题**
- [ ] **输出《脚本测试报告》**

#### D-2：生产环境预演（只读操作）

- [ ] **生产环境预演**：
  - [ ] 执行脚本 1 dry-run，确认影响范围
  - [ ] 核对服务清单准确性（与预演结果对比）
  - [ ] 验证 MSE 白名单（从生产节点 telnet 测试）
  - [ ] 确认备份存储位置（确保有写权限）

- [ ] **准备生产执行包**：
  - [ ] 所有脚本 + 配置文件
  - [ ] 服务清单（最终版）
  - [ ] 回滚方案（打印版，网络故障时可用）
  - [ ] 各团队负责人联系方式

#### D-1：最终确认

- [ ] **迁移窗口确认**：
  - [ ] 确认具体日期时间
  - [ ] 确认各团队值班人员
  - [ ] 发送最终通知（提前 24h）

- [ ] **环境检查**：
  - [ ] MSE 配置再次确认
  - [ ] 自建 Nacos 状态检查
  - [ ] K8s 集群状态检查
  - [ ] 备份存储空间检查

- [ ] **脚本最终检查**：
  - [ ] 脚本文件完整性
  - [ ] 执行权限
  - [ ] 配置文件正确性

---

### 阶段二：实施（迁移当天，T-0）

**时间窗口**：夜间低谷，30 分钟

| 时间 | 动作 | 负责人 | 检查点 |
|------|------|--------|--------|
| T-0 | 开始窗口，通知各团队 | | |
| T+0~5min | 执行备份脚本 | | 确认备份文件生成 |
| T+5~10min | 执行 ConfigMap 替换脚本 | | 确认所有 CM 更新 |
| T+10~25min | 执行分批重启脚本（第一批）| | 确认 MSE 有服务注册 |
| T+25~30min | 执行分批重启脚本（剩余批次）| | 确认 93 个服务全部注册 |
| T+30min | 执行状态检查脚本 | | 确认服务数、配置数正确 |
| T+30min | 窗口结束，发送状态通知 | | |

**详细步骤**：

- [ ] **T+0：备份当前状态**
  ```bash
  ./scripts/backup-before-migration.sh
  ```
  - 导出当前所有服务列表
  - 备份所有 ConfigMap（含 nacos 引用的）
  - 保存到 `/backup/nacos-migration-$(date +%Y%m%d%H%M)/`

- [ ] **T+5：更新 ConfigMap**
  ```bash
  ./scripts/update-nacos-cm.sh --apply
  ```

- [ ] **T+10：分批重启（第一批验证）**
  ```bash
  ./scripts/restart-services-batch.sh --batch=1 --size=5
  ```
  - 先重启 5 个非核心服务验证
  - 检查 MSE 控制台是否有服务注册
  - 确认无异常后继续

- [ ] **T+15：批量重启剩余服务**
  ```bash
  ./scripts/restart-services-batch.sh --batch=2-10 --size=10
  ```

- [ ] **T+30：最终验证**
  ```bash
  ./scripts/check-mse-status.sh --expected-services=93
  ```

---

### 阶段三：验证（T+30min ~ T+2h）

- [ ] **功能验证**：
  - [ ] 核心业务接口调用测试（采样 10% 服务）
  - [ ] 配置热更新测试（修改一个配置，确认推送）
  - [ ] 服务间调用测试（链式调用验证）

- [ ] **监控检查**：
  - [ ] 各服务日志检查（无 Nacos 连接错误）
  - [ ] 业务监控指标正常（QPS、错误率、延迟）
  - [ ] 告警检查（无异常告警）

- [ ] **配置核对**：
  - [ ] 随机抽查 20 个配置项，与自建对比

---

### 阶段四：收尾（D+1 到 D+7）

- [ ] **D+1**：
  - [ ] 更新运维文档
  - [ ] 修改架构图
  - [ ] 发送迁移完成通知

- [ ] **D+2~D+7**：观察期
  - [ ] 每日检查 MSE 状态
  - [ ] 处理遗留问题（硬编码整改）

- [ ] **D+7 后**：
  - [ ] 确认稳定运行 1 周
  - [ ] 下线自建 Nacos 集群
  - [ ] 归档迁移文档

---

## 回滚方案

**触发条件**：
- 迁移后 30 分钟内无法恢复核心服务
- 大量服务无法注册到 MSE
- 配置丢失或错误导致业务异常
- 脚本执行严重异常

**回滚步骤**：
```bash
# 一键回滚
./scripts/rollback-nacos.sh
```

手动回滚（脚本失效时）：
1. 从 `/backup/nacos-migration-*/` 恢复 ConfigMap
2. 执行 `./scripts/restart-services-batch.sh --all`
3. 验证自建 Nacos 服务注册

**预计回滚时间**：15-20 分钟

---

## 影响范围

| 系统/服务       | 影响描述        | 应对措施               |
| ----------- | ----------- | ------------------ |
| 93 个 K8s 服务 | 需重启，期间短暂不可用 | 夜间低谷执行，分批重启，脚本控制节奏 |
| 配置中心        | 地址变更        | 提前导入配置，脚本批量更新      |
| 服务发现        | 短暂中断        | 重启后自动恢复            |

---

## 脚本

### 脚本 0: 迁移前备份

```bash
#!/bin/bash

# ============================================================
# 脚本 0: 迁移前备份脚本
# 功能: 备份当前环境状态，用于对比和回滚
# 用法: ./backup-before-migration.sh
# ============================================================

set -e

export KUBECONFIG=${KUBECONFIG:-/root/.kube/config}
BACKUP_ROOT="/backup/nacos-migration"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$BACKUP_ROOT/pre_$TIMESTAMP"

echo "========================================="
echo "  Nacos 迁移 - 迁移前备份"
echo "========================================="
echo "备份目标: $BACKUP_DIR"

mkdir -p "$BACKUP_DIR/{configmaps,services,configs,deployments}"

echo ""
echo "--- 步骤 1: 备份所有 ConfigMap ---"
CM_COUNT=0
for ns in $(kubectl get ns -o json | jq -r '.items[].metadata.name'); do
    kubectl get cm -n "$ns" -o json | jq -r \
        '[.items[] | select(.data | tostring | contains("nacos"))] | .[].metadata.name' \
        2>/dev/null | while read -r cm; do
        [ -z "$cm" ] && continue
        kubectl get cm "$cm" -n "$ns" -o yaml > "$BACKUP_DIR/configmaps/${ns}_${cm}.yaml" 2>/dev/null || true
        ((CM_COUNT++))
    done
done
echo "✅ ConfigMap 备份完成"

echo ""
echo "--- 步骤 2: 导出服务注册列表 ---"
SELF_BUILD_NACOS_URL=""   # 填写自建 Nacos 控制台 URL
if [ -n "$SELF_BUILD_NACOS_URL" ]; then
    curl -s "${SELF_BUILD_NACOS_URL}/nacos/v1/ns/service/list" \
        -X GET -G --data-urlencode "pageSize=1000" --data-urlencode "pageNo=1" \
        > "$BACKUP_DIR/services/services.json" 2>/dev/null
    SERVICE_COUNT=$(jq -r '.count // 0' "$BACKUP_DIR/services/services.json" 2>/dev/null)
    echo "✅ 服务列表已导出 (当前 $SERVICE_COUNT 个服务)"
else
    echo "ℹ️ 未配置自建 Nacos URL，跳过服务列表导出"
fi

echo ""
echo "--- 步骤 3: 导出 Deployment 状态 ---"
kubectl get deploy -A -o wide > "$BACKUP_DIR/deployments/deploy-list.txt"
echo "✅ Deployment 列表已保存"

echo ""
echo "--- 步骤 4: 导出配置信息 ---"
if [ -n "$SELF_BUILD_NACOS_URL" ]; then
    curl -s "${SELF_BUILD_NACOS_URL}/nacos/v1/cs/configs" \
        -X GET -G --data-urlencode "pageNo=1" --data-urlencode "pageSize=1000" \
        --data-urlencode "search=blur" --data-urlencode "dataId=" \
        > "$BACKUP_DIR/configs/all-configs.json" 2>/dev/null
    CONFIG_COUNT=$(jq -r '.totalCount // 0' "$BACKUP_DIR/configs/all-configs.json" 2>/dev/null)
    echo "✅ 配置项已导出 (当前 $CONFIG_COUNT 个)"
else
    echo "ℹ️ 未配置自建 Nacos URL，跳过配置导出"
fi

echo ""
echo "========================================="
echo "  备份完成"
echo "========================================="
echo "备份目录: $BACKUP_DIR"
du -sh "$BACKUP_DIR"/*
echo ""
echo "回滚命令参考:"
echo "  # 一键回滚（见下方回滚脚本）"
```

### 脚本 1: ConfigMap 批量替换

```bash
#!/bin/bash

# ============================================================
# 脚本 1: ConfigMap 批量替换脚本
# 功能: 扫描所有包含 nacos 的 ConfigMap，批量替换地址
# ============================================================

set -e; set -o pipefail

export KUBECONFIG=${KUBECONFIG:-/root/.kube/config}
BACKUP_DIR="/tmp/nacos-cm-bak_$(date +%Y%m%d%H%M%S)"
OLD_NACOS_ADDR=""
NEW_NACOS_ADDR="mse-97f57750-nacos-ans.mse.aliyuncs.com:8848"
NAMESPACE="${1:-}"
DRY_RUN=false
APPLY=false

usage() {
    echo "用法: $0 [选项]"
    echo "  -n, --namespace <ns>    指定命名空间（留空=全部）"
    echo "  -o, --old <地址>        旧 Nacos 地址（必须）"
    echo "  -N, --new <地址>        新 Nacos 地址"
    echo "  -d, --dry-run           只打印不执行"
    echo "  -a, --apply             实际执行替换"
    echo "  -h, --help              帮助"
    echo ""
    echo "示例:"
    echo "  $0 -n test -o 'nacos.default.svc.cluster.local:8848' -d"
    echo "  $0 -n test -o 'nacos.default.svc.cluster.local:8848' -a"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -n|--namespace) NAMESPACE="$2"; shift 2 ;;
        -o|--old) OLD_NACOS_ADDR="$2"; shift 2 ;;
        -N|--new) NEW_NACOS_ADDR="$2"; shift 2 ;;
        -d|--dry-run) DRY_RUN=true; shift ;;
        -a|--apply) APPLY=true; shift ;;
        -h|--help) usage ;;
        *) echo "未知参数: $1"; usage ;;
    esac
done

if [ -z "$OLD_NACOS_ADDR" ]; then
    echo "错误: 必须指定旧 Nacos 地址 (-o)"
    usage
fi

echo "--- 步骤 1: 扫描 ConfigMap ---"

CM_LIST=$(kubectl get cm -A -o json | jq -r '
    [.items[] |
      select((.data | tostring | contains("'"$OLD_NACOS_ADDR"'")) or (.data | tostring | contains("nacos"))) |
      "\(.metadata.namespace)|\(.metadata.name)"
    ] | sort | unique
')

if [ -z "$CM_LIST" ]; then
    echo "⚠️ 未找到包含 nacos 的 ConfigMap"; exit 0
fi

TOTAL_CM=$(echo "$CM_LIST" | wc -l); echo "找到 $TOTAL_CM 个需要检查的 ConfigMap"

if [ -n "$NAMESPACE" ]; then
    CM_LIST=$(echo "$CM_LIST" | grep "^${NAMESPACE}|" || true)
    FILTERED_CM=$(echo "$CM_LIST" | wc -l)
    echo "过滤后 (namespace=$NAMESPACE): $FILTERED_CM 个"
fi

echo ""
echo "--- 步骤 2: 备份与替换 ---"

MODIFIED_CMS=(); SKIPPED_CMS=()

while IFS='|' read -r ns cm_name; do
    [ -z "$cm_name" ] && continue
    CM_YAML=$(kubectl get cm "$cm_name" -n "$ns" -o yaml)

    if ! echo "$CM_YAML" | grep -q "$OLD_NACOS_ADDR"; then
        echo "ℹ️ 跳过 [$ns/$cm_name]: 不包含旧地址"
        SKIPPED_CMS+=("$ns/$cm_name"); continue
    fi

    if [ "$DRY_RUN" = true ]; then
        echo "📋 DRY-RUN [$ns/$cm_name]: '$OLD_NACOS_ADDR' → '$NEW_NACOS_ADDR'"
        MODIFIED_CMS+=("$ns|$cm_name"); continue
    fi

    if [ "$APPLY" != true ]; then
        echo "ℹ️ 需要修改但未指定 -a: $ns/$cm_name"
        MODIFIED_CMS+=("$ns|$cm_name"); continue
    fi

    mkdir -p "$BACKUP_DIR"
    echo "$CM_YAML" > "$BACKUP_DIR/${ns}.yaml"
    NEW_YAML=$(echo "$CM_YAML" | sed "s|${OLD_NACOS_ADDR}|${NEW_NACOS_ADDR}|g")
    echo "$NEW_YAML" | kubectl replace -f -
    echo "✅ 已更新: $ns/$cm_name"
    MODIFIED_CMS+=("$ns|$cm_name")
done <<< "$CM_LIST"

echo ""
echo "========================================="; echo "  执行报告"; echo "========================================="
echo ""; echo "扫描总数: $(( ${#MODIFIED_CMS[@]} + ${#SKIPPED_CMS[@]} ))"
echo "需要更新: ${#MODIFIED_CMS[@]}"; echo "跳过: ${#SKIPPED_CMS[@]}"

if [ "${#MODIFIED_CMS[@]}" -gt 0 ]; then
    echo ""; echo "--- 变更列表 ---"
    for item in "${MODIFIED_CMS[@]}"; do echo "  🔄 $item"; done
fi

if [ "$APPLY" = true ] && [ "${#MODIFIED_CMS[@]}" -gt 0 ]; then
    echo ""; echo "📦 备份位置: $BACKUP_DIR"; echo "🔙 回滚: 见下方回滚脚本"
fi
```

### 脚本 2: 分批重启服务

```bash
#!/bin/bash

# ============================================================
# 脚本 2: 服务分批重启脚本
# 功能: 按批次重启服务，等待就绪后再下一批
# ============================================================

set -e

export KUBECONFIG=${KUBECONFIG:-/root/.kube/config}
SERVICE_LIST_FILE="./scripts/service-list.csv"
BATCH_SIZE=${1:-10}
BATCH_NUM=${2:-}
TIMEOUT_ROLLOUT=120s
WAIT_INTERVAL=5s
LOG_DIR="/tmp/nacos-restart_$(date +%Y%m%d%H%M%S)"

mkdir -p "$LOG_DIR"

usage() {
    echo "用法: $0 [批次大小] [批次号]"
    echo "  $0              # 默认每批10个，所有批次"
    echo "  $0 5            # 每批5个"
    echo "  $0 10 1         # 只执行第1批(验证用)"
    echo "  $0 10 2-3       # 执行第2~3批"
    echo ""
    echo "CSV 格式: 服务名,Namespace,优先级,配置方式,批次"
    exit 0
}

[[ "$1" == "-h" || "$1" == "--help" ]] && usage

[ ! -f "$SERVICE_LIST_FILE" ] && { echo "错误: 服务清单不存在: $SERVICE_LIST_FILE"; exit 1; }

echo "========================================="
echo "  Nacos 迁移 - 分批重启工具"
echo "========================================="
echo "清单: $SERVICE_LIST_FILE | 批次大小: $BATCH_SIZE | 日志: $LOG_DIR"
echo ""

ALL_SERVICES=()
while IFS=',' read -r service ns priority method batch; do
    [[ "$service" =~ ^#.* ]] && continue; [ -z "$service" ] && continue
    ALL_SERVICES+=("${service}|${ns}|${priority}|${method}|${batch}")
done < "$SERVICE_LIST_FILE"

TOTAL=${#ALL_SERVICES[@]}; TOTAL_BATCHES=$(( (TOTAL + BATCH_SIZE - 1) / BATCH_SIZE ))
echo "总服务数: $TOTAL | 总批次数: $TOTAL_BATCHES"

START_BATCH=1; END_BATCH=$TOTAL_BATCHES
if [ -n "$BATCH_NUM" ]; then
    if [[ "$BATCH_NUM" =~ ^([0-9]+)-([0-9]+)$ ]]; then START_BATCH="${BASH_REMATCH[1]}"; END_BATCH="${BASH_REMATCH[2]}"
    elif [[ "$BATCH_NUM" =~ ^[0-9]+$ ]]; then START_BATCH="$BATCH_NUM"; END_BATCH="$BATCH_NUM"; fi
    echo "执行批次: $START_BATCH ~ $END_BATCH"
fi

echo ""
echo "--- 步骤: 分批重启 ---"

SUCCESS_LIST=(); FAIL_LIST=()

for ((batch_idx = START_BATCH; batch_idx <= END_BATCH; batch_idx++)); do
    start_idx=$(( (batch_idx - 1) * BATCH_SIZE )); end_idx=$(( start_idx + BATCH_SIZE ))
    [ $end_idx -gt $TOTAL ] && end_idx=$TOTAL; batch_count=$(( end_idx - start_idx ))
    
    echo ""; echo "═══ 第 $batch_idx / $TOTAL_BATCHES 批 ($batch_count 个) ═══"; echo ""
    RESTARTED_DEPS=()
    
    for ((i = start_idx; i < end_idx; i++)); do
        IFS='|' read -r service ns priority method batch <<< "${ALL_SERVICES[$i]}"
        echo -n "  [$service] ($ns)... "
        
        if ! kubectl get deployment "$service" -n "$ns" --request-timeout=10s &>/dev/null; then
            echo "❌ Deployment 不存在"; FAIL_LIST+=("$service"); echo "$(date '+%H:%M:%S') FAIL $service/$ns: not found" >> "$LOG_DIR/failures.log"; continue; fi
        
        if kubectl rollout restart "deployment/$service" -n "$ns" --request-timeout=30s &>/dev/null; then
            if kubectl rollout status "deployment/$service" -n "$ns" --timeout="$TIMEOUT_ROLLOUT" >> "$LOG_DIR/${service}.log 2>&1; then
                echo "✅ 成功"; SUCCESS_LIST+=("$service/$ns"); echo "$(date '+%H:%M:%S') OK $service/$ns" >> "$LOG_DIR/success.log"
            else echo "⚠️ 超时(已触发)"; SUCCESS_LIST+=("$service/$ns"); echo "$(date '+%H:%M:%S') WARN $service/$ns: timeout" >> "$LOG_DIR/warnings.log"; fi
        else echo "❌ 重启失败"; FAIL_LIST+=("$service/$ns"); echo "$(date '+%H:%M:%S') FAIL $service/$ns" >> "$LOG_DIR/failures.log"; fi
        
        sleep 2
    done
    
    [ $batch_idx -lt $END_BATCH ] && { echo "  等待 $WAIT_INTERVAL..."; sleep "$WAIT_INTERVAL"; }
done

echo ""; echo "========================================="; echo "  执行报告"; echo "========================================="
echo ""; echo "总处理: $TOTAL | ✅成功: ${#SUCCESS_LIST[@]} | ❌失败: ${#FAIL_LIST[@]}"

if [ "${#FAIL_LIST[@]}" -gt 0 ]; then
    echo ""; echo "❌ 失败列表:"; for f in "${FAIL_LIST[@]}"; do echo "  ❌ $f"; done
    echo ""; echo "日志: $LOG_DIR/failures.log"
else echo ""; echo "🎉 全部完成！"
fi
echo ""; echo "详细日志: $LOG_DIR/"
```

### 脚本 3: MSE 状态检查

```bash
#!/bin/bash

# ============================================================
# 脚本 3: MSE 状态检查脚本
# 功能: 检查 MSE/Nacos 服务注册状态，对比预期
# ============================================================

set -e

MSE_HOST="mse-97f57750-nacos-ans.mse.aliyuncs.com"
MSE_PORT=8848
EXPECTED_SERVICES=93
EXPECTED_CONFIGS=100
NAMESPACE_ID="${1:-public}"
CHECK_TYPE="${2:-all}"
VERBOSE=false

usage() {
    echo "用法: $0 [namespace_id] [check_type] [选项]"
    echo "  check_type: all / services / configs"
    echo "  -s/--expected-services <数字>"
    echo "  -c/--expected-configs <数字>"
    echo "  -v/--verbose 详细输出"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -s|--expected-services) EXPECTED_SERVICES="$2"; shift 2 ;;
        -c|--expected-configs) EXPECTED_CONFIGS="$2"; shift 2 ;;
        -v|--verbose) VERBOSE=true; shift ;;
        -h|--help) usage ;;
        *) ;;
    esac
done

echo "========================================="
echo "  MSE 状态检查工具"
echo "========================================="
echo "MSE: ${MSE_HOST}:${MSE_PORT} | Namespace: ${NAMESPACE_ID} | 类型: $CHECK_TYPE"
echo ""

API_BASE="http://${MSE_HOST}:${MSE_PORT}/nacos/v1/ns"
CONFIG_API_BASE="http://${MSE_HOST}:${MSE_PORT}/nacos/v1/cs"
NS_PARAM=""
[ -n "$NAMESPACE_ID" ] && NS_PARAM="?tenantId=${NAMESPACE_ID}"

PASS=0; WARN=0; FAIL=0

check_result() { local n="$1" e="$2" a="$3";
    [ "$a" -eq "$e" ] && { echo "  ✅ $n: $a / $e"; ((PASS++)); return; }
    [ "$a" -ge $((e * 95 / 100)) ] && { echo "  ⚠️  $n: $a / $e (±5%)"; ((WARN++)); return; }
    echo "  ❌ $n: $a / $e"; ((FAIL++))
}

if [ "$CHECK_TYPE" = "all" ] || [ "$CHECK_TYPE" = "services" ]; then
    echo "━━━ 服务注册 ━━━"
    SERVICE_COUNT=$(curl -s "${API_BASE}/service/list${NS_PARAM}" -X GET -G \
        --data-urlencode "pageSize=9999" --data-urlencode "pageNo=1" 2>/dev/null | jq -r '.count // empty')
    check_result "注册服务数" "$EXPECTED_SERVICES" "${SERVICE_COUNT:-0}"
    
    if [ "$VERBOSE" = true ]; then
        echo ""; echo "  详情:"
        curl -s "${API_BASE}/service/list${NS_PARAM}" -X GET -G \
            --data-urlencode "pageSize=9999" --data-urlencode "pageNo=1" 2>/dev/null | jq -r '.domains[]? // empty' | while read -r s; do echo "    • $s"; done
    fi
    echo ""
fi

if [ "$CHECK_TYPE" = "all" ] || [ "$CHECK_TYPE" = "configs" ]; then
    echo "━━━ 配置项 ━━━"
    CONFIG_COUNT=$(curl -s "${CONFIG_API_BASE}/configs${NS_PARAM}" -X GET -G \
        --data-urlencode "pageNo=1" --data-urlencode "pageSize=1000" \
        --data-urlencode "search=blur" --data-urlencode "dataId=" --data-urlencode "group=" 2>/dev/null | jq -r '.totalCount // empty' | head -1)
    check_result "配置项数" "$EXPECTED_CONFIGS" "${CONFIG_COUNT:-0}"; echo ""
fi

echo "━━━ 连通性 ━━━"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "http://${MSE_HOST}:${MSE_PORT}/nacos/" 2>/dev/null || echo "000")
case "$HTTP_CODE" in 200|302) echo "  ✅ MSE 可达 (HTTP $HTTP_CODE)"; ((PASS++)) ;; 000) echo "  ❌ MSE 不可达"; ((FAIL++)) ;; *) echo "  ⚠️ HTTP $HTTP_CODE"; ((WARN++)) ;; esac
echo ""

echo "========================================="; echo "  汇总"; echo "========================================="
echo "✅通过: $PASS | ⚠️警告: $WARN | ❌失败: $FAIL"; echo ""
[ $FAIL -gt 0 ] && { echo "❌ 存在问题！"; exit 1; }
[ $WARN -gt 0 ] && { echo "⚠️ 有警告"; exit 2; }
echo "🎉 全部正常！"; exit 0
```

### 脚本 4: 一键回滚

```bash
#!/bin/bash

# ============================================================
# 脚本 4: 一键回滚脚本
# 功能: 紧急回滚到自建 Nacos
# ============================================================

set -e

export KUBECONFIG=${KUBECONFIG:-/root/.kube/config}
BACKUP_DIR="${1:-}"
FORCE="${2:-}"

usage() {
    echo "用法: $0 [备份目录] [--force]"
    echo "  不指定则自动查找最新备份 | --force 跳过确认"
    exit 0
}

[[ "$1" == "-h" || "$1" == "--help" ]] && usage
[ "$1" = "--force" ] && FORCE="--force" && BACKUP_DIR=""
[ "$2" = "--force" ] && FORCE="--force"

echo "╔══════════════════════════════════════╗"
echo "║  ⚠️  Nacos 迁移 - 一键回滚工具      ║"
echo "╚════════════════════════════════════╝"
echo ""

if [ -z "$BACKUP_DIR" ]; then
    LATEST_BAK=$(ls -dt /tmp/nacos-cm-bak_* 2>/dev/null | head -1)
    [ -z "$LATEST_BAK" ] && { echo "❌ 未找到备份！查找: /tmp/nacos-cm-bak_*"; exit 1; }
    BACKUP_DIR="$LATEST_BAK"; echo "自动找到: $BACKUP_DIR"
else
    [ ! -d "$BACKUP_DIR" ] && { echo "❌ 目录不存在: $BACKUP_DIR"; exit 1; }
fi

echo "备份: $BACKUP_DIR"; echo ""
ls -la "$BACKUP_DIR"/ | tail -n +2 | awk '{print " ", $NF}' 2>/dev/null; echo ""
RESTORE_COUNT=$(ls "$BACKUP_DIR"/*.yaml 2>/dev/null | wc -l); echo "将恢复 $RESTORE_COUNT 个命名空间"; echo ""

if [ "$FORCE" != "--force" ]; then
    echo "⚠️ 此操作将：1.恢复ConfigMap 2.批量重启 3.切回自建Nacos"
    echo -n "确认？(15s内输入y): "
    read -t 15 CONFIRM; [[ "$CONFIRM" != "y"* && "$CONFIRM" != "Y"* ]] && { echo "已取消"; exit 0; }
else echo "🔴 强制模式！"; fi
echo ""; echo "开始回滚..."; echo ""

echo "═══ 步骤1: 恢复 ConfigMap ═══"; echo ""
CS=0; CF=0
for f in "$BACKUP_DIR"/*.yaml; do [ -f "$f" ] || continue; ns=$(basename "$f" .yaml)
    kubectl get namespace "$ns" &>/dev/null || { echo "⚠️ 命名空间不存在: $ns"; continue; }
    kubectl apply -f "$f" --force --overwrite &>/dev/null && { echo "✅ $ns"; ((CS++)); } || { echo "❌ $ns"; ((CF++)); }
done
echo ""; echo "ConfigMap: ✅$CS / ❌$CF"
[ "$CF" -gt 0 ] && { echo "⚠️ 有失败，继续？(y/n)"; read -t 10 C; [[ "$C" != "y" ]] && exit 1; }

echo ""; echo "═══ 步骤2: 批量重启 ═══"; echo ""
RS=0; RF=0; RL="/tmp/nacos-rollback_$(date +%Y%m%d%H%M).log"; touch "$RL"
for ns_yaml in "$BACKUP_DIR"/*.yaml; do [ -f "$ns_yaml" ] || continue; ns=$(basename "$ns_yaml" .yaml)
    for dep in $(kubectl get deploy -n "$ns" -o json | jq -r '.items[].metadata.name' 2>/dev/null); do
        echo -n "  $ns/$dep ... "
        kubectl rollout restart "deployment/$dep" -n "$ns" --request-timeout=30s &>/dev/null \
            && { echo "✅"; ((RS++)); echo "$(date '+%H:%M:%S') OK $ns/$dep" >> "$RL"; } \
            || { echo "❌"; ((RF++)); echo "$(date '+%H:%M:%S') FAIL $ns/$dep" >> "$RL"; }
        sleep 1
    done
done
echo ""; echo "重启: ✅$RS / ❌$RF"; echo ""

echo "═══ 步骤3: 验证 ═══"; echo ""
for ns_yaml in "$BACKUP_DIR"/*.yaml; do [ -f "$ns_yaml" ] || continue; ns=$(basename "$ns_yaml" .yaml)
    for dep in $(kubectl get deploy -n "$ns" -o json | jq -r '.items[].metadata.name'); do
        echo -n "  检查 $ns/$dep... "
        kubectl rollout status "deployment/$dep" -n "$ns" --timeout=120s &>/dev/null && echo "✅就绪" || echo "⚠️未就绪"
    done
done; echo ""

echo "========================================="; echo "  回滚完成"; echo "========================================="
echo "CM: ✅$CS/❌$CF | 重启: ✅$RS/❌$RF"; echo "日志: $RL"
[ "$RF" -gt 0 ] && { echo "⚠️ 有失败！ cat $RL | grep FAIL"; exit 1; }
echo "🎉 回滚完成！请验证业务。"; exit 0
```

---

- **MSE 控制台**：https://mse.console.aliyun.com/
- **MSE 内网地址**：`mse-97f57750-nacos-ans.mse.aliyuncs.com:8848`
- **自建 Nacos 地址**：待补充
- **已导出配置**：`nacos-config-export.zip`
- **脚本**：本文档下方「脚本」章节
- **备份目录**：`/backup/nacos-migration-*/`

---

## 执行记录

| 时间  | 操作  | 结果  | 备注  |
| --- | --- | --- | --- |
|     |     |     |     |

---

## 问题与解决

<!-- 执行过程中遇到的问题及解决方案 -->


---

## 复盘总结

<!-- 完成后填写 -->


---

**状态**: 待开始  
**关联 Issue**: 

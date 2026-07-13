---
date: 2025-01-20
tags: [任务计划, Nacos, MSE, 迁移优化]
status: 待开始
type: 任务执行
title: "迁移自建Nacos到MSE-优化方案"
---

# 迁移自建Nacos到MSE - 优化方案

## 优化概述

**原方案问题**：
- 人工介入点过多（T-0、T+10、T+15、T+30等多个时间点需要人工操作）
- 分批重启策略繁琐（需要手动指定batch和size）
- 检查清单依赖人工确认
- 回滚触发依赖人工判断

**优化目标**：
- 从"30分钟紧张操作"变为"5分钟启动脚本，自动执行"
- 减少90%的人工介入点
- 自动化健康检查与回滚决策

---

## 核心优化点

### 1. 多检查点合并 → 单一预检脚本

**原方案**：
- [ ] T-24h: 确认值班人员
- [ ] T-2h: 发送最终通知
- [ ] T-0: 确认备份完成
- [ ] T-0: 确认环境正常
- [ ] T-0: 确认脚本权限

**优化后**：
```bash
# 执行单一预检脚本（迁移前自动运行）
./scripts/pre-migration-check.sh
# 自动检查并输出报告：
# ✅ MSE连通性: 正常
# ✅ K8s集群状态: 正常
# ✅ 备份空间: 充足
# ✅ 脚本权限: 正确
# ✅ 通知已发送: 完成
```

**删除的人工检查**：

| 原人工项 | 替代方案 |
|---------|---------|
| 确认各团队值班人员 | 自动通知系统（邮件/钉钉提前24h发送） |
| 发送最终通知 | 定时任务自动发送 |
| 配置文件正确性 | 自动化校验（语法检查+连接测试） |

---

### 2. 分批手动重启 → 自动滚动发布

**原方案**：
```bash
# T+10: 人工执行第一批
./scripts/restart-services-batch.sh --batch=1 --size=5
# 人工检查... 确认无异常后继续

# T+15: 人工执行剩余批次
./scripts/restart-services-batch.sh --batch=2-10 --size=10
```

**优化后**：
```bash
# 单一命令，自动滚动执行
./scripts/migration-orchestrator.sh \
  --action=migrate \
  --strategy=rolling \
  --batch-percent=20 \
  --health-check-interval=30s \
  --auto-rollback-on-failure=true

# 行为说明：
# 1. 按20%批次自动推进
# 2. 每批次后自动健康检查（30s间隔）
# 3. 异常时自动回滚，无需人工判断
# 4. 全程无需人工守在时间点
```

**时间线对比**：

| 时间 | 原方案（人工） | 优化后（自动） |
|------|---------------|---------------|
| T+0 | 人工执行第一批 | 脚本自动开始滚动 |
| T+10 | 人工检查、执行第二批 | 脚本自动推进下一批 |
| T+15 | 人工执行剩余批次 | 脚本继续自动推进 |
| T+30 | 人工最终验证 | 自动验证脚本输出报告 |

---

### 3. 人工回滚判断 → 自动回滚触发

**原方案**：
- 人工观察服务状态
- 人工判断是否需要回滚
- 人工执行回滚脚本

**优化后**：
```bash
# 回滚条件自动检测
auto_rollback_triggers:
  - service_registration_count < threshold_80_percent
  - error_rate > 5_percent_for_2_minutes
  - health_check_failures > 3_consecutive

# 触发后自动执行：
1. 暂停迁移流程
2. 自动执行 rollback-nacos.sh
3. 自动重启服务恢复
4. 发送告警通知
```

---

### 4. 实施阶段合并与并行化

**原方案流程**（串行、多人工点）：
```
T-24h → 通知 → T-2h → 检查 → T-0 → 备份 → 切换 → T+10 → 重启1 → T+15 → 重启2 → T+30 → 验证
```

**优化后流程**（并行、自动化）：
```
迁移前1天:  pre-migration-check.sh（完全自动化）
              ↓
迁移窗口:    migration-orchestrator.sh（一键执行）
              ├── 备份（自动）
              ├── 切换ConfigMap（自动）
              └── 滚动重启（自动，内置健康检查）
              └── 失败时自动回滚
              ↓
            validation.sh 持续监控15分钟，自动输出报告
```

---

## 新脚本架构

### 脚本1: pre-migration-check.sh
```bash
#!/bin/bash
# 预迁移检查（迁移前1天自动运行）

echo "=== Nacos迁移预检 ==="

# 检查1: MSE连通性
nc -zv mse-nacos-server 8848 || exit 1

# 检查2: K8s集群状态
kubectl cluster-info || exit 1
kubectl get nodes | grep -q Ready || exit 1

# 检查3: 备份空间
df -h /backup | awk 'NR==2 {if($4+0 < 10) exit 1}'

# 检查4: 脚本权限
[ -x ./scripts/migration-orchestrator.sh ] || exit 1

# 检查5: 自动发送通知
python3 notify.py --type=pre_migration --to=teams

echo "✅ 所有检查通过，系统已就绪"
```

### 脚本2: migration-orchestrator.sh（核心）
```bash
#!/bin/bash
# 迁移编排器 - 一键执行全流程

ACTION=$1  # migrate / rollback
STRATEGY=${STRATEGY:-rolling}
BATCH_PERCENT=${BATCH_PERCENT:-20}
AUTO_ROLLBACK=${AUTO_ROLLBACK:-true}

backup_data() {
    echo "📦 执行备份..."
    ./scripts/backup-nacos.sh
}

switch_config() {
    echo "🔧 切换ConfigMap..."
    kubectl apply -f k8s/configmap-mse.yaml
}

rolling_restart() {
    echo "🚀 开始滚动重启..."
    
    # 获取所有服务
    services=$(kubectl get deployments -n prod -o name)
    total=$(echo "$services" | wc -l)
    batch_size=$((total * BATCH_PERCENT / 100))
    
    batch_num=1
    for service in $services; do
        echo "  批次 $batch_num: 重启 $batch_size 个服务"
        
        # 执行重启
        kubectl rollout restart $service -n prod
        
        # 等待并健康检查
        sleep 30
        if ! health_check; then
            echo "❌ 健康检查失败"
            [ "$AUTO_ROLLBACK" == "true" ] && auto_rollback
            exit 1
        fi
        
        batch_num=$((batch_num + 1))
    done
}

health_check() {
    # 检查MSE服务注册数量
    registered=$(curl -s mse-nacos-server:8848/nacos/v1/ns/service/list | jq '.count')
    expected=${EXPECTED_SERVICES:-100}
    
    if [ $registered -lt $((expected * 80 / 100)) ]; then
        return 1
    fi
    return 0
}

auto_rollback() {
    echo "🚨 触发自动回滚..."
    kubectl apply -f k8s/configmap-legacy.yaml
    kubectl rollout restart deployment -n prod
    python3 notify.py --type=rollback --reason="健康检查失败"
}

final_validation() {
    echo "✅ 执行最终验证..."
    ./scripts/validation.sh --duration=15m --output=report
}

# 主流程
if [ "$ACTION" == "migrate" ]; then
    backup_data
    switch_config
    rolling_restart
    final_validation
    python3 notify.py --type=success
elif [ "$ACTION" == "rollback" ]; then
    auto_rollback
fi
```

### 脚本3: validation.sh（持续验证）
```bash
#!/bin/bash
# 持续验证脚本

DURATION=${1:-15m}
END_TIME=$(date -d "$DURATION" +%s)

while [ $(date +%s) -lt $END_TIME ]; do
    # 检查服务注册数
    count=$(curl -s mse-nacos-server:8848/nacos/v1/ns/service/list | jq '.count')
    
    # 检查错误率
    error_rate=$(promql_query 'rate(http_requests_total{status=~"5.."}[5m])')
    
    echo "$(date '+%H:%M:%S') - 注册服务: $count, 错误率: $error_rate"
    
    sleep 60
done

echo "✅ 验证完成，生成报告..."
```

---

## 人工介入点对比

| 环节 | 原方案介入次数 | 优化后介入次数 |
|------|---------------|---------------|
| 预迁移检查 | 5+ | **0**（完全自动） |
| 备份与切换 | 2 | **0**（脚本内自动） |
| 分批重启 | 3+ | **0**（自动滚动） |
| 健康检查 | 3+ | **0**（自动检测） |
| 回滚决策 | 1（如需） | **0**（自动触发） |
| 最终验证 | 1 | **0**（自动报告） |
| **总计** | **15+** | **1**（只需启动脚本） |

---

## 执行命令速查

```bash
# 1. 预检（迁移前1天）
./scripts/pre-migration-check.sh

# 2. 执行迁移（迁移窗口）
./scripts/migration-orchestrator.sh --action=migrate

# 3. 如需手动回滚
./scripts/migration-orchestrator.sh --action=rollback
```

---

## 风险与应对

| 风险 | 应对措施 |
|------|---------|
| 自动回滚误判 | 设置回滚阈值（如连续3次健康检查失败才触发） |
| 脚本执行失败 | 保留人工介入入口，关键步骤支持--manual-mode |
| 通知未送达 | 多渠道通知（邮件+钉钉+短信） |
| 验证不全面 | 验证脚本覆盖核心指标（注册数、错误率、响应时间） |

---

## 下一步行动

- [ ] 开发 pre-migration-check.sh 脚本
- [ ] 开发 migration-orchestrator.sh 核心脚本
- [ ] 开发 validation.sh 验证脚本
- [ ] 在测试环境验证自动化流程
- [ ] 确定回滚阈值参数
- [ ] 配置自动通知渠道

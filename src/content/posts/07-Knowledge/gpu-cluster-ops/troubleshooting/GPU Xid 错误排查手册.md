---
date: 2026-06-29
tags:
  - gpu
  - troubleshooting
  - xid
  - ecc
type: 参考手册
category: GPU集群运维/故障排查
source: NVIDIA Xid Error 文档 + 实战经验
difficulty: 高级
title: "GPU Xid 错误排查手册"
---

# GPU Xid 错误排查手册

> GPU 硬件与驱动错误的实操诊断手册。覆盖 Xid Error 全量分类、诊断决策树、自动监控告警、RMA 流程。面向 AI Infra 值班工程师，目标是 **5 分钟内定位根因，15 分钟内给出处理方案**。

---

## 1. 什么是 Xid Error

Xid Error 是 NVIDIA GPU 在遇到硬件异常、驱动错误或固件故障时，由 GPU 内部微控制器上报的错误码。每个 Xid 是唯一的错误编码，直接指示故障类型和严重程度。

### 1.1 从哪里看 Xid

| 来源 | 命令/位置 | 说明 |
|------|-----------|------|
| **dmesg** | `dmesg -T \| grep -i xid` | 内核日志，最直接的 Xid 来源，包含时间戳 |
| **nvidia-smi** | `nvidia-smi -q -d XID` | 查询当前活跃和历史的 Xid 错误 |
| **DCGM** | `dcgmi diag -r 3` | DCGM 内置诊断，Level 3 包含 Xid 检查 |
| **syslog** | `/var/log/syslog` 或 `journalctl` | 系统级日志，记录 GPU 驱动层事件 |
| **nvidia-bug-report** | `nvidia-bug-report.sh` | 生成完整诊断包（含 Xid + ECC + PCIe 拓扑），**RMA 必需** |

### 1.2 Xid 的生命周期

```
应用运行 → GPU 硬件/驱动异常 → 微控制器捕获 → Xid 写入寄存器
    → 驱动读取 Xid → 记录到 dmesg/kernel log
    → nvidia-smi 可查询（活跃/历史）
    → DCGM 采集 → Prometheus 告警
```

关键特性：
- **Xid 是累加的**：重置 GPU 或重启节点前不会自动清零
- **一个故障可能产生多个 Xid**：例如显存 UE 可能同时触发 Xid 48 和 Xid 95
- **Xid 不等于 GPU 一定坏**：部分 Xid（63, 92）只是预警信号

---

## 2. Xid Error 分类总表

### 2.1 硬件致命错误 — 需立即处理

| Xid | 名称 | 严重度 | 典型根因 | 处理动作 |
|-----|------|--------|----------|----------|
| **13** | Graphics Engine Exception | 🔴 Critical | GPU 图形/计算引擎硬件故障 | `nvidia-smi -r` 重置；复现则 RMA |
| **31** | GPU Memory Page Fault | 🔴 Critical | 显存访问越界、显存物理损坏 | 检查 `dmesg` 确认 VA 地址；降级使用或 RMA |
| **43** | GPU Stopped Processing | 🔴 Critical | GPU 掉卡（PCIe 链路断、供电异常、过热保护） | 检查物理连接、PSU、散热；大概率 RMA |
| **45** | Preemptive Cleanup | 🔴 Critical | 同 Xid 43，驱动在 GPU 完全掉卡前预清理 | 处理方式同 Xid 43 |
| **48** | Double Bit ECC Error | 🔴 Critical | 显存发生不可纠正的双比特错误 | 退役坏页；持续复现则 RMA |
| **61** | Internal MCU Error | 🔴 Critical | GPU 内部微控制器异常 | 升级固件；复现则 RMA |
| **62** | Internal MCU Halt | 🔴 Critical | 微控制器停摆，GPU 基本不可用 | RMA，不可恢复 |
| **69** | MME Exception | 🔴 Critical | 多媒体引擎（MME）硬件故障 | 判定是否影响训练；持续则 RMA |
| **74** | NVLink Error (Non-Recoverable) | 🔴 Critical | NVLink 硬件链路严重错误 | `nvidia-smi nvlink -e` 查错误计数；换槽/换卡 |
| **79** | GPU Fallen Off Bus (Blackwell) | 🔴 Critical | Blackwell 架构特有掉卡 | 检查 Blackwell 特定的固件版本；标准掉卡流程 |
| **94** | Uncontained ECC Error | 🔴 Critical | ECC 错误扩散至运行中的应用 | 检查 `dmesg` 确认影响范围；退役坏页 → 降级/RMA |
| **95** | Uncorrectable ECC (Contained) | 🔴 Critical | 不可纠正 ECC，但错误被控制在受影响进程内 | 退役坏页；同一 GPU 多次触发则 RMA |
| **109** | Uncorrectable NVLink Error | 🔴 Critical | NVLink CRC/协议错误超过纠错能力 | 检查 NVSwitch 状态；换 NVLink 桥接器或 GPU |
| **120** | NVLink Fatal Error | 🔴 Critical | NVLink 不可恢复致命错误 | 重启 FabricManager + 重置 GPU；复现则 RMA |

### 2.2 驱动/软件预警 — 监控趋势

| Xid | 名称 | 严重度 | 典型根因 | 处理动作 |
|-----|------|--------|----------|----------|
| **32** | Invalid Push Buffer | 🟡 Warning | CUDA 应用提交了非法命令流 | 检查 CUDA 版本兼容性；回滚最近更新的应用 |
| **37** | Power Supply Issue | 🟡 Warning | GPU 供电不足或 PSU 不稳定 | 检查 PSU 功率、12V 电压波动；确认电源线缆连接 |
| **63** | ECC Page Retirement (SBE) | 🟡 Warning | 单比特 ECC 超过阈值，退役该显存页 | 监控 retired pages 增长趋势；**不紧急** |
| **64** | ECC Page Retirement (DBE) | 🟡 Warning | 双比特 ECC 导致退役 | 比 Xid 63 严重；监控增长；考虑预防性更换 |
| **68** | Video Processor Exception | 🟡 Warning | 视频编解码引擎异常 | 训练任务通常不受影响；渲染/视频流水线需关注 |
| **92** | High SBE Rate | 🟡 Warning | 单比特 ECC 速率过高 | 评估退役页数量；SBE 超 100/hour 视为高风险 |
| **119** | NVLink Recovery | 🔵 Info | NVLink 错误已被硬件自动恢复 | 记录次数；频繁出现（>10 次/小时）需排查链路 |

### 2.3 Xid 速查决策表

```
看到 Xid → 先判断大类 → 再定处理优先级

🔴 Critical (13,31,43,45,48,61,62,69,74,79,94,95,109,120)
    → 立即排查 → 判断是否影响在跑任务 → 隔离节点 → 准备 RMA

🟡 Warning (32,37,63,64,68,92)
    → 记录趋势 → 评估风险 → 非紧急但需关注

🔵 Info (119)
    → 仅记录 → 量变引起质变时升级
```

---

## 3. 关联错误类型

Xid 不是独立的现象，需要与其他错误信号联动判断。

### 3.1 ECC Error：SBE vs DBE

| 维度 | SBE (Single Bit Error) | DBE (Double Bit Error) |
|------|------------------------|------------------------|
| **可纠正性** | GPU 硬件自动纠正 | 不可纠正 |
| **影响** | 对应用透明，无性能影响 | 导致应用崩溃或数据损坏 |
| **关联 Xid** | Xid 63, 92 | Xid 48, 64, 94, 95 |
| **退役策略** | 累积到阈值后退役 | 立即退役 |
| **RMA 阈值** | SBE > 1000/hour 或 retired pages > 64 页 | 任何 DBE 持续出现 |

```bash
# 查看 ECC 错误
nvidia-smi -q -d ECC

# 关键指标解读
# Volatile SBE: 本次启动后的 SBE 计数
# Aggregate SBE: 全生命周期的 SBE 计数
# Volatile DBE: 本次启动后的 DBE 计数——任何 > 0 都需排查

# DCGM 采集 ECC 指标
DCGM_FI_DEV_ECC_SBE_VOL_TOTAL      # 易失性 SBE 总数（本次启动后）
DCGM_FI_DEV_ECC_DBE_VOL_TOTAL      # 易失性 DBE 总数
DCGM_FI_DEV_ECC_SBE_AGG_TOTAL      # 累计 SBE（含历史）
DCGM_FI_DEV_ECC_DBE_AGG_TOTAL      # 累计 DBE
DCGM_FI_DEV_RETIRED_SBE            # 因 SBE 退役的页数
DCGM_FI_DEV_RETIRED_DBE            # 因 DBE 退役的页数
DCGM_FI_DEV_ROW_REMAP_PENDING      # 待重映射行数
DCGM_FI_DEV_ROW_REMAP_FAILURE      # 重映射失败数
```

### 3.2 NVLink Error

NVLink 错误通常伴随 NCCL 通信故障，是分布式训练中最高频的硬件故障之一。

```bash
# 查看 NVLink 状态（最重要的一条命令）
nvidia-smi nvlink -s          # 活跃/非活跃链路
nvidia-smi nvlink -e          # 每条链路的错误计数
nvidia-smi nvlink -c          # CRC 错误计数

# NVLink 卡故障征兆：
# - 部分链路显示 InActive，但硬件连接正常
# - CRC Error 持续增长
# - nvidia-smi topo -m 显示 NVLink 拓扑异常
```

关联 Xid：74（不可恢复）、109（不可纠正）、119（已恢复）、120（致命）。

**处理优先级**：Xid 120 > Xid 74 > Xid 109 > Xid 119（仅观察）。

### 3.3 Thermal Throttling（热节流）

热节流虽不直接产生 Xid，但可能是 Xid 43/79（掉卡）的前兆。

```bash
# 查看是否触发热节流
nvidia-smi -q -d TEMPERATURE

# 关注字段
# GPU Current Temp           — 当前温度
# GPU Slowdown Temp          — 开始降频的门槛温度
# GPU Shutdown Temp          — 触发关断的温度（通常 ~95°C）
# GPU Max Operating Temp     — 最大允许工作温度
```

**告警阈值建议**：
- GPU 温度 > 80°C：Warning，检查机房冷却
- GPU 温度 > 85°C：Critical，考虑迁移任务
- 热节流触发：Immediate，立即排查散热

---

## 4. 诊断决策树

按优先级执行，不跳步。

```
┌──────────────────────────────────────┐
│  Step 1: 发现 Xid Error              │
│  dmesg 或 nvidia-smi 告警           │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  Step 2: 确认 Xid 编号和 GPU Index  │
│  dmesg -T | grep -i xid | tail -20  │
│  nvidia-smi -q -d XID               │
└──────────┬───────────────────────────┘
           │
     ┌─────┼─────┐
     ▼           ▼
┌─────────┐  ┌─────────────────┐
│ 13/43/  │  │ 48/94/95/63/64  │
│ 45/61/  │  │   (ECC 类)      │
│ 62/69/  │  └───────┬─────────┘
│ 79      │          │
│(掉卡/硬 │          ▼
│件损坏)  │  ┌──────────────────┐
└────┬────┘  │ nvidia-smi -q    │
     │       │ -d ECC           │
     │       │ -d RETIRED       │
     │       └───────┬──────────┘
     │               │
     ▼               ▼
┌──────────────┐  ┌────────────────────┐
│ 检查物理状态 │  │ 评估退役页数量     │
│ • 供电       │  │ • < 10 页: 观察   │
│ • 散热       │  │ • 10-64 页: 降级  │
│ • PCIe 金手指│  │ • > 64 页: RMA    │
│ • 尝试重置   │  │ • 有 DBE: 立即RMA │
│ nvidia-smi   │  └────────────────────┘
│ -r -i <ID>   │
└──────┬───────┘
       │
       ▼
┌──────────────────┐     ┌─────────────────────┐
│ 重置后恢复？     │     │ 74/109/119/120      │
│ YES → 监控观察   │     │   (NVLink 类)       │
│ NO → 隔离 + RMA  │     └──────────┬──────────┘
└──────────────────┘                │
                 ┌──────────────────┘
                 ▼
    ┌────────────────────────────┐
    │ nvidia-smi nvlink -s       │
    │ nvidia-smi nvlink -e       │
    │ + FabricManager 日志       │
    └────────────┬───────────────┘
                 │
          ┌──────┼──────┐
          ▼             ▼
    ┌──────────┐  ┌──────────────┐
    │链路 Down │  │ CRC Error    │
    │→ 换槽/换 │  │ 持续增长    │
    │ NVLink   │  │ → 降级/RMA  │
    │ Bridge   │  └──────────────┘
    └──────────┘

┌──────────────────────────────────────────┐
│  Step 3: 收集证据（无论结果如何）        │
│  nvidia-bug-report.sh                    │
│  dmesg > /tmp/xid-dmesg-$(hostname).log  │
│  journalctl -u nvidia-fabricmanager      │
│      --since "1 hour ago"                │
│      > /tmp/fabricmgr-$(hostname).log    │
└──────────────────────────────────────────┘
```

---

## 5. 实战命令速查

### 5.1 基础诊断三连

```bash
# 1. 快速定位 Xid
dmesg -T | grep -i "xid\|nvidia" | tail -30

# 2. GPU 健康状态一览
nvidia-smi -q -d HEALTH

# 3. 完整 GPU 状态快照
nvidia-smi -q -a | tee /tmp/gpu-snapshot-$(hostname)-$(date +%Y%m%d-%H%M).log
```

### 5.2 Xid 专项查询

```bash
# 只查 Xid 错误（最轻量）
nvidia-smi -q -d XID

# 输出示例解读：
#   Xid Errors
#       Xid                      : N/A (当前无活跃 Xid)
#       Xid Domain               : Graphics Engine
#       Xid Raw                  : 13  ← 最近一次 Xid

# 配合 grep 批量检查集群
for node in node{01..32}; do
  ssh $node "nvidia-smi -q -d XID | grep -A1 'Xid'" &
done
wait
```

### 5.3 ECC 与退役页诊断

```bash
# ECC 错误详情
nvidia-smi -q -d ECC

# 退役页清单
nvidia-smi -q -d RETIRED

# 退役页阈值判断脚本
GPU_INDEX=0
RETIRED=$(nvidia-smi -i $GPU_INDEX -q -d RETIRED | grep "Retired" | awk '{print $NF}')
if [ "$RETIRED" -gt 64 ]; then
  echo "CRITICAL: GPU $GPU_INDEX has $RETIRED retired pages → RMA recommended"
elif [ "$RETIRED" -gt 10 ]; then
  echo "WARNING: GPU $GPU_INDEX has $RETIRED retired pages → monitor closely"
else
  echo "OK: GPU $GPU_INDEX has $RETIRED retired pages"
fi
```

### 5.4 NVLink 诊断

```bash
# 链路状态（Active/InActive）
nvidia-smi nvlink -s

# 错误计数器（重点看非零值）
nvidia-smi nvlink -e

# CRC 错误（链路质量信号）
nvidia-smi nvlink -c

# 对于 NVSwitch 系统，额外检查 FabricManager
systemctl status nvidia-fabricmanager
journalctl -u nvidia-fabricmanager --since "30 min ago" | grep -i "error\|fail\|xid"

# NVSwitch 本身也是设备，可以用 nvidia-smi 查看
nvidia-smi nvswitch -q
```

### 5.5 dmesg Xid 提取

```bash
# 提取最后 100 条 NVRM/Xid 相关日志
dmesg -T | grep -E "NVRM|Xid" | tail -100

# 提取特定 GPU 的 Xid（按 PCIe BDF 地址）
dmesg -T | grep "0000:17:00.0" | grep -i xid

# 统计历史 Xid 分布
dmesg -T | grep "Xid" | awk -F'Xid' '{print $2}' | awk '{print $1}' | \
  sort -n | uniq -c | sort -rn

# 输出示例：
#   3 48    ← 3 次 DBE
#   1 92    ← 1 次高 SBE 速率
#  12 119   ← 12 次 NVLink 恢复（需关注链路质量）
```

### 5.6 DCGM 诊断

```bash
# DCGM Level 3（含 Xid + PCIe + 内存诊断）
dcgmi diag -r 3

# 只跑 Xid 检查
dcgmi diag -r 3 -i 0  # 只测 GPU 0

# 输出解读：
# | Diagnostic                | Result            |
# |---------------------------|-------------------|
# | Software                  | Pass              |
# | Memory                    | Pass              |  ← 通过
# | Memory                    | Fail              |  ← 显存有问题
# | PCIe                      | Pass              |

# DCGM 健康状态
dcgmi health -s a          # 查看所有 GPU 健康状态
dcgmi health -c            # 查看当前健康告警
```

---

## 6. 自动化监控与告警

### 6.1 DCGM Exporter + Prometheus 告警规则

以下规则直接用于生产环境，按严重程度分级。

```yaml
# prometheus-rules-xid.yaml

groups:
  - name: gpu_xid_alerts
    interval: 30s
    rules:

      # === 致命级别：立即告警 ===

      - alert: GPUXidCriticalError
        expr: |
          increase(DCGM_FI_DEV_XID_ERRORS{error_code=~"13|31|43|45|48|61|62|69|74|79|94|95|109|120"}[5m]) > 0
        for: 1m
        labels:
          severity: critical
          category: gpu-hardware
        annotations:
          summary: "GPU {{ $labels.gpu }} on {{ $labels.node }} — Xid {{ $labels.error_code }} (Critical)"
          description: |
            GPU {{ $labels.gpu }} ({{ $labels.node }}) 产生致命 Xid {{ $labels.error_code }}。
            处理流程：
            1. SSH 到节点 → dmesg -T | grep Xid
            2. nvidia-bug-report.sh 收集证据
            3. 隔离节点 / 准备 RMA
          runbook_url: "[[GPU Xid 错误排查手册]]#4-诊断决策树"

      # === 警告级别：趋势监控 ===

      - alert: GPUXidWarningError
        expr: |
          increase(DCGM_FI_DEV_XID_ERRORS{error_code=~"32|37|63|64|68|92"}[10m]) > 0
        for: 5m
        labels:
          severity: warning
          category: gpu-driver
        annotations:
          summary: "GPU {{ $labels.gpu }} on {{ $labels.node }} — Xid {{ $labels.error_code }} (Warning)"
          description: |
            监控 GPU {{ $labels.gpu }} 的 Xid {{ $labels.error_code }} 趋势。
            超过 24h 未复现可关闭。频繁触发需升级为 critical。

      - alert: GPUHighSBERate
        expr: |
          rate(DCGM_FI_DEV_ECC_SBE_VOL_TOTAL[5m]) * 3600 > 100
        for: 5m
        labels:
          severity: warning
          category: gpu-ecc
        annotations:
          summary: "GPU {{ $labels.gpu }} SBE rate > 100/hour"
          description: |
            单比特 ECC 速率超过 100/hour，评估更换。当前速率: {{ $value | humanize }}/hour

      - alert: GPUDBEDetected
        expr: |
          increase(DCGM_FI_DEV_ECC_DBE_VOL_TOTAL[5m]) > 0
        for: 1m
        labels:
          severity: critical
          category: gpu-ecc
        annotations:
          summary: "GPU {{ $labels.gpu }} — DBE detected (不可纠正 ECC)"
          description: |
            GPU {{ $labels.gpu }} 检测到双比特错误。立即退役坏页，评估 RMA。

      - alert: GPURowRemapFailure
        expr: DCGM_FI_DEV_ROW_REMAP_FAILURE > 0
        for: 1m
        labels:
          severity: critical
          category: gpu-memory
        annotations:
          summary: "GPU {{ $labels.gpu }} — row remap failure"
          description: "显存行重映射失败，GPU 的 ECC 自愈能力耗尽，建议 RMA。"

      # === NVLink 专项监控 ===

      - alert: NVLinkFatalError
        expr: |
          increase(DCGM_FI_DEV_XID_ERRORS{error_code=~"74|120"}[5m]) > 0
        for: 1m
        labels:
          severity: critical
          category: gpu-nvlink
        annotations:
          summary: "GPU {{ $labels.gpu }} — NVLink 致命错误 Xid {{ $labels.error_code }}"
          description: "NVLink 硬件层不可恢复错误。检查链路状态，准备 RMA。"
```

### 6.2 自动修复思路

以下脚本可根据告警自动执行初步修复操作。**建议先人工确认，再逐步放权给自动化**。

```bash
#!/bin/bash
# auto-xid-handler.sh — Xid 自动处理脚本
# 建议由告警系统回调触发，传入 GPU_INDEX 和 XID_CODE

GPU_INDEX="${1:?Usage: $0 <GPU_INDEX> <XID_CODE>}"
XID_CODE="${2:?}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a /var/log/gpu-xid-handler.log; }

isolate_gpu() {
  local gpu=$1
  log "Isolating GPU $gpu: draining K8s node and cordoning"
  # 1. 驱逐 GPU $gpu 上的 Pod（需配合 K8s Device Plugin 的 allocatable 标记）
  # kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data
  # 2. 标记 GPU 不可调度（通过修改 Device Plugin 配置）
  log "GPU $gpu isolated. Manual RMA required."
}

reset_gpu() {
  local gpu=$1
  log "Attempting GPU $gpu soft reset..."
  nvidia-smi -r -i "$gpu"
  sleep 5
  if nvidia-smi -i "$gpu" &>/dev/null; then
    log "GPU $gpu reset successful"
    return 0
  else
    log "GPU $gpu reset failed"
    return 1
  fi
}

case "$XID_CODE" in
  13|31|43|45|79)
    log "Xid $XID_CODE on GPU $GPU_INDEX — hardware fault, attempting reset"
    if ! reset_gpu "$GPU_INDEX"; then
      isolate_gpu "$GPU_INDEX"
    fi
    ;;
  48|62|74|94|95|120)
    log "Xid $XID_CODE on GPU $GPU_INDEX — fatal, immediate isolation"
    isolate_gpu "$GPU_INDEX"
    ;;
  63|92)
    log "Xid $XID_CODE on GPU $GPU_INDEX — monitoring only, no immediate action"
    ;;
  *)
    log "Xid $XID_CODE on GPU $GPU_INDEX — unhandled, manual investigation required"
    ;;
esac
```

---

## 7. RMA 流程

### 7.1 何时发起 RMA

满足以下**任一**条件即可发起：

1. 🔴 Critical 类 Xid（13/31/43/45/48/61/62/69/74/79/94/95/109/120）在 `nvidia-smi -r` 重置后再次出现
2. DBE (Double Bit Error) 持续出现，累积 retired pages > 64 页
3. Row Remap Failure 发生
4. NVLink 链路持续 Down，排除 NVSwitch/桥接器问题后仍不可用
5. GPU 温度正常但频繁触发 throttling

### 7.2 证据收集 Checklist

向 NVIDIA 或 OEM 厂商提交 RMA 时，以下材料**缺一不可**：

```bash
# === 必须项 ===

# 1. nvidia-bug-report（包含所有诊断信息）
nvidia-bug-report.sh
# 生成 nvidia-bug-report.log.gz

# 2. dmesg 完整输出
dmesg -T > /tmp/rma-dmesg-$(hostname)-$(date +%Y%m%d).log

# 3. nvidia-smi 完整输出
nvidia-smi -q -a > /tmp/rma-smi-$(hostname)-$(date +%Y%m%d).log

# === 推荐项 ===

# 4. Xid 历史（带时间戳）
dmesg -T | grep -E "NVRM|Xid" > /tmp/rma-xid-history-$(hostname).log

# 5. GPU 序列号和 VBIOS 版本
nvidia-smi -q | grep -E "Serial|VBIOS|Board|UUID"

# 6. 驱动版本
nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1

# 7. DCGM 诊断结果
dcgmi diag -r 3 > /tmp/rma-dcgm-$(hostname).log

# 8. 复现步骤描述（人写的，越详细越好）
#    - 触发时的负载类型（训练/推理/空闲）
#    - 是否可稳定复现
#    - nvidia-smi -r 后是否恢复
```

### 7.3 RMA 提交流程

```
1. 收集证据 → 按 7.2 清单打包
2. 内部确认 → 对照本手册确认属于硬件故障，排除驱动/配置问题
3. 开 Ticket → NVIDIA Enterprise Support 或 OEM 厂商（Dell/HPE/Supermicro等）
4. 附带信息：
   - GPU 序列号、Part Number
   - 服务器型号和 BMC 日志（如有）
   - 问题首次出现时间
   - 驱动版本和固件版本
5. 等待审批 → 通常 1-3 个工作日
6. 收到 RMA 编号 → 安排换卡
7. 换卡后验证：
   - dcgmi diag -r 3（Level 3 诊断）
   - nccl-tests all_reduce_perf（通信验证）
   - 72 小时 burn-in 测试
```

### 7.4 RMA 期间集群处理

- **单卡 RMA**：将节点标记为 `NoSchedule`，保留其余 GPU 可用（如果有 GPU-level scheduling）
- **多卡/整机 RMA**：drain 节点 → cordon → 移出调度池
- **紧急换卡**：如有冷备件，优先本地更换 → 事后补 RMA

---

## 8. 关联知识

- [[NCCL 通信故障诊断指南]]
- [[../monitoring/DCGM 监控体系详解]]
- [[../hardware/NVLink 与 NVSwitch 拓扑详解]]
- [[../automation/GPU 驱动与固件管理]] — 驱动与故障关联
- [[../GPU 集群运维知识总览]] — 返回总览

---

## 9. 参考资源

- [NVIDIA Xid Errors Documentation](https://docs.nvidia.com/deploy/xid-errors/index.html) — 官方 Xid 错误码定义
- [NVIDIA Data Center GPU RMA Process](https://docs.nvidia.com/datacenter/tesla/rma-policy/) — 官方 RMA 政策
- [DCGM User Guide](https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/) — 诊断与监控
- [NVIDIA GPU Debug Guidelines](https://docs.nvidia.com/deploy/gpu-debug-guidelines/index.html)

---

## 10. 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 框架搭建 | 2026-06-29 | 骨架创建 |
| 全面重写 | 2026-06-30 | 补充全量 Xid 表、诊断决策树、DCGM 告警、RMA 流程 |

---

## 11. 状态标记

| 状态 | 内容 |
|------|------|
| 📖 已掌握 | Xid Error 全量分类与严重度判断、nvidia-smi / dmesg 诊断三连、ECC SBE vs DBE 区分、NVLink 链路状态检查、DCGM Level 3 诊断、RMA 证据收集 Checklist |
| 📝 待补充 | Blackwell 架构 Xid 79 具体差异、H100/H200 Xid 119 误报案例、多供应商 RMA 差异化流程、Xid 31 与 CUDA 应用内存越界的关联诊断、DCGM 误报 Xid 的滤波策略、Xid + NCCL Hang 交叉诊断流程 |

---
date: 2026-06-29
tags:
  - gpu
  - driver
  - firmware
  - automation
  - gpu-operator
type: 学习笔记
category: GPU集群运维/自动化
source: NVIDIA 官方文档 + 实战经验
difficulty: 进阶
title: "GPU 驱动与固件管理"
---

# GPU 驱动与固件管理

> GPU 集群中驱动、CUDA、固件的完整生命周期管理。涵盖版本兼容矩阵、安装方式对比、GPU Operator 管理、固件升级策略、回滚方案和自动化验证。

## 1. NVIDIA 驱动栈架构

```
应用层        PyTorch / TensorFlow / vLLM / TensorRT-LLM
              ↑ 链接
库层          cuDNN / NCCL / cuBLAS / cuSPARSE / TensorRT
              ↑ 依赖 CUDA Runtime
运行时层      CUDA Toolkit (nvcc, libcudart, cufft, cublas...)
              ↑ 加载
用户态驱动    libcuda.so (CUDA User-Mode Driver)
              ↑ ioctl 系统调用 (配套的内核模块版本)
内核态驱动    nvidia.ko, nvidia-modeset.ko, nvidia-uvm.ko,
              nvidia-drm.ko, nvidia-peermem.ko
              ↑ 操作
固件层        GPU VBIOS / NVSwitch FW / GSP Firmware
```

### 三层驱动详解

| 层 | 组件 | 职责 | 版本格式 |
|----|------|------|---------|
| **内核态** | `nvidia.ko` | GPU 设备枚举、MMIO、中断、DMA | 驱动版本号 (如 550.90.07) |
| **内核态** | `nvidia-uvm.ko` | Unified Virtual Memory 管理 | 与驱动匹配 |
| **内核态** | `nvidia-modeset.ko` | 显示模式管理 | 同驱动 |
| **内核态** | `nvidia-peermem.ko` | GPUDirect RDMA peer memory | 同驱动 |
| **用户态** | `libcuda.so` | CUDA Driver API、上下文管理 | 与内核模块捆绑 |
| **运行时** | CUDA Toolkit | `nvcc`、cuBLAS、cuFFT 等库 | 如 12.4 |
| **固件** | GSP Firmware | GPU System Processor，功耗/散热管理 | 按 GPU 代际 |

📖 已掌握

---

## 2. 驱动安装方式对比

### 三种方式

```bash
# 方式 1: NVIDIA 官方 runfile (裸金属推荐)
wget https://us.download.nvidia.com/XFree86/Linux-x86_64/550.90.07/NVIDIA-Linux-x86_64-550.90.07.run
chmod +x NVIDIA-Linux-x86_64-550.90.07.run
# 安装参数说明:
./NVIDIA-Linux-x86_64-550.90.07.run \
    --no-questions \
    --ui=none \
    --disable-nouveau \
    --kernel-source-path=/usr/src/linux-headers-$(uname -r) \
    --dkms                          # 安装 dkms 模块，内核升级后自动重建
```

```bash
# 方式 2: 发行版包管理器 (Ubuntu 为例)
apt update
apt install -y nvidia-driver-550 nvidia-utils-550
# 或 CUDA 仓库安装
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb
dpkg -i cuda-keyring_1.1-1_all.deb
apt update
apt install -y cuda-toolkit-12-4 nvidia-driver-550
```

```bash
# 方式 3: NVIDIA GPU Operator (K8s 环境推荐)
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update
helm install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --set driver.version=550.90.07 \
  --set driver.enabled=true
```

### 方式对比

| 方式 | 适用场景 | 优势 | 劣势 |
|------|---------|------|------|
| **runfile** | 裸金属/非 K8s | 精确控制版本 | 无自动更新 |
| **.deb/.rpm** | 单机/小集群 | 系统包管理集成 | 版本可能滞后 |
| **GPU Operator** | K8s 集群 | 统一管理/自动维护 | 需 K8s 前置 |

📖 已掌握

---

## 3. GPU Operator 深入

### 架构与组件

```
┌─ GPU Operator Helm Chart ───────────────────────────┐
│                                                       │
│  ┌─ Driver Controller ─┐  ┌─ Toolkit Controller ─┐   │
│  │ 管理 nvidia.ko       │  │ 管理 nvidia-container  │   │
│  │ DaemonSet 安装驱动   │  │ -toolkit DaemonSet     │   │
│  └──────────────────────┘  └───────────────────────┘  │
│  ┌─ Device Plugin ─────┐  ┌─ DCGM Exporter ───────┐  │
│  │ 暴露 GPU 资源给 K8s  │  │ Prometheus 指标采集    │  │
│  └──────────────────────┘  └───────────────────────┘  │
│  ┌─ MIG Manager ───────┐  ┌─ VFIO Manager ────────┐  │
│  │ MIG 分区管理         │  │ GPU 直通/VFIO 配置     │  │
│  └──────────────────────┘  └───────────────────────┘  │
│  ┌─ Sandbox Validator ─┐  ┌─ GFD ─────────────────┐  │
│  │ GPU 健康检查验证     │  │ GPU Feature Discovery  │  │
│  └──────────────────────┘  └───────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

### 关键 Helm Values

```yaml
# values-prod.yaml — 生产环境 GPU Operator 配置
driver:
  enabled: true
  version: "550.90.07"
  repository: nvcr.io/nvidia
  image: driver
  # 关键：禁用自动升级，避免风暴
  upgradePolicy:
    autoUpgrade: false
    maxParallelUpgrades: 1        # 同时升级节点数
  # 驱动安装时的内核编译参数
  env:
    - name: NVIDIA_DRIVER_VERSION
      value: "550.90.07"

operator:
  defaultRuntime: containerd       # 或 crio
  initContainer:
    repository: nvcr.io/nvidia

toolkit:
  enabled: true
  env:
    - name: CONTAINERD_CONFIG
      value: /etc/containerd/config.toml
    - name: CONTAINERD_SOCKET
      value: /run/containerd/containerd.sock

devicePlugin:
  enabled: true
  config:
    name: time-slicing-config     # 或 mig-config
    default: default

dcgmExporter:
  enabled: true
  serviceMonitor:
    enabled: true                 # Prometheus Operator

migManager:
  enabled: true
  config:
    name: default-mig-config

gfd:
  enabled: true                   # GPU Feature Discovery

# 节点选择器：只对 GPU 节点生效
nodeSelector:
  nvidia.com/gpu.present: "true"
```

### GPU Operator 驱动升级流程

```bash
# 1. 更新 Helm values 中的驱动版本
helm upgrade gpu-operator nvidia/gpu-operator \
  -n gpu-operator \
  --reuse-values \
  --set driver.version=550.127.05

# 2. 观察升级进度
kubectl get pods -n gpu-operator -w

# 3. 检查节点驱动版本
kubectl get nodes -o json | jq '.items[] | {
  name: .metadata.name,
  driver: .status.nodeInfo.kernelVersion,
  gpu: .metadata.labels["nvidia.com/gpu.product"]
}'

# 4. 节点上验证
nvidia-smi --query-gpu=driver_version --format=csv
```

📖 已掌握

---

## 4. CUDA 兼容性详解

### CUDA 兼容性规则

```
Forward Compatibility (向前兼容):
  旧驱动 + 新 CUDA Toolkit → ❌ 通常不行
  新驱动 + 旧 CUDA Toolkit → ✅ 通常可以 (Minor Version Compatibility)

Backward Compatibility (向后兼容):
  CUDA 11.x 编译的程序 → ✅ 在 CUDA 12.x 驱动上运行 (需重新编译或使用兼容包)
  CUDA 12.x 编译的程序 → ❌ 在 CUDA 11.x 驱动上运行
```

### 最低驱动版本要求

```
CUDA 版本     最低驱动版本      推荐驱动版本
─────────────────────────────────────────────
CUDA 11.0     ≥ 450.36.06       525.x / 535.x
CUDA 11.8     ≥ 520.61.05       525.x / 535.x / 545.x
CUDA 12.0     ≥ 525.60.13       535.x / 545.x
CUDA 12.1     ≥ 530.30.02       535.x / 545.x / 550.x
CUDA 12.2     ≥ 535.54.03       545.x / 550.x
CUDA 12.3     ≥ 545.23.06       550.x
CUDA 12.4     ≥ 550.54.14       550.x / 555.x / 560.x
CUDA 12.5     ≥ 555.42.02       555.x / 560.x / 565.x
CUDA 12.6     ≥ 560.35.03       560.x / 565.x / 570.x
CUDA 12.8     ≥ 570.80+         570.x / 575.x
```

### Driver API vs Runtime API 版本

```bash
# Driver API 版本（内核模块决定）
nvidia-smi --query-gpu=driver_version --format=csv,noheader

# CUDA Runtime 版本（容器/环境中的 Toolkit 版本）
nvcc --version
python -c "import torch; print(torch.version.cuda)"

# 容器中选择 CUDA 版本
docker run --gpus all nvcr.io/nvidia/pytorch:24.06-py3 \
  python -c "import torch; print(torch.version.cuda)"
# 输出: 12.4  ← Runtime API
```

### CUDA Minor Version Compatibility (MVC)

```bash
# 原理: CUDA 11+ 支持 Minor Version Compatibility
# CUDA 12.4 编译的程序可在 CUDA 12.5 驱动上运行（无需重新编译）
# 不跨大版本: CUDA 11.x → CUDA 12.x 不兼容

# 验证当前环境的 CUDA 兼容性
# 检查 CUDA Forward Compatibility 包
dpkg -l | grep cuda-compat
# 如果安装会显示: cuda-compat-12-4

# 容器中启用 MVC
docker run --gpus all \
  -e NVIDIA_REQUIRE_CUDA="cuda>=12.0" \
  nvcr.io/nvidia/cuda:12.4.0-runtime-ubuntu22.04 \
  nvidia-smi
```

📖 已掌握

---

## 5. 固件管理

### 固件清单与影响范围

```
┌─ 节点级固件 ────────────────────────────────────────┐
│                                                       │
│  GPU VBIOS         GPU 硬件初始化、电源管理、温度保护  │
│  GSP Firmware       GPU System Processor 固件          │
│  NVSwitch FW       NVSwitch 芯片固件 (NVSwitch 机型)  │
│  NIC Firmware       InfiniBand / RoCE 网卡固件         │
│  NVMe FW           本地 NVMe 固态硬盘固件              │
│  BMC/iDRAC         服务器带外管理固件 [各厂商不同]      │
│  BIOS/UEFI         系统主板固件                        │
│                                                       │
└───────────────────────────────────────────────────────┘
```

### GPU 相关固件更新命令

```bash
# 1. 查看当前 GPU VBIOS 版本
nvidia-smi --query-gpu=vbios_version --format=csv
nvidia-smi -q | grep -i vbios

# 2. NVIDIA Firmware Updater (nvfwupd)
# 列出所有可更新设备
nvfwupd -l
# 输出示例:
# GPU 0 (0000:1B:00.0):    VBIOS 96.00.74.00.01 → 96.00.A5.00.01
# NVSwitch 0:              FW 36.13.0 → 36.14.0

# 更新指定 GPU VBIOS (需要重启 GPU 或节点)
nvfwupd --update -d 0000:1b:00.0
nvfwupd --update -d 0000:1b:00.0 --force  # 跳过版本检查

# 3. NVSwitch 固件更新
nvfwupd --update-nvswitch
# 验证 NVSwitch 固件版本
nvidia-smi nvlink -s    # 查看 NVLink 状态
nvidia-smi nvlink -e    # 查看 NVLink 错误计数

# 4. GSP 固件管理
# GSP 固件随驱动包分发，位于:
ls /lib/firmware/nvidia/*/gsp/
# 驱动加载时自动选择匹配的 GSP 固件
cat /proc/driver/nvidia/gpus/*/information | grep -i gsp
```

### 网卡固件更新

```bash
# Mellanox/NVIDIA ConnectX 系列
# 查看固件版本
mlxfwmanager --query
# 更新网卡固件
mlxfwmanager -u -d 0000:01:00.0 -f fw-ConnectX7-rel-28_39_1002.mfa2

# 重启驱动使新固件生效
mlxfwreset -d 0000:01:00.0 reset

# InfiniBand HCA 固件查询
ibstat
hca_self_test.ofed
```

### BMC/iDRAC 固件 (厂商相关)

```bash
# Dell iDRAC
racadm getversion
racadm update -f firmware.d9

# HPE iLO
hponcfg -f ilo_config.xml

# Supermicro
ipmicfg -fru
ipmicfg -ver
```

📖 已掌握

---

## 6. 更新策略

### 更新策略对比

| 策略 | 风险 | 回滚速度 | 适用场景 |
|------|------|---------|---------|
| **金丝雀 (Canary)** | 低 | 快 | 所有生产集群 |
| **滚动更新 (Rolling)** | 中 | 中等 | 小集群 |
| **排空后更新 (Drain-before)** | 最低 | 慢 | 关键集群 |
| **全量更新 (All-at-once)** | 高 | 慢 | 非生产环境 |

### 生产环境标准流程

```
Phase 1: 准备
  ├── 确认当前集群状态（所有节点健康、无 Xid 错误）
  ├── 确认目标驱动/CUDA/固件版本兼容性
  ├── 准备回滚脚本和驱动包
  └── 通知用户计划维护窗口

Phase 2: 金丝雀测试 (1-2 节点)
  ├── 排空节点: kubectl drain <node> --ignore-daemonsets
  ├── 安装新驱动 → reboot
  ├── 运行验证套件（见第 7 节）
  ├── 运行代表性训练任务 (至少 2h)
  └── 观察 24-48h: Xid Error / ECC / 温度 / NCCL 性能

Phase 3: 分批滚动更新
  ├── 每批 ≤ 集群 20% (训练任务影响最小)
  ├── 每批间隔 ≥ 30min (观察窗口)
  ├── 排空 → 更新 → 验证 → 解除排空
  └── 监控告警：任何异常立即暂停，回滚受影响批次

Phase 4: 全集群验证
  ├── 所有节点 health check
  ├── 运行全量 NCCL 带宽测试
  └── 确认所有训练任务恢复正常
```

### 更新脚本框架

```bash
#!/bin/bash
# gpu-driver-update.sh — GPU 节点驱动更新（配合 K8s）
set -euo pipefail

NODE=${1:?"Usage: $0 <node-name>"}
NEW_DRIVER=${2:-"550.127.05"}

echo "=== 更新节点 ${NODE} 驱动至 ${NEW_DRIVER} ==="

# 1. 排空节点
echo "[Step 1] 排空节点..."
kubectl drain "${NODE}" --ignore-daemonsets --delete-emptydir-data --timeout=5m

# 2. 安装驱动 (通过 SSH 在目标节点执行)
echo "[Step 2] 安装驱动..."
ssh "${NODE}" "
    # 卸载旧驱动
    nvidia-smi && modprobe -r nvidia-drm nvidia-modeset nvidia-uvm nvidia
    # 安装新驱动
    ./NVIDIA-Linux-x86_64-${NEW_DRIVER}.run --no-questions --dkms
    # 加载模块
    nvidia-smi
"

# 3. 重启（驱动安装有时需要重启）
echo "[Step 3] 重启节点..."
ssh "${NODE}" "reboot" || true
sleep 120

# 4. 等待节点就绪
echo "[Step 4] 等待节点就绪..."
kubectl wait --for=condition=Ready node/"${NODE}" --timeout=10m

# 5. 验证
echo "[Step 5] 验证..."
./validate-gpu-node.sh "${NODE}"

# 6. 解除排空
echo "[Step 6] 解除排空..."
kubectl uncordon "${NODE}"

echo "=== 节点 ${NODE} 更新完成 ==="
```

### 回滚方案

```bash
# 回滚脚本
ROLLBACK_DRIVER="550.90.07"  # 已知稳定版本

# 1. 排空节点
kubectl drain <node> --ignore-daemonsets

# 2. 卸载当前驱动
ssh <node> "
    nvidia-uninstall --silent
    # 或手动清除残留
    apt purge nvidia-* || yum remove nvidia-*
"

# 3. 安装回滚版本
ssh <node> "./NVIDIA-Linux-x86_64-${ROLLBACK_DRIVER}.run --no-questions --dkms"

# 4. 重启并验证
ssh <node> "reboot"
# ... 等待 Ready ...
./validate-gpu-node.sh <node>
kubectl uncordon <node>
```

📖 已掌握

---

## 7. 更新后验证

### 完整验证脚本

```bash
#!/bin/bash
# validate-gpu-node.sh — GPU 节点更新后验证套件
set -euo pipefail
NODE=${1:?"Usage: $0 <node-name>"}

run_on_node() {
    ssh "${NODE}" "$@"
}

echo "========== GPU 节点验证 =========="
echo "节点: ${NODE}"
echo "时间: $(date)"

# 1. nvidia-smi 基础检查
echo "--- [1/6] nvidia-smi 基础检查 ---"
run_on_node "
nvidia-smi --query-gpu=index,name,driver_version,temperature.gpu,power.draw,utilization.gpu,memory.used --format=csv
GPU_COUNT=\$(nvidia-smi -L | wc -l)
echo \"检测到 \${GPU_COUNT} 张 GPU\"
if [ \${GPU_COUNT} -eq 0 ]; then echo 'ERROR: 未检测到 GPU'; exit 1; fi
"

# 2. CUDA 功能测试
echo "--- [2/6] CUDA 功能测试 ---"
run_on_node "
cat > /tmp/cuda_test.cu << 'EOF'
#include <stdio.h>
__global__ void hello() { printf(\"GPU says hello!\\n\"); }
int main() {
    hello<<<1,1>>>();
    cudaDeviceSynchronize();
    printf(\"CUDA test PASSED\\n\");
    return 0;
}
EOF
nvcc -o /tmp/cuda_test /tmp/cuda_test.cu && /tmp/cuda_test
"

# 3. GPU Burn 压力测试
echo "--- [3/6] GPU Burn 压力测试 ---"
run_on_node "
# 快速压力测试 (60s)
docker run --rm --gpus all nvcr.io/nvidia/cuda:12.4.0-devel-ubuntu22.04 \
    bash -c 'apt update && apt install -y git build-essential && \
    git clone https://github.com/wilicc/gpu-burn && \
    cd gpu-burn && make && ./gpu_burn 60'
"

# 4. DCGM 诊断
echo "--- [4/6] DCGM 诊断 ---"
run_on_node "
if command -v dcgmi &> /dev/null; then
    dcgmi diag -r 1  # Level 1 快速诊断
else
    echo 'DCGM 未安装，跳过诊断'
fi
"

# 5. NCCL 通信验证
echo "--- [5/6] NCCL 通信测试 ---"
run_on_node "
docker run --rm --gpus all --network host \
    nvcr.io/nvidia/pytorch:24.06-py3 \
    bash -c '
    git clone https://github.com/NVIDIA/nccl-tests.git /tmp/nccl-tests
    cd /tmp/nccl-tests && make MPI=1 -j
    # 单机 8 卡 all_reduce
    mpirun -np 8 --allow-run-as-root \
        ./build/all_reduce_perf -b 8 -e 128M -f 2 -g 1
    '
"

# 6. 检查内核日志与错误
echo "--- [6/6] 内核日志检查 ---"
run_on_node "
echo 'Recent NVRM messages:'
dmesg -T | grep -i nvrm | tail -20
echo ''
echo 'Xid errors:'
dmesg -T | grep -i 'xid' | tail -10 || echo 'No Xid errors found'
echo ''
echo 'ECC errors:'
nvidia-smi -q | grep -A5 'ECC Errors' | grep -v 'N/A'
"

echo "========== 验证完成 =========="
```

### 关键检查清单

```bash
# 必须通过的检查项
checklist=(
    "nvidia-smi 正常输出，GPU 数量正确"
    "CUDA sample 成功编译运行"
    "GPU Burn 60s 无错误"
    "DCGM diag Level 1 通过"
    "NCCL all_reduce 带宽 ≥ 预期值的 80%"
    "dmesg 无 NVRM 错误"
    "无 Xid Error（尤其是 31/43/45/48/119）"
    "无 ECC 错误增长"
    "GPU 温度 < 85°C"
    "Fabric Manager 运行正常 (NVSwitch 机型)"
    "nvidia-fabricmanager 服务状态 active"
)

for item in "${checklist[@]}"; do
    echo "  [ ] ${item}"
done
```

### 批量节点验证

```bash
# 并行验证所有 GPU 节点
for node in $(kubectl get nodes -l nvidia.com/gpu.present=true -o name | cut -d/ -f2); do
    echo "验证 ${node}..."
    ./validate-gpu-node.sh "${node}" > "logs/${node}_$(date +%Y%m%d).log" 2>&1 &
done
wait

# 汇总结果
echo "=== 验证结果汇总 ==="
grep -l "验证完成" logs/*.log | wc -l
echo "节点验证通过"
grep -L "验证完成" logs/*.log
echo "节点存在问题，需人工介入"
```

📖 已掌握

---

## 实用命令速查

```bash
# 驱动版本查询
nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1
modinfo nvidia | grep ^version

# VBIOS 版本
nvidia-smi --query-gpu=vbios_version --format=csv

# CUDA 版本（容器内）
nvcc --version 2>/dev/null || echo "nvcc not found"
python -c "import torch; print('PyTorch CUDA:', torch.version.cuda)"

# 驱动编译选项
cat /proc/driver/nvidia/version
lsmod | grep nvidia

# GPU Operator 状态
kubectl get pods -n gpu-operator
kubectl logs -n gpu-operator -l app=nvidia-driver-daemonset --tail=20

# 固件列表
nvfwupd -l
lspci -nn | grep -i nvidia

# ECC 错误
nvidia-smi -q -d ECC

# 内核模块参数
cat /proc/driver/nvidia/params
```

---

## 关联知识

- [[../scheduling/K8s GPU 调度机制详解]]
- [[../troubleshooting/GPU Xid 错误排查手册]]
- [[集群自动化部署方案]]
- [[../hardware/GPU 服务器硬件选型指南]]
- [[GPU 集群运维知识总览]]

## 参考资源

- [NVIDIA Driver Downloads](https://www.nvidia.com/en-us/drivers/unix/)
- [GPU Operator Documentation](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/)
- [CUDA Compatibility Guide](https://docs.nvidia.com/deploy/cuda-compatibility/)
- [NVIDIA Firmware Update Tool](https://docs.nvidia.com/deploy/gpu-firmware-update/index.html)

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 框架搭建 | 2026-06-29 | 骨架创建 |
| 深度填充 | 2026-06-30 | 七节核心内容 + 验证脚本 |

## 状态标记

📖 已掌握 — 驱动栈架构、三种安装方式对比、GPU Operator 组件与 Helm 配置、CUDA 兼容性规则与 MVC、GPU/NVSwitch/NIC 固件管理、金丝雀与滚动更新策略、更新验证套件

📝 待补充 — 各厂商 BMC (Dell iDRAC / HPE iLO / Supermicro BMC) 详细升级流程、大规模集群固件版本审计自动化、MOFED 版本与 GPU 固件交互影响、GPU Operator 自定义 Operator 扩展

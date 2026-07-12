---
date: 2026-06-30
tags:
  - gpu
  - hardware
  - server
  - infrastructure
  - dgx
type: 学习笔记
category: GPU集群运维/硬件
source: NVIDIA 官方文档 + 实际部署经验
difficulty: 进阶
title: "GPU 服务器硬件选型指南"
---

# GPU 服务器硬件选型指南

> GPU 服务器的选型不只是"配几张卡"的问题，而是需综合考虑 GPU 互联、CPU 配比、PCIe 拓扑、供电散热、网络带宽等因素的系统工程。

---

## 一、服务器形态对比

### 1.1 三种典型形态

```
┌───────────────┬──────────────────────┬─────────────────────┬──────────────────┐
│               │    DGX 整机          │   HGX 基板          │   白牌服务器       │
├───────────────┼──────────────────────┼─────────────────────┼──────────────────┤
│ 供应商         │ NVIDIA 原厂          │ NVIDIA + OEM        │ Supermicro/浪潮等  │
│ GPU 形态       │ SXM (基板焊死)       │ SXM (基板预装)       │ PCIe 插卡          │
│ 互联方式       │ NVSwitch 全互联       │ NVSwitch 全互联      │ NVLink Bridge (2卡)│
│ 8 卡互通带宽    │ 900 GB/s (H100)     │ 900 GB/s (H100)     │ 无 (仅有 PCIe)     │
│ 供电           │ 一体化设计            │ 需 OEM 自主设计       │ 标准 ATX PSU       │
│ 散热           │ 液冷/强力风冷         │ 需 OEM 自主设计       │ 标准风冷            │
│ 价格           │ $$$$$               │ $$$$                │ $$$                │
│ 运维复杂度      │ 低 (开箱即用)         │ 中 (OEM 集成)        │ 高 (自建)           │
│ 灵活性          │ 低                   │ 中                   │ 高                  │
└───────────────┴──────────────────────┴─────────────────────┴──────────────────┘
```

### 1.2 各方案适用场景

| 场景 | 推荐方案 | 原因 |
|------|----------|------|
| 大模型预训练（> 70B） | DGX/HGX H100/B200 | 必须 8 卡全互联，否则通信瓶颈严重 |
| 多卡微调 / 中等训练 | HGX A100 或 PCIe 4 卡 | NVSwitch 非必需但有益 |
| LLM 推理集群 | PCIe A100/H100 + 2 卡 NVLink Bridge | TP=2 够用，单卡带宽优先 |
| 小模型 / 开发测试 | PCIe T4/A10/L40S | 成本敏感，不需多卡互联 |
| 混合负载 K8s 集群 | PCIe 异构 GPU 池 | MIG/Time-Slicing 按需切分 |

---

## 二、PCIe 拓扑与 NUMA 亲和性

### 2.1 为什么 PCIe 拓扑很重要

GPU 与 CPU 之间通过 PCIe 总线通信，如果 GPU 插在不合适的 PCIe 槽上，会严重影响性能：

```
典型双路 Xeon 服务器 (4 GPU)：

CPU Socket 0                  CPU Socket 1
    │                             │
    ├── PCIe x16 → GPU 0          ├── PCIe x16 → GPU 2
    ├── PCIe x16 → GPU 1          ├── PCIe x16 → GPU 3
    ├── PCIe x8  → NIC 0          ├── PCIe x8  → NIC 1
    └── PCIe x8  → NVMe           └── PCIe x8  → NVMe

问题：GPU 0 ↔ GPU 3 通信需要经过 QPI/UPI 跨 CPU，延迟增加 2-3×
```

### 2.2 NUMA 感知的 GPU 分配

```bash
# 查看 GPU 与 NUMA node 的关系
nvidia-smi topo -m

# 典型输出分析：
#         GPU0  GPU1  GPU2  GPU3  mlx5_0  mlx5_1  CPU Affinity
# GPU0     X    NV12  SYS   SYS   NODE    SYS     0-31,64-95
# GPU1    NV12   X    SYS   SYS   NODE    SYS     0-31,64-95
# GPU2    SYS   SYS    X    NV12  SYS     NODE    32-63,96-127
# GPU3    SYS   SYS   NV12   X    SYS     NODE    32-63,96-127

# NV12 = NVLink 连接；SYS = 通过 QPI/UPI 跨 CPU
# 最佳实践：GPU 0,1 + NIC 0 绑定 NUMA 0；GPU 2,3 + NIC 1 绑定 NUMA 1
```

### 2.3 K8s 中设置 NUMA 亲和性

```yaml
# 使用 Topology Manager + CPU Manager 策略
apiVersion: v1
kind: Pod
metadata:
  name: gpu-training
spec:
  containers:
  - name: trainer
    resources:
      limits:
        nvidia.com/gpu: 2      # 同一 NUMA node 上的 2 张 GPU
        memory: 256Gi
        cpu: 64
      requests:
        nvidia.com/gpu: 2
        memory: 256Gi
        cpu: 64
    volumeMounts:
    - name: nvidia-mps
      mountPath: /tmp/nvidia-mps
```

```bash
# 检查 Pod 的 NUMA 分配
kubectl exec gpu-training -- numactl --hardware

# 确认 NIC 在同一 NUMA node（RDMA 通信关键）
kubectl exec gpu-training -- bash -c 'cat /sys/class/net/net1/device/numa_node'
```

---

## 三、供电与散热

### 3.1 GPU 功耗对比

| GPU | TDP (W) | 峰值功耗 (W) | 8 卡总功耗 (kW) |
|-----|---------|-------------|----------------|
| T4 | 75 | 75 | 0.6 |
| A10 | 150 | 150 | 1.2 |
| L40S | 350 | 350 | 2.8 |
| A100 PCIe | 300 | 300 | 2.4 |
| A100 SXM | 400 | 500 | 4.0 |
| H100 PCIe | 350 | 350 | 2.8 |
| H100 SXM | 700 | 750 | 6.0 |
| B200 SXM | 1000 | 1200 | 9.6 |

### 3.2 整机功耗估算

```
经验公式：
整机功耗 = GPU 总 TDP × 1.3 (含 CPU + 内存 + 主板 + 风扇 + PSU 损耗)

示例：8 × H100 SXM
GPU 功耗       = 8 × 700 = 5600W
CPU (双路)      = 2 × 350 = 700W
其他            = 600W
─────────────────────────────
整机功耗        ≈ 6900W

供电要求：
- PSU 需 ≥ 8000W（留余量）
- 需 3 路 C19 电源线（每路 16A 220V ≈ 3500W）
- 机柜电力容量需 ≥ 10kW/台
```

### 3.3 散热方案对比

```
散热方式         能力           成本     适用 GPU    运维复杂度
─────────────────────────────────────────────────────────
传统风冷          ≤ 400W/卡      低       T4/A100 PCIe  低
强力轴流风冷      ≤ 500W/卡      中       A100 SXM      中
液冷（冷板）      400-1000W/卡   高       H100/B200     高
浸没式液冷        ≥ 1000W/卡     极高     B200 NVL72    极高
```

**运维要点**：
```bash
# 实时监控 GPU 温度
nvidia-smi --query-gpu=index,temperature.gpu,temperature.memory,power.draw --format=csv -l 1

# 检查是否因过热降频
nvidia-smi -q -d CLOCK | grep -A 5 "Clocks Throttle Reasons"
# thermal_slowdown 字段 = Active 表示已触发过热降频
```

### 3.4 散热故障 SRE 实战

```
H100 SXM 集群常见散热故障：
1. 风扇转速不足 → GPU 温度 > 85°C → 自动降频 → 训练吞吐下降 50%
2. 液冷漏液 → GPU 硬件损坏（不可逆！）→ 需整卡更换
3. 空调故障 → 机柜温度 > 35°C → 触发保护性关机

监控指标 & 告警阈值：
- GPU 温度 > 80°C：Warning
- GPU 温度 > 85°C：Critical（将触发降频）
- GPU 降频持续时间 > 10min：Critical
- 进风口温度 > 35°C：需检查空调
```

---

## 四、CPU 选型

### 4.1 CPU 配比原则

```
经验规则：每 GPU 配 8-16 CPU 核心

训练节点 (A100/H100):
- 数据处理（DataLoader）吃 CPU
- NCCL 通信管理吃 CPU（每 GPU 1-2 核）
- 推荐：每 GPU 12-16 核

推理节点 (T4/A100/L40S):
- CPU 压力小
- 推荐：每 GPU 4-8 核
```

### 4.2 常见 CPU 平台

| CPU | 核心数 | PCIe 通道 | 内存通道 | 适用场景 |
|-----|--------|----------|----------|----------|
| Xeon 8480+ (Sapphire Rapids) | 56C | PCIe 5.0 x80 | 8-ch DDR5 | H100 训练节点 |
| Xeon 6430 (Sapphire Rapids) | 32C | PCIe 5.0 x80 | 8-ch DDR5 | A100 训练/推理 |
| AMD EPYC 9654 (Genoa) | 96C | PCIe 5.0 x128 | 12-ch DDR5 | 高密度推理 |
| AMD EPYC 9354 (Genoa) | 32C | PCIe 5.0 x128 | 12-ch DDR5 | A100/H100 训练 |
| Ampere Altra (ARM) | 80C | PCIe 4.0 x128 | 8-ch DDR4 | 推理（成本优化） |

> 2026 年趋势：Grace-Hopper Superchip (GH200) 和 Grace-Blackwell (GB200) 将 CPU 与 GPU 融合，NVLink-C2C 连接，CPU 选型逻辑将完全改变。

### 4.3 内存配比

```
经验规则：每 GPU 配 64-128GB 系统内存

训练场景内存用途：
- DataLoader 缓存：每 GPU 16-32GB
- PyTorch 框架开销：16-32GB
- 系统预留：32GB

示例：8 × H100 SXM 训练节点
- 系统内存：8 × 128GB = 1TB（推荐）
- 最低配置：8 × 64GB = 512GB
```

---

## 五、网络选型

### 5.1 网卡带宽需求

| GPU | NVLink 带宽 | 建议每 GPU 的网络带宽 | 8 GPU 节点总带宽 |
|-----|------------|---------------------|-----------------|
| A100 SXM | 600 GB/s | 100 Gbps (1×100G) | 800 Gbps (可 4×200G) |
| H100 SXM | 900 GB/s | 200 Gbps (1×200G) | 1.6 Tbps (可 4×400G) |
| B200 SXM | 1.8 TB/s | 400 Gbps (1×400G) | 3.2 Tbps (可 8×400G) |

网卡必须支持 RDMA（RoCE v2 或 InfiniBand）。

### 5.2 网卡推荐

| GPU 配置 | 推荐网卡 | 带宽 | 备注 |
|----------|----------|------|------|
| A100 PCIe (≤ 4卡) | ConnectX-6 Dx 100GbE | 100 Gbps | 双口，每个 NUMA node 一个 |
| A100 SXM (8卡) | ConnectX-7 200GbE / 400GbE | 200-400 Gbps | 或 IB NDR200 |
| H100 SXM (8卡) | ConnectX-7 400GbE / IB NDR400 | 400 Gbps | 需 GPU Direct RDMA |
| B200 (8卡) | ConnectX-8 800GbE / IB XDR | 800 Gbps | 链路需 GPUDirect |

```bash
# 检查网卡是否在同一 NUMA node 上（对 RDMA 性能至关重要）
# H100 SXM 8 卡典型拓扑：
# NIC 0 (mlx5_0) → NUMA 0 → GPU 0,1,2,3
# NIC 1 (mlx5_1) → NUMA 1 → GPU 4,5,6,7

# 确认 GPU-NIC NUMA 亲和性
for gpu in 0 1 2 3 4 5 6 7; do
  for nic in mlx5_0 mlx5_1; do
    gpu_numa=$(nvidia-smi topo -m | grep "GPU$gpu" | awk '{print $NF}')
    nic_numa=$(cat /sys/class/net/$nic/device/numa_node)
    echo "GPU$gpu (NUMA $gpu_numa) ↔ $nic (NUMA $nic_numa)"
  done
done
```

---

## 六、存储选型

### 6.1 本地存储

| 存储类型 | 容量 | 读取带宽 | 写入带宽 | 用途 |
|----------|------|----------|----------|------|
| NVMe SSD | 3.84TB × 4 | 28 GB/s | 28 GB/s | 数据集缓存、检查点 |
| SATA SSD | 3.84TB × 2 | 1 GB/s | 1 GB/s | 系统盘、Docker 镜像 |
| NVMe RAID0 | 7.68TB × 8 | 56 GB/s | 56 GB/s | 超大规模数据集 |

```bash
# 挂载本地 NVMe 并格式化为训练缓存盘
lsblk | grep nvme
mkfs.xfs /dev/nvme0n1
mkdir -p /mnt/nvme-cache
mount /dev/nvme0n1 /mnt/nvme-cache
# 训练前将数据集从 Lustre 拷贝到本地 NVMe
```

### 6.2 典型 8 卡训练节点存储配置

```
系统盘:   2 × 480GB SATA SSD (RAID1)      → OS + Docker
缓存盘:   4 × 3.84TB NVMe SSD (RAID0)     → 数据集 + 检查点
网络存储: Lustre / WekaFS (IB/RoCE 挂载)   → 共享数据集 + 模型仓库
```

---

## 七、典型服务器配置参考

### 7.1 LLM 训练节点（8 × H100 SXM）

```
硬件              规格
──────────────────────────────────
GPU               8 × H100-SXM5-80GB
CPU               2 × Xeon 8480+ (56C, 2.0GHz)
内存               1TB DDR5-4800 (16 × 64GB)
网卡               4 × ConnectX-7 400GbE (单口) 或 8 × ConnectX-7 200GbE
本地存储           4 × 3.84TB NVMe U.2 SSD (RAID0)
系统盘             2 × 960GB NVMe M.2 SSD (RAID1)
GPU 互联           4 × NVSwitch Gen4 (900 GB/s/GPU)
整机功耗           约 7kW
散热              液冷（冷板）
```

### 7.2 LLM 推理节点（8 × A100 80GB PCIe）

```
硬件              规格
──────────────────────────────────
GPU               8 × A100-PCIe-80GB
CPU               2 × AMD EPYC 9354 (32C, 3.55GHz)
内存               512GB DDR5-4800 (16 × 32GB)
网卡               2 × ConnectX-6 Dx 100GbE
本地存储           2 × 3.84TB NVMe U.2 SSD
GPU 互联           NVLink Bridge (仅相邻 2 卡，非必需)
整机功耗           约 3kW
散热              风冷
```

### 7.3 低成本推理节点（8 × T4）

```
硬件              规格
──────────────────────────────────
GPU               8 × T4 16GB
CPU               2 × Xeon Gold 6430 (32C)
内存               256GB DDR5-4800
网卡               2 × ConnectX-5 25GbE
本地存储           2 × 1.92TB SATA SSD
GPU 互联           无
整机功耗           约 1.2kW
散热              风冷
```

---

## 八、选型 Checklist

在选型 GPU 服务器时，按以下维度逐项确认：

```
□ 训练 or 推理？ → 决定 GPU 型号和数量
□ 模型规模？ → 决定显存需求（单卡能不能放下？是否需要 TP？）
□ 多卡互联需求？ → 决定 SXM(HGX) vs PCIe vs DGX
□ 预算上限？ → 决定整机方案
□ 数据中心供电上限？ → 8 × H100 = 7kW，确认机柜容量
□ 散热方式？ → H100+ 建议液冷
□ 网络带宽？ → 200Gbps+ RoCE/IB（训练必选 RDMA）
□ 本地存储？ → NVMe 缓存盘加速数据加载
□ 运维复杂度？ → DGX 开箱即用但贵，白牌灵活但需自建监控体系
□ 未来扩展？ → 预留 PCIe 槽位和 NVLink 桥接能力
```

---

## 关联知识

- [[NVIDIA GPU 架构演进]] — 各代 GPU 规格
- [[NVLink 与 NVSwitch 拓扑详解]] — GPU 互联拓扑
- [[../network/RDMA 与 InfiniBand 详解]] — 网络选型深入
- [[../storage/分布式文件系统选型]] — 存储选型
- [[../automation/GPU 驱动与固件管理]] — 驱动安装与固件升级

## 参考资源

- [NVIDIA DGX Systems](https://www.nvidia.com/en-us/data-center/dgx-systems/)
- [NVIDIA HGX Platform](https://www.nvidia.com/en-us/data-center/hgx/)
- [Supermicro GPU Servers](https://www.supermicro.com/en/products/gpu)

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 内容创建 | 2026-06-30 | 完整选型指南 |

## 状态标记

📖 已掌握 — PCIe 拓扑、NUMA 亲和性、功耗散热估算
📝 待补充 — Grace-Hopper Superchip 融合架构服务器选型（GH200/GB200 NVL72 新范式）

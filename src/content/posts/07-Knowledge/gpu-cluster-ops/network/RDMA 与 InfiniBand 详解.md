---
date: 2026-06-30
tags:
  - gpu
  - rdma
  - infiniband
  - roce
  - network
type: 学习笔记
category: GPU集群运维/网络
source: NVIDIA Networking + IBTA + 个人整理
difficulty: 进阶
title: "RDMA 与 InfiniBand 详解"
---

# RDMA 与 InfiniBand 详解

> 高性能 GPU 集群的网络基石：RDMA 技术原理、InfiniBand 与 RoCE 对比、GPUDirect RDMA 配置、多轨拓扑设计和故障排查命令集。

---

## 一、核心原理

### 1.1 为什么 GPU 集群必须用 RDMA

```
传统 TCP/IP:
  应用 → Socket Buffer → 内核协议栈 → 网卡驱动 → 网卡
  延迟: 50-100μs, CPU 消耗: 高

RDMA (bypass kernel):
  应用 → RDMA Verbs → 网卡硬件队列 → 网卡
  延迟: 1-3μs, CPU 消耗: 几乎为零

GPU AllReduce 1GB 梯度:
  TCP/IP: 1GB / 12GB/s ≈ 83ms（加上协议开销 ≈ 200ms）
  RDMA:   1GB / 90GB/s ≈ 11ms（4×200Gbps 聚合）
```

### 1.2 RDMA 通信原语

| 原语 | 类型 | 说明 | NCCL 使用 |
|------|:---:|------|:---:|
| **SEND/RECV** | 双边 | 类似 TCP，双方都参与 | 控制消息、握手 |
| **RDMA WRITE** | 单边 | 直接写入远端内存，远端 CPU 无感知 | ✅ AllReduce 数据面 |
| **RDMA READ** | 单边 | 直接读取远端内存 | ✅ AllReduce scather |
| **ATOMIC** | 单边 | CAS/FAA 原子操作 | 屏障同步 |

```
SEND/RECV 流程:
  Host A                          Host B
  发送方 post_send(buffer) →      接收方必须提前 post_recv(buffer)
  网卡发送数据 ──────────→        网卡写入 buffer → 完成通知

RDMA WRITE 流程:
  Host A                          Host B
  发送方知道远端内存地址           (无感知，CPU 不参与)
  网卡直接写入远端内存 ──────→    数据自动到达目标 buffer
```

---

## 二、技术路线对比

### 2.1 IB vs RoCE v2 vs iWARP

| 维度 | InfiniBand | RoCE v2 | iWARP |
|------|:---:|:---:|:---:|
| **网络层** | IB 专用 L2 | UDP/IP (L3) | TCP/IP (L4) |
| **交换机** | IB 交换机（贵） | 标准以太网交换机（需支持 DCB） | 标准以太网交换机 |
| **延迟** | ~0.8μs (NDR) | ~1.3μs | ~2.5μs |
| **无损** | 原生 Credit-based 流控 | PFC + ECN (需调优) | TCP 自带 |
| **最大带宽** | 400 Gbps (NDR) | 400 Gbps | 200 Gbps |
| **大规模** | ✅ 成熟 (万卡) | ⚠️ 千卡稳定，万卡需验证 | ❌ 不推荐 |
| **运维** | 需 IB 专业知识 | 以太网运维技能可复用 | 简单但性能够呛 |
| **成本** | 高 | 中（同代交换机价格的 60%） | 低 |
| **推荐场景** | 1000+ GPU 训练集群 | 100-1000 GPU 集群 | 极少量 GPU |

### 2.2 当前（2026）选型建议

```
训练集群:
  1000+ GPU → InfiniBand NDR400（成熟，不折腾）
  100-1000 GPU → RoCE v2 400GbE（成本优势明显）
   < 100 GPU → RoCE v2 200GbE 足够

推理集群:
  任意规模 → RoCE v2 即可（推理通信量小）
```

---

## 三、InfiniBand 实战

### 3.1 IB 网络层次

```
─────────────────────────────────────────────
绿色网络（管理网）:  1GbE, SSH/IPMI
─────────────────────────────────────────────
IB 计算网:
  Subnet Manager (OpenSM) ← 必须运行在某节点上
    │
  IB Fabric
    ├── Core Switch (导向器级别，1U/2U)
    ├── Leaf Switch (TOR, 接入层)
    └── HCA (Host Channel Adapter, 终端网卡)
```

### 3.2 Subnet Manager 配置

```bash
# 安装 OpenSM
apt install opensm

# 启动 SM（在专用管理节点上）
opensm -g 0x0002c9030002abcd -p 5  # -g: SM GUID, -p: 优先级

# 查看 IB 网络拓扑
ibnetdiscover                   # 完整拓扑
ibnetdiscover -p                # 生成拓扑文件

# 查看 SM 状态
sminfo

# 关键：SM 必须高可用（至少 Active-Standby）
# 如果 SM 挂了，IB 网络全挂（比交换机故障影响还大）
```

### 3.3 IB 端口管理

```bash
# 查看 HCA 设备
ibstat                          # 所有 HCA 状态
ibstatus                        # 所有端口速率和状态

# 典型正常输出:
# CA 'mlx5_0'
#   CA type: MT4129
#   Number of ports: 1
#   Firmware version: 28.35.1012
#   Hardware version: 0
#   Node GUID: 0x0002c9030002abcd
#   Port 1:
#     State: Active
#     Physical state: LinkUp
#     Rate: 200              ← 200 Gbps (HDR)
#     Base lid: 12

# 查看 IB 路由
ibroute <LID>                  # 到指定 LID 的路由
ibdiagnet                       # ★ 诊断全网状态（最重要工具）
ibdiagnet --routing             # 检查路由完整性
ibdiagnet --vl_arb              # 检查 VL 仲裁配置
ibdiagnet --speed               # 检查是否有降速端口
```

### 3.4 IB vs RoCE 性能测试

```bash
# IB 带宽测试
ib_write_bw -d mlx5_0 --report_gbits -a
# -d: 设备名, --report_gbits: 以 Gbps 显示, -a: 显示所有消息大小

# 典型 HDR 200Gbps 结果:
# #bytes  #iterations  BW peak[Gb/s]
# 65536   5000          196.2
# 131072  5000          197.5
# 262144  2000          198.1  ← 接近线速

# IB 延迟测试
ib_write_lat -d mlx5_0 -a

# 典型结果:
# #bytes  #iterations  t_min[usec]
# 2       1000          1.05       ← IB 延迟约 1μs
# 256     1000          1.12
```

---

## 四、RoCE v2 实战

### 4.1 RoCE v2 网络架构

```
Flow: GPU → RDMA Write → RoCE v2 → UDP/IP → Ethernet → 远端 GPU

关键差异（vs IB）:
- 需要 IP 路由和 ARP
- 无损以太网依赖 DCB (PFC + ETS + DCBX)
- 拥塞控制靠 ECN + DCQCN 算法
```

### 4.2 PFC（Priority Flow Control）配置

```bash
# RoCE 流量通常用 Priority 3
# PFC 为 Priority 3 启用无损传输

# 1. 启用 DCB
lldptool set-lldp -i mlx5_0 adminStatus=rxtx
lldptool -T -i mlx5_0 -V PFC willing=no enabled=3

# 2. 分配 buffer
mlnx_qos -i mlx5_0 --pfc=0,0,0,1,0,0,0,0
# 这个命令: 为 Priority 3 启用 PFC (=1)

# 3. 验证
mlnx_qos -i mlx5_0
# PFC enabled on priority 3 ✓
```

### 4.3 ECN / DCQCN 调优

```
DCQCN (Data Center Quantized Congestion Notification):
  ECN 标记 → 接收方 CNP 包 → 发送方降速 → 拥塞缓解

关键参数调优:

# 交换机侧 ECN 阈值
# AI 训练场景建议:
ecn_min_absolute = 200 KB    # 开始 ECN 标记的队列深度
ecn_max_absolute = 2000 KB   # 100% 标记概率的队列深度

# 主机侧 DCQCN 参数 (RoCE)
echo 0 > /sys/class/net/mlx5_0/ecn/roce_np/enable/3
echo 1 > /sys/class/net/mlx5_0/ecn/roce_rp/enable/3
# NP = Notification Point (发送方), RP = Reaction Point (接收方)
```

```bash
# 查看 RoCE ECN 统计
ethtool -S mlx5_0 | grep -E "ecn|cnp"

# 关键指标:
# rx_cnp_packets:        CNP 包接收数（高说明有拥塞）
# tx_pause_frames:       PFC 暂停帧（高说明 buffer 压力大）
# rx_discards_phy:       物理层丢包（严重问题）
```

### 4.4 RoCE 诊断命令

```bash
# 1. 查看 RoCE 模式
cma_roce_mode -d mlx5_0
# RoCE v2 ✓

# 2. 查看 GID 表（RDMA 地址）
ibv_devinfo -d mlx5_0 -v | grep GID

# 3. RDMA 连通性测试（RoCE）
ib_send_bw -d mlx5_0 -x 3 --report_gbits <peer_ip>  # -x 3: RoCE v2

# 4. 查看网卡丢包和错误
ethtool -S mlx5_0 | grep -E "drop|error|discard|retrans"
# 任何非零都要关注
```

---

## 五、GPUDirect RDMA

### 5.1 原理

```
传统 GPU 跨节点通信:
  GPU 显存 → cudaMemcpy → CPU 内存 → NIC → 网络 → 远端
  延迟: GPU→CPU 拷贝 ~10μs + NIC 延迟 ~2μs

GPUDirect RDMA:
  GPU 显存 ──────────────────→ NIC → 网络 → 远端
         (PCIe P2P 直通)
  延迟: NIC 延迟 ~2μs（省去内存拷贝）

性能差异: 开启 GDR 后跨节点 AllReduce 带宽提升 30-50%
```

### 5.2 启用 GPUDirect RDMA

```bash
# 1. 确认硬件支持
# GPU 和 NIC 在同 PCIe switch 上 → 需要二者在同 NUMA node
nvidia-smi topo -m | grep mlx5

# 2. 启用 ACS 重定向（BIOS 层面）
# BIOS: PCIe ACS → disabled (或 enable ACS override in kernel)
# 内核参数: pci=realloc,disable_acs_redir

# 3. NCCL 启用 GDR
export NCCL_NET_GDR_LEVEL=5  # 0=关, 5=最强

# 4. 验证 GDR 是否生效
export NCCL_DEBUG=INFO
# 训练日志中搜索 "GDR"
# NCCL INFO NET/IB: Using GPU Direct RDMA  ← 成功
```

### 5.3 GDR 与 NVLink 协同

```
H100 8 卡节点最佳拓扑:
  GPU 0,1,2,3 ── NVSwitch ──> 共享 PCIe switch ──> mlx5_0
  GPU 4,5,6,7 ── NVSwitch ──> 共享 PCIe switch ──> mlx5_1

  NCCL 配置:
  export NCCL_IB_HCA="=mlx5_0:mlx5_1"
  # "=" 表示: GPU 自动选择最近 NIC（同 NUMA node）
```

---

## 六、多轨（Multi-Rail）拓扑设计

### 6.1 为什么要多轨

```
H100 8 卡节点 → 每 GPU 900 GB/s NVLink
跨节点通信 → 单轨 200GbE = 25 GB/s

NVLink : 网络 = 900 : 25 = 36:1（严重不匹配！）

解决方案: 4 轨 × 200GbE = 100 GB/s → 900:100 ≈ 9:1（可接受）
```

### 6.2 4 轨 8 轨设计

```
H100 节点, 8 卡, 4 × 200GbE RoCE:

  NIC 0 (mlx5_0) ─→ Leaf Switch 0 ─→ Spine-A
  NIC 1 (mlx5_1) ─→ Leaf Switch 1 ─→ Spine-A
  NIC 2 (mlx5_2) ─→ Leaf Switch 2 ─→ Spine-B
  NIC 3 (mlx5_3) ─→ Leaf Switch 3 ─→ Spine-B

  每 Leaf Switch 承载 1/4 GPU 流量 → 无超分
  8 轨 = 直接每 GPU 对应 1 NIC + 1 Leaf
```

```bash
# NCCL 多轨配置
export NCCL_IB_HCA=mlx5_0,mlx5_1,mlx5_2,mlx5_3

# NUMA 感知多轨（推荐）
export NCCL_IB_HCA="=mlx5_0,mlx5_1:mlx5_2,mlx5_3"
# "=": NCCL 根据 NVLink 拓扑自动匹配 GPU 到最近的 NIC 对
```

### 6.3 交换机数量计算

```
H100 集群, 512 GPU (64 节点), 8 卡/节点:
  
  方案 A: 4 轨 200GbE
    64 节点 × 4 NICs = 256 个端口
    每 Leaf Switch 64 端口 → 需要 4 个 Leaf Switch
    Leaf-Spine 超分比 = 256:256 = 1:1 (无超分)
  
  方案 B: 8 轨 200GbE (NVIDIA Rail-Optimized)
    每 GPU 对应独立 Rail
    64 节点 → 8 个 Leaf Switch (每 Switch 64 端口)
    GPU i 的流量只在 Rail i 上传输 → 零跨 Rail 通信
```

---

## 七、故障排查

### 7.1 常见故障 & 解决

| 故障 | 现象 | 诊断命令 | 解决方案 |
|------|------|----------|----------|
| **IB 链路 Down** | `ibstatus` 显示 `Down` | `ibdiagnet` | 检查线缆/光模块 → 重置端口 |
| **SM 不可达** | `ibstat` 无 SM LID | `sminfo` | 重启 OpenSM |
| **PFC 风暴** | 全网吞吐骤降 | `ethtool -S \| grep pause` | 调整 PFC buffer/burst |
| **ECN 过激** | CNP 包激增, 吞吐下降 | `ethtool -S \| grep cnp` | 调高 ECN 阈值 |
| **GID 表满** | 新节点无法加入 | `ibv_devinfo -v \| grep GID` | 增大 GID 表 / 减少不需要的 GID |
| **GDR 不生效** | `NCCL_DEBUG=INFO` 无 "GDR" | 见 5.2 | 检查 ACS/BIOS nvidia-smi topo |
| **PCIe 降速** | NIC 协商速率 < 预期 | `lspci -vv \| grep LnkSta` | 检查 PCIe 插槽/BIOS |

### 7.2 兜底检查脚本

```bash
#!/bin/bash
# gpu-network-health.sh — GPU 集群网络健康检查

echo "=== HCA 状态 ==="
ibstat | grep -E "CA|State|Rate|LID"

echo "=== 丢包检查 ==="
for dev in $(ibstat | grep "CA '" | awk -F"'" '{print $2}'); do
  errors=$(ethtool -S $dev 2>/dev/null | grep -cE " [1-9]")
  if [ "$errors" -gt 0 ]; then
    echo "WARNING: $dev has non-zero error counters"
    ethtool -S $dev | grep -E " [1-9]"
  fi
done

echo "=== NVLink + NIC 拓扑 ==="
nvidia-smi topo -m | grep -E "GPU|mlx"

echo "=== GDR 检查 (NCCL) ==="
if nvidia-smi topo -m | grep -q "NODE.*mlx"; then
  echo "WARNING: Some NICs on different NUMA vs GPU (GDR may not work)"
fi
```

---

## 关联知识

- [[NCCL 通信原理与调优]]
- [[GPU 集群网络拓扑设计]]
- [[../troubleshooting/NCCL 通信故障诊断指南]]
- [[../hardware/NVLink 与 NVSwitch 拓扑详解]]
- [[../hardware/GPU 服务器硬件选型指南]] — 服务器网络选型
- [[../storage/分布式文件系统选型]] — 存储网络需求
- [[../GPU 集群运维知识总览]] — 返回总览

## 参考资源

- [NVIDIA Networking Documentation](https://docs.nvidia.com/networking/)
- [RDMAmojo Blog](https://www.rdmamojo.com/)
- [IBTA Specification](https://www.infinibandta.org/)
- [RoCE v2 Specification](https://cw.infinibandta.org/document/dl/7781)

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 框架搭建 | 2026-06-29 | 骨架创建 |
| 内容补全 | 2026-06-30 | IB/RoCE 实战配置、GDR 详解、故障排查 |

## 状态标记

📖 已掌握 — RDMA 原理、IB/RoCE 对比、GPUDirect RDMA、多轨设计
📝 待补充 — IB NDR400/XDR 实际部署案例、RoCE 万卡验证报告

---
date: 2026-06-30
tags:
  - gpu
  - nccl
  - troubleshooting
  - communication
  - hang
type: 参考手册
category: GPU集群运维/故障排查
source: NVIDIA NCCL 官方文档 + 生产环境实战排障经验
difficulty: 高级
title: "NCCL 通信故障诊断指南"
---

# NCCL 通信故障诊断指南

> NCCL 通信故障是 GPU 集群最高频、最难排查的问题之一。本指南是一线运维实战手册，覆盖 NCCL Hang、超时、带宽异常、初始化失败四大故障类型的系统化诊断方法，附带真实案例和可执行的诊断命令。

---

## 1. NCCL Hang — 最隐蔽也最痛苦的故障

### 1.1 什么是 NCCL Hang

NCCL Hang 是指分布式训练中某个（或多个）Rank 的 NCCL 集合通信操作**永不返回**，进程卡在 GPU Kernel 中 wait 信号，但不报任何错误。典型表现为：

- `nvidia-smi` 显示 GPU 利用率 100%，但 `torchrun` 进程无日志输出
- 所有 Rank 卡在同一行代码（如 `dist.all_reduce()`）不动
- `NCCL_DEBUG=WARN` 无任何报错——因为 NCCL 还没超时

**本质**：通信路径上的某个环节（GPU Kernel / NVLink / NIC / Switch / Cable）出现**无声丢包**或链路中断，导致 NCCL 的同步原语陷入死等。

### 1.2 检测方法

```bash
# === 第一步：确认是 Hang 还是慢 ===
# 1.1 查看进程状态（D=不可中断睡眠, R=运行, S=可中断睡眠）
ps aux | grep python | grep -v grep

# 1.2 查看 GPU 是否在执行 Kernel（通过 SM 利用率和执行的进程）
nvidia-smi
# 关注点：GPU-Util 100%、Persistence-M 开启、有进程 PID 但 Compute 无变化

# 1.3 PyTorch 侧超时检测（推荐加到训练启动脚本）
export TORCH_NCCL_HEARTBEAT_TIMEOUT_SEC=300   # 5 分钟无通信视为卡死
export TORCH_NCCL_BLOCKING_WAIT=1              # 阻塞式等待，出错立刻抛异常
export NCCL_ASYNC_ERROR_HANDLING=1             # 异步错误处理

# === 第二步：NCCL 内部状态诊断 ===
# 2.1 TRACE 级别日志（代价大但信息最全）
export NCCL_DEBUG=TRACE
export NCCL_DEBUG_FILE=/tmp/nccl_trace_%h_%p.log
# 重跑任务，分析每个 Rank 最后一条日志
# Hang 时日志通常停在 "Channel 00/01 : ... [send]" 或 "Waiting for ..."

# 2.2 导出 NCCL 拓扑图，确认路径是否正确
export NCCL_GRAPH_DUMP_FILE=/tmp/nccl_graph.xml
# Hang 后检查每个 Rank 的 graph，看是否有 channel 卡在特定 NIC/GPU
grep -E "nchannels|Channel|NET" /tmp/nccl_trace_*.log | tail -50

# === 第三步：底层硬件状态 ===
# 3.1 IB 链路状态
ibstat | grep -E "State|Rate|Link"
# Active + FDR/EDR/HDR/NDR → 正常
# Down/Polling/Disabled → **这就是根因**

# 3.2 网卡错误计数（关键）
ethtool -S mlx5_0 | grep -iE "discard|error|drop|retrans|timeout"
# port_rcv_errors, port_xmit_discards > 0 → 网络层丢包
# rx_prio*_discards > 0 → PFC 或 buffer 溢出

# 3.3 IB 计数器（更准确）
perfquery -x 0 1  # Port 1
# SymbolErrorCounter > 0 → 物理层误码
# LinkErrorRecoveryCounter > 0 → 链路抖动
# PortRcvErrors > 0 → 接收错误

# 3.4 Mellanox 网卡固件日志（ConnectX-4/5/6/7 通用）
mlxfwreset --query           # 查看固件版本和状态
mstflint -d mlx5_0 q         # 详细固件信息
mstdump /dev/mst/mt4125_pciconf0 > mst_dump.log  # 完整转储（送厂商分析）
```

### 1.3 常见根因与诊断步骤

| 根因 | 诊断方法 | 确认信号 |
|------|----------|----------|
| **IB 链路 Flap** | `ibstat` / `perfquery` | Physical Link 反复 Up/Down，LinkErrorRecoveryCounter 增长 |
| **交换机 Buffer 溢出** | `ethtool -S mlx5_0 \| grep discard` | `rx_prio3_discards`（RoCE 优先级 3）持续增长 |
| **PFC 死锁 / 风暴** | 交换机日志 + `ethtool -S` 的 `rx_pause` | `rx_pause_ctrl_prio3` 持续增长，流量被暂停 |
| **网卡固件 Bug** | `dmesg \| grep mlx5` + `mstflint` | `mlx5_core ... Internal error detected` 或固件版本 ≤ 被修复版本 |
| **GPU 卡死（Xid 43/45/79）** | `dmesg \| grep -i xid` | 出现 Xid 43/45/79，GPU 已掉卡但仍占着 NCCL communicator |
| **NCCL_IB_HCA 配置错误** | `NCCL_DEBUG=INFO` 日志 | NCCL 选择了错误的 NIC（通过 TCP socket 而非 IB） |
| **跨 NUMA 路由不当** | `nvidia-smi topo -m` | NIC 和 GPU 的 PIX 距离 > NODE（说明跨了 PCIe root complex） |

### 1.4 Hang 的应急处理

```bash
# 快速恢复（不排查时）
# 1. 杀死所有 NCCL 进程
pkill -9 -f "torchrun|nccl|all_reduce"

# 2. 如果 GPU 状态异常，尝试重置
nvidia-smi -r -i <GPU_INDEX>

# 3. 如果 IB 链路异常，尝试重置网卡
mlxlink -d mlx5_0 -r  # 软重置
# 或 reboot 节点（最可靠）

# 4. 临时规避：降级到 TCP 通信（用于验证是否为网络问题）
export NCCL_IB_DISABLE=1
export NCCL_SOCKET_IFNAME=eth0    # 走以太网
# 如果是网络问题，TCP 模式不会 Hang（但带宽极低）
```

---

## 2. NCCL Timeout — 明确但不明确的错误

### 2.1 典型错误信息

```
NCCL WARN NET/IB : Got completion with error 12, errno 110 (Connection timed out)
NCCL WARN NET/IB : Got completion with error 5, errno 110 (Transport retry counter exceeded)
ncclSystemError: System call (e.g., socket, malloc) or external library call failed or device error detected
```

超时与 Hang 的最大区别：**超时会报错并终止**，但错误信息往往不能直接定位根因。

### 2.2 超时根因分类

```bash
# === 根因 1：GDR (GPUDirect RDMA) 配置错误 ===
# NCCL 尝试从 GPU 显存直接 RDMA（GDR），但系统不支持
# 诊断：
export NCCL_DEBUG=INFO
# 正常日志：NET/IB : Using network GDR
# 异常日志：NET/IB : GDR is disabled / NET/IB : Falling back to socket

# 检查 GDR 支持
cat /sys/module/nvidia/version    # 驱动版本
lsmod | grep nvidia_peermem       # GDR 依赖的内核模块
# 如果 nvidia_peermem 未加载，GDR 不可用
modprobe nvidia_peermem           # 加载
# 在容器中还需挂载 /dev/infiniband 并把 IPC_LOCK 加入 SecurityContext

# === 根因 2：IB/RoCE 链路质量差 ===
# perfquery 查看物理层错误
perfquery -x 0 1 | grep -E "SymbolError|LinkErrorRecovery|PortRcvErrors|VL15Dropped"
# SymbolErrorCounter > 0 → 光模块脏/坏、线缆老化、交换机端口故障
# LinkErrorRecoveryCounter 每分钟 > 10 → 链路极不稳定

# === 根因 3：NCCL 超时不够 ===
# 大消息（e.g., AllReduce 4GB）在慢链路上需要更长时间
export NCCL_IB_TIMEOUT=31          # 默认 22（~16s），增大到 31（~60s）
export NCCL_IB_QPTREE_TIMEOUT=31   # Tree 算法专用超时（NCCL 2.18+）
export NCCL_IB_RETRY_CNT=10        # 默认 7，最大重试次数
export NCCL_IB_AR_THRESHOLD=0      # 关闭 Adaptive Routing（不稳定链路）

# 但注意：超时很大只是"容忍"，不是"修复"
# 如果 perfquery 有物理层错误 → 先修链路，不要靠增大超时掩盖

# === 根因 4：跨节点 TCP 初始化超时 ===
# 当环境变量 NCCL_SOCKET_TIMEOUT 不够时
export NCCL_SOCKET_NTHREADS=8      # Socket 线程数（加大加快初始化）
export NCCL_NSOCKS_PERTHREAD=8
export NCCL_SOCKET_TIMEOUT=600     # 初始化阶段 TCP 超时（秒）
```

### 2.3 安全增大超时的方法

```bash
# 不要盲目调超大值，按梯度增大并验证
# 保守方案（如果确定网络正常只是消息大）
export NCCL_IB_TIMEOUT=23          # ~32s（每次 +1 大约 ×2 时间）
export NCCL_NET_TIMEOUT=1800       # 网络初始化超时（秒）

# 激进方案（仅用于诊断，不长期使用）
export NCCL_IB_TIMEOUT=31          # ~128s
export NCCL_IB_RETRY_CNT=15

# 如果增大超时后问题"消失"，说明根因是间歇性慢链路
# 此时不应满足于此——排查链路质量
```

---

## 3. 带宽异常 — 训练吞吐骤降至预期 50% 以下

### 3.1 基准测试：建立性能基线

```bash
# === nccl-tests（NCCL 官方 benchmark，首选） ===
# https://github.com/NVIDIA/nccl-tests

# 单节点 8 卡 all_reduce 测试
all_reduce_perf -b 8 -e 2G -f 2 -g 8 -n 20 -w 10

# 参数详解：
# -b 8          : 最小消息 8 字节
# -e 2G         : 最大消息 2 GB
# -f 2          : 步进因子（×2: 8B → 16B → 32B ...）
# -g 8          : 使用 8 个 GPU
# -n 20         : 每个消息大小跑 20 次取平均
# -w 10         : 预热 10 次（排除冷启动影响）
# -c 0          : 使用 CUDA Stream 0（默认）
# -d float      : 使用 float 数据类型

# 多节点（例：2 节点 × 8 GPU）
mpirun -np 16 -H node01:8,node02:8 \
  -x NCCL_IB_HCA=mlx5_0,mlx5_1,mlx5_2,mlx5_3 \
  -x NCCL_DEBUG=WARN \
  all_reduce_perf -b 8 -e 2G -f 2 -g 1 -n 10 -w 5

# 关键：逐消息大小的带宽 vs 期望基线对比
# 正常 H100 8 卡节点内 (NVSwitch)：1MB 以上应 > 400 GB/s
# 正常 H100 2 节点 (4×200GbE)：1GB 消息 > 70 GB/s

# === 全场景测试脚本 ===
# 生成每种消息大小的带宽，导出 CSV 供分析
all_reduce_perf -b 8 -e 2G -f 2 -g 8 -n 20 | \
  awk '/^[ ]*[0-9]/ {print $1","$5}' > allreduce_bw.csv
# CSV: 消息大小(字节), 带外带宽(GB/s)
```

### 3.2 带宽异常的根因排查

```bash
# === 检查 1：GDR 是否生效 ===
export NCCL_DEBUG=INFO
export NCCL_DEBUG_FILE=/tmp/nccl_bw_%h.log

# grep 关键行
grep "NET/IB" /tmp/nccl_bw_*.log | grep -i "GDR"
# ✅ NET/IB : Using network GDR
# ❌ NET/IB : GDR is disabled, falling back to ...
# ❌ NET/IB : Using network Socket  ← 走 TCP，带宽必低

# === 检查 2：PCIe 链路是否降速 ===
# 列出所有 NVIDIA 设备的 PCIe 连接
nvidia-smi --query-gpu=index,pci.bus_id,pcie.link.gen.current,pcie.link.width.current --format=csv
# 期望：PCIe Gen4 x16 或 Gen5 x16
# 异常：PCIe Gen3 x8 / Gen1 x4 → 降速 4×~16×

# 用 lspci 交叉验证
lspci -vvv -s 17:00.0 | grep -E "LnkSta|LnkCap"
# LnkCap: Speed 16GT/s, Width x16  ← 能力
# LnkSta: Speed 16GT/s, Width x16   ← 当前 ← 必须一致

# NIC 的 PCIe 链路也得查（GDR 依赖 NIC ↔ GPU 的带宽）
lspci -vvv -s $(readlink -f /sys/class/infiniband/mlx5_0/device | xargs basename) | grep LnkSta

# === 检查 3：NVLink 是否有链路 Down ===
nvidia-smi nvlink -s
# GPU 0: NVLink is up
#   Link 0: 26.562 GB/s
#   Link 1: 26.562 GB/s
#   ...
#   Link 17: <inactive>   ← **问题**

nvidia-smi nvlink -e   # 错误计数
# CRC Error > 0 → 链路有数据损坏

# === 检查 4：跨 NUMA 导致带宽腰斩 ===
# 确认 GPU 和 NIC 的 NUMA 亲和性
nvidia-smi topo -m
# 示例：GPU0 是 NUMA 0，mlx5_0 也在 NUMA 0 → PIX → 最优
#       GPU0 是 NUMA 0，mlx5_2 在 NUMA 1 → NODE/SYS → 跨 NUMA，带宽降 30-50%

# 确认 NCCL 是否正确匹配 GPU → NIC
grep "NET/IB" /tmp/nccl_bw_*.log | grep "mlx5"
# NCCL 2.19+ 默认按亲和性匹配（=mlx5_0,mlx5_1:mlx5_2,mlx5_3）

# === 检查 5：网卡 MTU 不一致 ===
# 所有 NIC 和交换机端口的 MTU 必须一致（RoCE 通常 4200/9000）
ibstat mlx5_0 | grep MTU
# 期望：Active MTU: 4096 (RoCE) 或 4200
# 如果显示 MTU: 1500 → 大包被分片，带宽暴跌

# 检查组内所有节点的 MTU，不一致会导致 PMTU 黑洞
for node in node{01..32}; do
  ssh $node "ibstat mlx5_0 | grep MTU" &
done
```

### 3.3 网络基线测试（排除 NCCL 自身问题）

```bash
# === ib_write_bw：纯 RDMA 写入带宽测试 ===
# 服务端（node01）
ib_write_bw -d mlx5_0 -a -F --report_gbits
# 客户端（node02）
ib_write_bw -d mlx5_0 -a -F --report_gbits node01

# 参数：
# -d mlx5_0     : 指定 IB 设备
# -a            : 显示所有消息大小的结果
# -F            : 不 fork（单线程）
# --report_gbits: 以 Gbps 显示带宽

# 期望：200GbE → ~195 Gbps，400GbE → ~390 Gbps
# 如果 ib_write_bw 都跑不满线速，NCCL 更不可能跑满

# === ib_send_lat：延迟基线 ===
ib_send_lat -d mlx5_0 -a node01
# 正常：跨一个交换机 < 2μs

# === nccl-tests 中的 scatter/gather/alltoall ===
# all_gather_perf -b 8 -e 2G -f 2 -g 8
# reduce_scatter_perf -b 8 -e 2G -f 2 -g 8
# alltoall_perf -b 8 -e 2G -f 2 -g 8
# 不同通信模式对网络路径的利用不同，可能暴露特定算法瓶颈
```

---

## 4. 初始化失败 — "连都连不上"

### 4.1 典型错误信息

```
ncclSystemError: System call or external library call failed
ncclInvalidUsage: Invalid usage of NCCL APIs
NCCL WARN Bootstrap : no socket interface found
ncclInternalError: Internal check failed
```

### 4.2 根因诊断

```bash
# === 根因 1：NCCL_IB_HCA 配置错误 ===
# 最常见错误：指定了不存在的网卡名，或者漏掉了某张卡
ibstat --list_of_cas          # 列出所有 IB 设备
# 输出示例：mlx5_0, mlx5_1, mlx5_2, mlx5_3

# 验证 NCCL 能否找到指定的 HCA
export NCCL_DEBUG=INFO
# 日志中搜索：
grep "NET/IB" /tmp/nccl_debug.log | head -20
# ✅ NET/IB : Using 4 NICs
# ❌ NET/IB : No IB devices found
# ❌ NET/IB : Unable to open device mlx5_4  ← 编号配错了

# 按 NUMA 指定（推荐）
export NCCL_IB_HCA="=mlx5_0,mlx5_1:mlx5_2,mlx5_3"
# = 表示自动匹配 GPU-NIC 亲和性

# === 根因 2：节点间 NCCL 版本不一致 ===
# ncclGetVersion 在初始化时交换，不一致直接报错
for node in node{01..32}; do
  ssh $node "python -c 'import torch; print(torch.cuda.nccl.version())'" &
done
# 输出必须完全一致，如 (2, 19, 3)

# 容器化环境特别容易出此问题——确认所有节点的镜像 digest 一致
docker inspect --format='{{.RepoDigests}}' <image> | head -1

# === 根因 3：NCCL_SOCKET_IFNAME 或 NCCL_COMM_ID 指定错误 ===
# 跨节点通信需要主节点 IP，确保是高速网络的 IP（不是管理口 eth0）

# 查看高速网络接口
ip -o addr show | grep -E "bond0|eth[2-9]|ib0" | awk '{print $2,$4}'

# 指定正确的接口
export NCCL_SOCKET_IFNAME=bond0          # RoCE 走 bond 口
# 或
export NCCL_SOCKET_IFNAME=eth2           # 直接指定 IB 对应接口

# 如果是 IB native（非 RoCE）
export NCCL_IB_DISABLE=0
export NCCL_NET_GDR_LEVEL=5

# === 根因 4：容器内 /dev/infiniband 未挂载 ===
# Kubernetes Pod spec 中需添加：
#   resources:
#     limits:
#       rdma/hca: 4          # 从 K8s 1.24+ 的 RDMA device plugin 请求
#   securityContext:
#     capabilities:
#       add: ["IPC_LOCK"]
# 然后检查：
ls -la /dev/infiniband/
# 预期：存在 uverbs* 和 rdma_cm

# === 根因 5：NCCL_NET_PLUGIN 冲突 ===
# 如果使用了 aws-ofi-nccl 或其他 plugin，确认 plugin 库存在且版本兼容
export NCCL_NET_PLUGIN=  # 先清空，用内置 IB 验证问题是否消失

# === 根因 6：GPU-NIC 拓扑不兼容 ===
# NCCL 要求同一 communicator 内的所有 GPU 必须能互相通信
# 如果某 GPU 没有关联的 NIC（或 NIC 不对），初始化失败
nvidia-smi topo -m | grep -E "mlx5"
# 确保每个 GPU 至少有一个 PIX 级别的 NIC
```

---

## 5. 诊断决策树

按优先级顺序执行，不跳步。每步定位一个故障大类。

```
┌────────────────────────────────────────────────────────────────┐
│ 训练卡住？反应慢？吞吐异常？                                    │
└──────────────┬─────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 0: 快速分诊                                                      │
│                                                                       │
│ 有报错信息？                                                          │
│   ├── YES → 跳至对应分支 (Timeout/Init)                               │
│   └── NO → 进程不报错不退出？                                          │
│              ├── GPU-Util 固定 100% 无日志 → 🔴 NCCL HANG (Section 1) │
│              ├── 日志有 "WARN timeout" → 🟡 NCCL TIMEOUT (Section 2)  │
│              └── 吞吐只有预期的 50% → 🔶 BANDWIDTH (Section 3)        │
└──────────────────────────────────────────────────────────────────────┘
               │
     ┌─────────┼─────────┐
     ▼         ▼         ▼
┌─────────┐ ┌─────────┐ ┌──────────────────┐
│ HANG    │ │ TIMEOUT │ │ INIT FAILURE      │
│ 分支 1  │ │ 分支 2  │ │  分支 3           │
└────┬────┘ └────┬────┘ └────────┬─────────┘
     │            │               │
     ▼            ▼               ▼
┌─────────────────────────────────────────────┐
│ 分支 1: HANG — 定位阻塞点                    │
│                                              │
│ 1. export NCCL_DEBUG=TRACE                   │
│    → 最后一行日志在哪个 Channel/NIC？        │
│                                              │
│ 2. 检查硬件层（并行执行）：                 │
│    a) ibstat → Link Down? → 检查线缆/光模块  │
│    b) dmesg | grep Xid → GPU 掉卡?           │
│    c) ethtool -S → 网卡丢包/错包?            │
│    d) perfquery → IB 物理层错误?             │
│                                              │
│ 3. 隔离故障：                                │
│    → NCCL_IB_DISABLE=1 验证是否网络问题      │
│    → 单节点 8 卡测试（排除跨节点网络）       │
│    → 换光纤/光模块（最快见效的尝试）         │
│                                              │
│ 4. 如果硬件层正常 → 怀疑 NCCL 自身 Race      │
│    → 升级 NCCL 版本 + 固件                   │
└─────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────┐
│ 分支 2: TIMEOUT — 定位超时原因              │
│                                              │
│ 1. 确认错误码：                              │
│    ❯ error 12 + errno 110 → 网络不可达       │
│    ❯ error 5 + errno 110 → 重试耗尽         │
│                                              │
│ 2. 检查 GDR 状态：                           │
│    → nvidia_peermem 模块是否加载？           │
│    → /sys/kernel/mm/memory_peers/ 存在？     │
│    → NCCL 日志是否显示 "GDR disabled"？      │
│                                              │
│ 3. 检查 IB/RoCE 链路质量：                   │
│    → perfquery 物理层错误计数                │
│    → ethtool -S 网卡丢弃包                   │
│    → ib_write_bw -a 带宽/延迟基线            │
│                                              │
│ 4. 临时扩大超时（诊断用，非修复）：          │
│    → NCCL_IB_TIMEOUT=31                      │
│    → 如果"修复"→ 确认是间歇性慢链路          │
│                                              │
│ 5. 检查交换机端 Buffer/PFC 配置             │
└─────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────┐
│ 分支 3: INIT FAILURE — 定位初始化问题       │
│                                              │
│ 1. NCCL_DEBUG=INFO → 查看完整初始化日志     │
│                                              │
│ 2. 环境变量自检：                            │
│    → NCCL_IB_HCA 指向正确且存在的网卡？     │
│    → NCCL_SOCKET_IFNAME 指向高速网络？      │
│    → NCCL_COMM_ID / MASTER_ADDR 正确？       │
│                                              │
│ 3. 版本一致性检查：                          │
│    → 所有节点的 NCCL 版本一致？             │
│    → 所有节点的 OFED / Driver 版本一致？     │
│                                              │
│ 4. 容器环境检查：                            │
│    → /dev/infiniband/* 挂载？                │
│    → IPC_LOCK capability 授予？              │
│    → network=host 或 RDMA device plugin？    │
│                                              │
│ 5. 拓扑检查：                                │
│    → nvidia-smi topo -m → GPU-NIC 亲和性？   │
│    → 所有 GPU 是否都能访问 RDMA NIC？        │
└─────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────┐
│ BANDWIDTH ANOMALY — 诊断流程                │
│                                              │
│ 1. 基线测试：                                │
│    all_reduce_perf -b 8 -e 2G -f 2 -g 8 -n 20│
│                                              │
│ 2. 逐层隔离：                                │
│    a) 单节点内 8 卡 all_reduce → NVLink 基线 │
│    b) 2 节点跨节点 all_reduce → 网络基线     │
│    c) ib_write_bw → 纯 RDMA 基线（排除 NCCL) │
│                                              │
│ 3. 带宽瓶颈排查：                            │
│    → PCIe 链路是否降速？                    │
│    → NVLink 是否有 inactive 链路？           │
│    → GDR 是否启用？                          │
│    → 跨 NUMA 路由是否正确？                 │
│    → MTU 是否全链路一致？                   │
└─────────────────────────────────────────────┘
```

---

## 6. 诊断工具包 — 命令速查

### 6.1 all_reduce_perf 完整用法

```bash
# 安装
git clone https://github.com/NVIDIA/nccl-tests.git
cd nccl-tests && make MPI=1 MPI_HOME=/usr/local/mpi CUDA_HOME=/usr/local/cuda

# === 基础测试 ===
# 单节点内
all_reduce_perf -b 8 -e 2G -f 2 -g 8 -n 20 -w 10
# 跨节点（mpirun）
mpirun -np 16 -H node01:8,node02:8 \
  --bind-to none --mca btl_tcp_if_include bond0 \
  -x NCCL_DEBUG=WARN \
  all_reduce_perf -b 8 -e 2G -f 2 -g 1 -n 10

# === 参数全集 ===
# -b <bytes>     最小消息大小 (default: 32M)
# -e <bytes>     最大消息大小 (default: 32M)
# -f <factor>    步进因子: 2=翻倍, 1.5=1.5倍 (default: 1)
# -g <n>         每个进程使用的 GPU 数
# -n <iter>      每个消息大小的迭代次数
# -w <warmups>   预热次数
# -c <stream>    使用的 CUDA stream 数
# -d <type>      数据类型: float/half/int8/int32 (default: float)
# -o <op>        操作: sum/prod/min/max (default: sum)
# -p <n>         最小跨越进程数 (default: 1)
# -r <root>      根 GPU (broadcast/reduce)
# -t <n>         线程数 (default: 1)

# === 常用测试矩阵 ===

# 1. 小消息延迟测试（关键：8B ~ 1KB）
all_reduce_perf -b 8 -e 1024 -f 2 -g 8 -n 100 -w 20
# 关注：8B 带宽 × 8B 延迟

# 2. 中消息带宽（关键：128KB ~ 16MB，此时从 latency-bound 转为 bandwidth-bound）
all_reduce_perf -b 128K -e 16M -f 2 -g 8 -n 50

# 3. 大消息带宽（关键：64MB ~ 2GB，反映实际训练梯度同步）
all_reduce_perf -b 64M -e 2G -f 2 -g 8 -n 20

# 4. BusBW 解读
# all_reduce_perf 输出的 "out-of-place" 带外带宽
# BusBW = DataSize × 2 × (n-1) / n / Time
# 对于 Ring AllReduce 理想 BusBW ≈ 链接带宽 × n/2

# 批量测试脚本
for size in 8 64 512 4K 32K 256K 2M 16M 128M 1G; do
  echo "=== Testing ${size} ==="
  all_reduce_perf -b $size -e $size -g 8 -n 30 -w 5 2>&1 | \
    awk '/out-of-place/ {print "BusBW: "$5" GB/s"}'
done
```

### 6.2 NCCL_DEBUG 级别详解

| 级别 | 何时使用 | 典型信息 | 性能开销 |
|------|----------|----------|----------|
| `WARN` (默认) | 正常生产 | 仅错误和警告 | 0% |
| `INFO` | 初始化验证、拓扑确认 | GPU-NIC 匹配、信道数、GDR 状态、算法选择 | <1% |
| `TRACE` | 深度调试 Hang/死锁 | 每次 send/recv 的时间戳、每个 channel 的进度、同步屏障 | 5-15% |
| `VERSION` | 版本检查 | NCCL 版本、编译参数 | 0% |

```bash
# 生产环境默认
export NCCL_DEBUG=WARN

# 每次训练启动时建议 INFO（可审计通信路径）
export NCCL_DEBUG=INFO
export NCCL_DEBUG_FILE=/var/log/nccl/%h_%p_$(date +%Y%m%d_%H%M).log

# TRACE 注意事项：
# - 日志量巨大（8 卡 × TRACE 可能产 100MB+/分钟）
# - 只在复现问题时开启，并确保磁盘有足够空间
# - 建议配合 NCCL_DEBUG_SUBSYS 过滤子系统
export NCCL_DEBUG_SUBSYS=NET,GRAPH     # 只看网络和图拓扑
export NCCL_DEBUG_SUBSYS=INIT,ENV      # 只看初始化和环境变量
# 可用子系统：INIT/COLL/GRAPH/NET/TUNING/ENV/ALLOC/CALL
```

### 6.3 NCCL_GRAPH_DUMP_FILE 拓扑诊断

```bash
# 导出 NCCL 内部拓扑图（每个 Rank 生成一个 XML）
export NCCL_GRAPH_DUMP_FILE=/tmp/nccl_graph_%h_%r.xml
# %h = hostname, %r = rank

# 运行任意 NCCL 初始化代码后检查
python -c "
import torch.distributed as dist
dist.init_process_group(backend='nccl', init_method='tcp://127.0.0.1:29500',
                        world_size=1, rank=0)
"

# 解析 XML
grep -E "<xml>|<node>|<channel>|<gpu>|<nic>|<net>" /tmp/nccl_graph_*.xml

# 关键信息：
# - <nchannels>4</nchannels>   → 通信信道数（通常 = NIC 数）
# - <gpu dev="0"/> → <nic dev="0"/>  → GPU 0 使用 NIC 0
# - <gpu dev="0"/> → <nic dev="1"/>  → GPU 0 也使用 NIC 1（交叉使用不可取）
#
# 异常模式：
# - 某 GPU 没有任何 NIC 连接 → 拓扑/亲和性配置错误
# - 所有 GPU 只用一张 NIC → NCCL_IB_HCA 配置错误
# - Channel 数 < NIC 数 → 有 NIC 未被 NCCL 发现
```

### 6.4 ib_write_bw 网络基线

```bash
# === 安装 perftest ===
# apt: apt install perftest
# source: https://github.com/linux-rdma/perftest

# === 服务端 ===
ib_write_bw -d mlx5_0 -a -F --report_gbits --run_infinitely
# -d: IB 设备
# -a: 所有消息大小
# -F: 不 fork
# --report_gbits: 以 Gbps 输出
# --run_infinitely: 持续运行（客户端可多次连接测试）

# === 客户端 ===
# 单次完整测试
ib_write_bw -d mlx5_0 -a -F --report_gbits <SERVER_IP>

# 特定消息大小测试（最接近训练场景的 64MB）
ib_write_bw -d mlx5_0 -F --report_gbits --size=67108864 <SERVER_IP>

# 多 QP 并发（模拟 NCCL 多 channel）
ib_write_bw -d mlx5_0 -F --report_gbits --qp 4 <SERVER_IP>

# === 结果判断 ===
# 200GbE HDR → 期望 ~195 Gbps（单向）
# 400GbE NDR → 期望 ~390 Gbps
# < 80% 线速 → 链路/交换机有问题

# === 延迟基线 ===
ib_send_lat -d mlx5_0 -a <SERVER_IP>
# 正常：同一交换机 < 2μs，跨一个 spine < 3μs

# === 检查 RoCE DCQCN/ECN 是否工作 ===
# 在交换机侧抓包或看 counter
# 如果大量 ECN 标记但无速率下降 → DCQCN 正常工作
# 如果无数 ECN 但有 PFC pause 帧 → 拥塞控制失效
```

### 6.5 一键诊断脚本

```bash
#!/bin/bash
# nccl-health-check.sh — NCCL 通信健康检查（单节点）
# 用法: bash nccl-health-check.sh > nccl_health_$(hostname)_$(date +%Y%m%d).log

echo "=== NCCL Health Check @ $(date) ==="
echo "Hostname: $(hostname)"
echo ""

echo "--- 1. GPU Status ---"
nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,temperature.gpu,pcie.link.gen.current,pcie.link.width.current --format=csv

echo ""
echo "--- 2. NVLink Status ---"
nvidia-smi nvlink -s 2>/dev/null || echo "No NVLink"
# Quick: count inactive links
INACTIVE=$(nvidia-smi nvlink -s 2>/dev/null | grep -c "<inactive>")
echo "Inactive NVLink count: $INACTIVE"

echo ""
echo "--- 3. IB/RDMA Devices ---"
ibstat --list_of_cas 2>/dev/null || echo "No IB devices"
for dev in $(ibstat --list_of_cas 2>/dev/null); do
  echo "  $dev: $(ibstat $dev | grep -E 'State|Rate|Link')"
done

echo ""
echo "--- 4. NIC Error Counters ---"
for nic in $(ls /sys/class/infiniband/ 2>/dev/null); do
  IFACE=$(ls /sys/class/infiniband/$nic/device/net/ 2>/dev/null)
  if [ -n "$IFACE" ]; then
    echo "  $IFACE ($nic):"
    ethtool -S $IFACE 2>/dev/null | grep -iE "discard|error|drop" | grep -v ": 0$"
  fi
done

echo ""
echo "--- 5. PCIe Link Status (NICs) ---"
for nic in mlx5_0 mlx5_1 mlx5_2 mlx5_3 mlx5_4 mlx5_5 mlx5_6 mlx5_7; do
  BDF=$(basename $(readlink -f /sys/class/infiniband/$nic/device 2>/dev/null) 2>/dev/null)
  if [ -n "$BDF" ]; then
    echo "  $nic ($BDF): $(lspci -vvv -s $BDF 2>/dev/null | grep LnkSta: | head -1)"
  fi
done

echo ""
echo "--- 6. GDR Support ---"
lsmod | grep nvidia_peermem > /dev/null && echo "nvidia_peermem: LOADED" || echo "nvidia_peermem: NOT LOADED"
ls /dev/infiniband/ > /dev/null 2>&1 && echo "/dev/infiniband: EXISTS" || echo "/dev/infiniband: MISSING"

echo ""
echo "--- 7. Last Xid Errors ---"
dmesg -T 2>/dev/null | grep -i xid | tail -10

echo ""
echo "=== Health Check Done ==="
```

---

## 7. 实战案例

### 案例 1：间歇性 NCCL Hang —— IB 交换机 Buffer 溢出

**场景**：128 卡训练 LLaMA-70B，每 2-3 小时 Hang 一次，无错误日志。

**症状**：
- 所有 128 个 Rank 突然无日志输出，`nvidia-smi` 显示 GPU 100% Util
- `NCCL_DEBUG=WARN` 无任何 warning
- 手动 `kill -9` 后重新启动，又能正常训练 2-3 小时

**诊断步骤**：
```bash
# 1. Hang 时抓 NCCL TRACE
export NCCL_DEBUG=TRACE
export NCCL_DEBUG_FILE=/tmp/nccl_hang_%h_%p.log
# 所有 Rank 最后一行日志停在 "Channel 03/0 : 1 [send] via NET/IB/0/GDR"

# 2. 检查对应 NIC 的错误计数
ethtool -S mlx5_3 | grep -i discard
# rx_prio3_discards: 12478561  ← 大量 PFC priority 3 丢弃

# 3. 检查 IB 物理层
perfquery -x 3 1
# LinkErrorRecoveryCounter: 37  ← 链路有抖动

# 4. 交换机侧日志
# 显示 ECN 标记持续上升 + PFC pause 帧暴增
# 某端口的 buffer 被耗尽，触发了 head-of-line blocking
```

**根因**：网络中某条 RoCE 链路（mlx5_3 对应的交换机端口）buffer 配置过小，在大规模 AllReduce 的 incast 模式下（多 Rank 同时向同一 Rank 发送），交换机 buffer 溢出触发 PFC，PFC 级联导致整网暂停——但恢复后 NCCL 已失去了同步。

**修复**：
```bash
# 交换机侧增大 headroom buffer 和 total buffer
# 在 Mellanox Spectrum 交换机上：
#   buffer pool size 增大到 2×
#   PFC headroom 增大到 ~120KB per port

# 训练侧启用 Adaptive Routing 分散 incast 压力
export NCCL_IB_AR_THRESHOLD=8192  # 消息 > 8KB 启用自适应路由

# 降低 Sharp（若启用）的聚合粒度
# 避免单个交换机端口承载过多汇聚流量
```

### 案例 2：训练吞吐骤降至 50% —— PCIe 降速

**场景**：A100 8 卡节点，新增节点后训练吞吐只有预期的 48%。

**症状**：
- 单节点 `all_reduce_perf -b 8 -e 2G -f 2 -g 8` 带宽只有正常节点的 ~50%
- NVLink 速度正常（~400 GB/s 大消息）
- 跨节点通信速度正常

**诊断步骤**：
```bash
# 1. 查 PCIe 链路
nvidia-smi --query-gpu=index,pci.bus_id,pcie.link.gen.current,pcie.link.width.current --format=csv
# index, pci.bus_id, pcie.link.gen.current, pcie.link.width.current
# 0, 00000000:17:00.0, 1, x16          ← PCIe Gen1 x16 ?!
# 1, 00000000:65:00.0, 1, x16
# ... 全部 GPU 都是 PCIe Gen1

# 正常节点的期望值：
# 0, 00000000:17:00.0, 4, x16          ← PCIe Gen4 x16

# 2. 用 lspci 交叉验证
lspci -vvv -s 17:00.0 | grep LnkSta
# LnkSta: Speed 2.5GT/s (downgraded), Width x16 ← 确实降速到 Gen1

# 3. 查 BIOS 设置
# PCIe ASPM (Active State Power Management) 是否开启
# 进入 BIOS → PCIe Configuration → ASPM = Disabled

# 4. 查硬件
# GPU 是否插在正确的 PCIe 插槽
# GPU riser 卡是否松动
```

**根因**：新节点 BIOS 中 `PCIe ASPM` 默认开启，导致链路自动降速到 Gen1。同时 GPU riser 卡有一半金手指未完全插入，x16 链路中只有 x8 实际连通。

**修复**：
```bash
# 1. BIOS 禁用 ASPM
# 2. 重新插拔 GPU riser 卡
# 3. 确认所有 GPU 都在 Gen4 x16
nvidia-smi --query-gpu=index,pcie.link.gen.current,pcie.link.width.current --format=csv
# → 全部 Gen4 x16
```

### 案例 3：NCCL Init Failure —— NCCL_IB_HCA 配置 + 版本不一致

**场景**：容器化训练环境，新扩容 32 个节点后 8 个节点报 `ncclSystemError`。

**症状**：
- 报错节点日志：`NCCL WARN NET/IB : No IB devices found, falling back to socket`
- 后继续报：`ncclSystemError: System call failed`
- 正常节点能初始化和通信，异常节点无法 join communicator

**诊断步骤**：
```bash
# 1. 检查 IB 设备是否存在
# 异常节点上
ibstat --list_of_cas
# mlx5_0, mlx5_2, mlx5_4, mlx5_6  ← 设备索引跳跃！新节点网卡命名不同

# 2. 查看 NCCL 环境变量
env | grep NCCL_IB_HCA
# NCCL_IB_HCA=mlx5_0,mlx5_1,mlx5_2,mlx5_3
# mlx5_1 和 mlx5_3 在新节点上不存在 → NCCL 找不到任何 IB 设备 → fallback 到 socket

# 3. 查容器镜像
# 正常节点：nccl 2.19.3, cuda 12.2
# 异常节点：nccl 2.18.1, cuda 12.2  ← 镜像同 tag 但 digest 不同！
docker inspect --format='{{.RepoDigests}}' <image>
# 正常节点：nvcr.io/nvidia/pytorch:23.10-py3@sha256:abc123...
# 异常节点：nvcr.io/nvidia/pytorch:23.10-py3@sha256:def456...
```

**根因**：
1. 新节点网卡编号为 `mlx5_0, mlx5_2, mlx5_4, mlx5_6`（跳号），老的 `NCCL_IB_HCA=mlx5_0,mlx5_1,mlx5_2,mlx5_3` 在新节点上只匹配到 2 张（mlx5_0, mlx5_2），NCCL 发现设备不完整直接 fallback
2. 新节点的容器镜像 digest 不同（相同 tag 但不同构建），NCCL 版本降级到 2.18.1

**修复**：
```bash
# 1. 修正 NCCL_IB_HCA（按实际设备名）
# 使用 = 前缀让 NCCL 自动匹配
export NCCL_IB_HCA="=mlx5_0,mlx5_2,mlx5_4,mlx5_6"

# 更好的做法：不写死 HCA，或动态探测
NCCL_IB_HCA=$(ibstat --list_of_cas | tr '\n' ',' | sed 's/,$//')
export NCCL_IB_HCA="=$NCCL_IB_HCA"

# 2. 锁定容器镜像到具体 digest
# 在 K8s Pod spec 中：
#   image: nvcr.io/nvidia/pytorch:23.10-py3@sha256:abc123...
# 在 docker-compose / slurm 中同理

# 3. 标准化节点配置
# 确保所有节点 BIOS、网卡固件、OFED 版本、NCCL 版本完全一致
# 用 Ansible/SALT 定期巡检并告警不一致
```

### 案例 4：跨 NUMA 路由导致单节点内 NCCL 带宽腰斩

**场景**：H100 8 卡 SXM，`all_reduce_perf -b 1G -e 1G -g 8` 只有 ~280 GB/s（期望 ~450 GB/s）。

**症状**：
- NVSwitch 链路全部正常（`nvidia-smi nvlink -s` 全部 active）
- 跨节点带宽正常
- 仅单节点内 8 卡 all_reduce 带宽偏低

**诊断步骤**：
```bash
# 1. NVSwitch 基线
nvidia-smi nvlink -s | grep "<inactive>"   # 无输出 → NVSwitch OK

# 2. 检查 NCCL 的拓扑选择
export NCCL_DEBUG=INFO
grep "NCCL INFO" /tmp/nccl.log | grep -E "Channel|NET|Ring|Tree"
# NCCL INFO Ring 00 : 0[0] -> 1[0] -> 2[0] -> ... via NET/IB/0/GDR
# 关键：via NET/IB → 说明 NCCL 走了跨节点网络而非 NVSwitch！

# 3. 查看 NCCL graph
grep "nchannels" /tmp/nccl_graph.xml
# <nchannels>8</nchannels>  ← 但 8 卡 NVSwitch 应 24+ channels

# 4. 检查 NCCL_NET_GDR_LEVEL 和 NCCL_P2P_LEVEL
env | grep NCCL_P2P
# NCCL_P2P_DISABLE=1  ← 这！禁用了 GPU P2P（含 NVLink）

# NCCL_P2P_LEVEL=LOC  也有限制
```

**根因**：启动脚本中错误地设置了 `NCCL_P2P_DISABLE=1`（可能是从前一个需要调试的配置遗留），NCCL 被迫所有通信都走 NIC → 跨 NUMA/交换机路由，单节点内带宽从 NVSwitch 的 ~450 GB/s 跌到 ~280 GB/s。

**修复**：
```bash
# 确保以下设置
export NCCL_P2P_DISABLE=0                # 启用 P2P（默认）
export NCCL_P2P_LEVEL=NVL                # 优先 NVLink（等价于 AUTO）
export NCCL_NVLS_ENABLE=1                # H100+ 启用 NVLink Sharp

# 验证
all_reduce_perf -b 1G -e 1G -g 8 -n 20 | grep "out-of-place"
# BusBW 恢复到 ~450 GB/s
```

---

## 关联知识

- [[../network/NCCL 通信原理与调优]]
- [[../network/RDMA 与 InfiniBand 详解]]
- [[../network/GPU 集群网络拓扑设计]]
- [[GPU Xid 错误排查手册]]
- [[../hardware/NVLink 与 NVSwitch 拓扑详解]]
- [[GPU 集群运维知识总览]]

---

## 参考资源

- [NCCL 官方文档](https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/)
- [NCCL Tests GitHub](https://github.com/NVIDIA/nccl-tests)
- [perftest (RDMA 性能测试)](https://github.com/linux-rdma/perftest)
- [NVIDIA Fabric Manager 文档](https://docs.nvidia.com/datacenter/tesla/fabric-manager-user-guide/)
- [Mellanox OFED 文档](https://docs.nvidia.com/networking/display/MLNXOFEDv24071000)
- [RoCE 拥塞控制 (DCQCN) 最佳实践](https://community.mellanox.com/s/article/roce-configuration-for-lossless-networks)
- [GPUDirect RDMA 文档](https://docs.nvidia.com/cuda/gpudirect-rdma/)

---

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 骨架创建 | 2026-06-30 | 框架搭建 |
| 全面重写 | 2026-06-30 | NCCL Hang/Timeout/Bandwidth/Init 完整诊断 + 工具包 + 案例 |

---

## 状态标记

| 状态 | 内容 |
|------|------|
| 📖 已掌握 | NCCL Hang 检测与根因分类 (IB link flap / buffer overflow / GPU stuck)、NCCL_DEBUG 三级使用策略、all_reduce_perf 基准测试与结果解读、GDR 启用验证方法、PCIe 降速检测 (nvidia-smi + lspci)、NCCL_GRAPH_DUMP_FILE 拓扑诊断、ib_write_bw 网络基线测试、诊断决策树四分支流程、NCCL_IB_HCA 按 NUMA 配置、超时安全调大策略 |
| 📝 待补充 | IB 交换机侧 PFC/Buffer 深度诊断（Spectrum-2/3/4 差异）、NCCL 2.22+ NVLS Sharp Host（跨节点 Sharp）故障模式、AWS EFA / GCP GPUDirect-TCP 的 NCCL 插件排障、Congestion Control (DCQCN/RPCS) 参数调优、NCCL 跨子网/跨 region 通信故障、PCIe ACS/ACS redirection 导致的 P2P 降级、NCCL_TOPO_FILE 自定义拓扑排错、多 Job 共享同一 GPU 集群时的 NUMA / NIC 隔离策略 |

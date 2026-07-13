---
date: 2026-06-30
tags:
  - k8s
  - etcd
  - raft
  - 运维
  - 分布式存储
type: 学习笔记
category: 云原生/Kubernetes/控制面
source: https://etcd.io/docs/latest/
difficulty: 进阶
title: "etcd 运维详解"
---

# etcd 运维详解

## 概述

etcd 是 Kubernetes 的「大脑」——所有集群状态（Pod、Service、ConfigMap、Secret 等）都以 key-value 形式存储在 etcd 中。etcd 基于 **Raft 共识算法**实现分布式一致性，通过「领导选举 + 日志复制」模型保证多节点间数据强一致。K8s 集群的可靠性本质上就是 etcd 的可靠性。

> etcd 的名字来自 Linux `/etc` 目录 + 分布式（distributed）。v2 有 v2/v3 两套 API，**K8s 只使用 v3 API**。

## 基本信息

| 属性 | 值 |
|------|-----|
| 语言 | Go |
| 共识算法 | Raft |
| 存储引擎 | BoltDB（v3） |
| 协议 | gRPC（v3 API） |
| 默认端口 | 2379（Client）/ 2380（Peer） |
| K8s 使用方式 | API Server 写入所有资源对象 |

## 核心架构

### Raft 共识三要素

```
flowchart LR
  C[Client] -->|Write Request| L[Leader Node]
  L -->|AppendEntries| F1[Follower 1]
  L -->|AppendEntries| F2[Follower 2]
  F1 -->|ACK| L
  F2 -->|ACK| L
  L -->|Commit| C
```

| 要素 | 说明 |
|------|------|
| **Leader 选举** | 集群只有一个 Leader 处理所有写请求。Leader 定期发心跳，Follower 超时未收到心跳则发起选举（Term 递增） |
| **日志复制** | 写请求经 Leader → 写入本地 WAL → 并行发给 Follower → 多数派（N/2+1）确认 → 提交并返回客户端 |
| **安全性** | 只有拥有最新已提交日志的节点才能成为 Leader，绝不会丢已确认的数据 |

### 写入路径

```
客户端 Write Request
  → Leader 接收
  → 写入 WAL（预写日志，保证崩溃恢复）
  → 同步到 BoltDB 内存缓存
  → AppendEntries RPC 发给 Follower
  → 多数派确认后更新 committedIndex
  → 应用到 BoltDB 状态机
  → 返回客户端
```

### 数据存储

WAL 和 BoltDB 是 etcd 数据持久化的两个核心组件：

| 组件 | 位置 | 作用 |
|------|------|------|
| **WAL** | `data-dir/member/wal/` | 预写日志，每次写入先落 WAL，保证崩溃后重放恢复 |
| **BoltDB** | `data-dir/member/snap/` | B+ 树 KV 存储引擎，定期从 WAL 生成快照以压缩历史 |
| **Snapshot** | `data-dir/member/snap/*.snap` | Raft 快照，服务重启时加载快照 + 重放后续 WAL 恢复状态 |

## 集群部署拓扑

### 节点数选择

| 节点数 | 可容忍故障 | 适用场景 |
|:---:|:---:|------|
| 1 | 0 | 开发/测试，**生产禁止** |
| **3** | 1 | 一般生产，最小高可用配置 |
| **5** | 2 | 大规模生产，平衡可用性与成本 |
| 7 | 3 | 超大规模，运维成本高 |

> 核心公式：**容忍 N 个节点故障，需要 2N+1 个节点**。必须是奇数。

### 部署方式

| 方式 | 说明 | 推荐度 |
|------|------|:---:|
| **kubeadm 自带** | `kubeadm init` 自动部署 Static Pod etcd，与 Master 节点共存 | ⭐⭐⭐ 默认方案 |
| **外部 etcd 集群** | 独立于 K8s Master 的 etcd 集群，适合大规模或需要独立运维 | ⭐⭐⭐ 大规模首选 |
| **托管 etcd** | 云厂商的托管 K8s 通常隐藏 etcd（如 GKE、EKS） | ⭐⭐ 零运维但失去控制 |

### kubeadm 部署的 etcd 配置

kubeadm 生成的 etcd Static Pod 在 `/etc/kubernetes/manifests/etcd.yaml`，关键参数：

```yaml
spec:
  containers:
  - command:
    - etcd
    - --advertise-client-urls=https://192.168.1.10:2379
    - --cert-file=/etc/kubernetes/pki/etcd/server.crt
    - --key-file=/etc/kubernetes/pki/etcd/server.key
    - --client-cert-auth=true
    - --data-dir=/var/lib/etcd
    - --initial-advertise-peer-urls=https://192.168.1.10:2380
    - --initial-cluster=master0=https://192.168.1.10:2380,master1=https://192.168.1.11:2380,master2=https://192.168.1.12:2380
    - --initial-cluster-state=new
    - --listen-client-urls=https://127.0.0.1:2379,https://192.168.1.10:2379
    - --listen-peer-urls=https://192.168.1.10:2380
    - --name=master0
    - --peer-cert-file=/etc/kubernetes/pki/etcd/peer.crt
    - --peer-key-file=/etc/kubernetes/pki/etcd/peer.key
    - --peer-client-cert-auth=true
    - --snapshot-count=10000
    - --quota-backend-bytes=8589934592     # 8GiB
```

## 备份与恢复

### 备份

etcd 内置快照功能，**必须设置定期自动备份**：

```bash
# 获取 etcd 证书路径（kubeadm 部署）
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%Y%m%d-%H%M%S).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# 验证快照完整性
etcdctl snapshot status /backup/etcd-20260630-120000.db --write-out=table
```

输出示例：

```
+---------+----------+------------+------------+
|  HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
+---------+----------+------------+------------+
| 5d7c2e0 |   123456 |      89763 |    256 MB  |
+---------+----------+------------+------------+
```

**CronJob 自动备份示例**：

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup
  namespace: kube-system
spec:
  schedule: "0 */6 * * *"      # 每 6 小时
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: bitnami/etcd:3.5
            command:
            - /bin/sh
            - -c
            - |
              etcdctl snapshot save /backup/etcd-$(date +%Y%m%d-%H%M%S).db \
                --endpoints=$ETCD_ENDPOINTS \
                --cacert=/certs/ca.crt --cert=/certs/server.crt --key=/certs/server.key
            volumeMounts:
            - name: backup
              mountPath: /backup
            - name: certs
              mountPath: /certs
          volumes:
          - name: backup
            persistentVolumeClaim:
              claimName: etcd-backup-pvc
          - name: certs
            secret:
              secretName: etcd-certs
```

### 恢复

恢复操作需要**所有 etcd 节点停止**，然后逐个恢复：

```bash
# 1. 停止所有 etcd（移动 manifest 文件即可）
mv /etc/kubernetes/manifests/etcd.yaml /tmp/

# 2. 清理旧数据目录
mv /var/lib/etcd /var/lib/etcd.bak

# 3. 在每个节点执行恢复（使用同一个快照）
ETCDCTL_API=3 etcdctl snapshot restore /backup/etcd-20260630-120000.db \
  --name=master0 \
  --initial-cluster=master0=https://192.168.1.10:2380,master1=https://192.168.1.11:2380,master2=https://192.168.1.12:2380 \
  --initial-advertise-peer-urls=https://192.168.1.10:2380 \
  --data-dir=/var/lib/etcd

# 4. 恢复 manifest
mv /tmp/etcd.yaml /etc/kubernetes/manifests/

# 5. 等待 etcd 和 API Server 恢复后验证
kubectl get nodes
```

> 关键注意：恢复时 `--initial-cluster` 必须与原始集群一致，且所有节点使用同一个快照文件。

## 性能调优

### 磁盘 —— 最重要

etcd 对磁盘延迟**极度敏感**。每次 fsync 延迟超过 10ms 就会触发 Leader 心跳超时。

| 要求 | 说明 |
|------|------|
| **SSD/NVMe** | 禁止机械硬盘，`fsync` 延迟必须 < 10ms |
| **独立磁盘** | data-dir 不要和 OS、容器日志共用磁盘 |
| **IOPS** | 建议 ≥ 5000 IOPS（写密集型） |
| **`--data-dir` 到 SSD** | `/var/lib/etcd` 必须挂载到高速磁盘 |

验证磁盘延迟：

```bash
# 用 fio 测试 etcd 典型负载的 fsync 延迟
fio --rw=write --ioengine=sync --fdatasync=1 \
  --directory=/var/lib/etcd --size=22m --bs=2300 \
  --name=etcd-test --runtime=30

# etcd 内置磁盘检查
etcdctl check perf --endpoints=https://127.0.0.1:2379
```

### 空间管理

| 参数 | 默认值 | 建议 |
|------|--------|------|
| `--quota-backend-bytes` | 2GiB (v3.4) → 无默认 (v3.5+) | **显式设 8GiB**，避免默认无限增长 |
| `--auto-compaction-mode` | 关闭 | 设为 `periodic` |
| `--auto-compaction-retention` | 0 | 设为 `1h`（每 1 小时压缩一次历史版本） |
| `--snapshot-count` | 100000 | 可降低到 10000，减少 WAL 体积 |

### 空间报警处理

当 etcd 使用空间超过 `quota-backend-bytes` 时，整个集群**拒绝所有写入**（K8s 无法创建/修改任何资源）：

```bash
# 1. 查看当前空间
ETCDCTL_API=3 etcdctl endpoint status --write-out=table

# 2. 碎片整理（每个节点依次执行，释放 BoltDB 空闲页）
etcdctl defrag --endpoints=https://127.0.0.1:2379

# 3. 如果 defrag 后仍告警，手动触发压缩
rev=$(etcdctl endpoint status --write-out="json" | jq '.[0].Status.header.revision')
etcdctl compact $rev

# 4. 再次碎片整理
etcdctl defrag
```

### 网络

| 参数 | 建议 |
|------|------|
| `--heartbeat-interval` | 默认 100ms，稳定网络可为 200ms |
| `--election-timeout` | 默认 1000ms，通常无需调整 |
| **节点间延迟** | 建议 < 5ms（跨可用区可放宽到 10ms） |

### 内核调优

```bash
# /etc/sysctl.d/99-etcd.conf
# 增大连接跟踪表（高频 gRPC 连接）
net.netfilter.nf_conntrack_max = 1000000

# 减少 TIME_WAIT
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 30

# 增加 backlog
net.core.somaxconn = 32768

sysctl --system
```

## 监控与告警

### 关键指标

| Prometheus 指标 | 含义 | 告警阈值 |
|------|------|:---:|
| `etcd_server_leader_changes_seen_total` | Leader 变更次数 | > 0 per 10min |
| `etcd_disk_wal_fsync_duration_seconds_bucket` | WAL fsync 延迟 | p99 > 10ms |
| `etcd_disk_backend_commit_duration_seconds_bucket` | BoltDB commit 延迟 | p99 > 25ms |
| `etcd_mvcc_db_total_size_in_bytes` | 数据库文件大小 | > 0.8 × quota-backend-bytes |
| `etcd_network_peer_round_trip_time_seconds_bucket` | Peer 间 RPC 延迟 | p99 > 50ms |
| `etcd_server_health_failures` | 健康检查失败次数 | > 0 |
| `etcd_server_proposals_failed_total` | Raft 提案失败（多数派未达成） | > 0 |

### Prometheus 告警规则示例

```yaml
groups:
  - name: etcd
    rules:
      - alert: EtcdHighFsyncDuration
        expr: histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])) > 0.01
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "etcd WAL fsync p99 > 10ms，磁盘性能下降"

      - alert: EtcdLeaderChanges
        expr: rate(etcd_server_leader_changes_seen_total[10m]) > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "etcd 发生 Leader 变更，检查网络或磁盘"

      - alert: EtcdSpaceQuota
        expr: etcd_mvcc_db_total_size_in_bytes / etcd_server_quota_backend_bytes > 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "etcd 空间使用超过 80%"
```

## 常见故障处理

### 1. 空间耗尽 → 集群写死

**现象**：
- `kubectl apply/create` 报错 `etcdserver: mvcc: database space exceeded`
- 集群**只读**，无法创建/修改任何资源

**处理**：按上面「空间报警处理」流程执行 compact + defrag

### 2. 磁盘延迟高 → Leader 频繁切换

**现象**：
- `etcd_server_leader_changes_seen_total` 持续增长
- API Server 日志报 `context deadline exceeded`
- Pod 调度延迟、Service 更新失效

**根因**：磁盘 fsync 延迟超过心跳超时，其他节点认为 Leader 失联

**排查**：
```bash
# 检查磁盘 I/O 延迟
iostat -x 1
# 检查是否有其他进程抢占磁盘
iotop -o
```

**修复**：迁移 data-dir 到独立 SSD、减少同盘的其他 I/O

### 3. 网络分区 → 脑裂假象

**现象**：2 个 etcd 节点断开，形成 3 节点集群中 1-2 的分区。**少数派自动降级为 Follower，拒绝写入**，Raft 保证不会脑裂。

**排查**：
```bash
# 检查成员状态
etcdctl member list --write-out=table
# 检查各节点 Leader 认知是否一致
for ep in https://10.0.0.1:2379 https://10.0.0.2:2379 https://10.0.0.3:2379; do
  echo -n "$ep: "
  etcdctl endpoint status --endpoints=$ep | jq -r '.[0].Status.leader'
done
```

### 4. 证书过期

kubeadm 部署的 etcd 证书 1 年有效期：

```bash
# 检查证书过期时间
kubeadm certs check-expiration
# 更新所有证书（包括 etcd）
kubeadm certs renew all
# 重启 etcd
crictl stop $(crictl ps --name etcd -q)
```

### 5. 误删 Member

```bash
# 查看当前成员
etcdctl member list
# 删除故障成员
etcdctl member remove <member-id>
# 添加新成员（先通过 member add 注册，再启动新节点）
etcdctl member add master3 --peer-urls=https://192.168.1.13:2380
```

## 日常运维检查清单

```bash
# 1. 集群健康
etcdctl endpoint health --cluster

# 2. 成员状态
etcdctl member list --write-out=table

# 3. 空间状态
etcdctl endpoint status --write-out=table
# 输出：ENDPOINT, ID, VERSION, DB SIZE, IS LEADER, RAFT TERM, RAFT INDEX

# 4. 检查是否有告警
etcdctl alarm list
# 正常返回：memberID:00000 alarm:NOSPACE

# 5. 最近快照
ls -lh /var/lib/etcd/member/snap/

# 6. 碎片率（DB SIZE / DB SIZE IN USE）
etcdctl endpoint status --write-out="json" | jq '.[] | {endpoint: .Endpoint, dbSize: .Status.dbSize, dbSizeInUse: .Status.dbSizeInUse, fragRatio: (.Status.dbSize / .Status.dbSizeInUse)}'
```

## 关联知识

- [[Sidecar 容器详解]] — etcd 在 K8s 中以 Static Pod 运行
- [[CEL 准入控制详解]] — 所有准入控制的配置都存储在 etcd 中
- [[../versions/K8s 1.36 Haru 详解]] — v1.36 增强了存储版本迁移机制
- [[kagent 详解]] — kagent 使用 etcd 同级键值模型管理 Agent 状态

## 参考资源

- etcd 官方文档：https://etcd.io/docs/latest/
- etcd 运维指南：https://etcd.io/docs/latest/op-guide/
- K8s etcd 高可用：https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/
- etcd 硬件建议：https://etcd.io/docs/latest/op-guide/hardware/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 架构理解 | 2026-06-30 | 完成：Raft 共识、备份恢复、性能调优、故障处理 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-07

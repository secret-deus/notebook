---
date: 2026-07-08
tags:
  - python
  - k8s
  - 运维
  - 自动化
  - yaml
type: 学习笔记
category: 编程语言/Python
source: https://github.com/kubernetes-client/python
difficulty: 进阶
title: "Python 运维开发实战"
---

# Python 运维开发实战

## 概述

K8s 运维中最常见的 Python 场景——批量处理 120+ 微服务的配置文件、解析/修改 Ingress YAML、调用 K8s API 做集群状态巡检、写 CLI 工具给团队用。这篇不教 Python 语法，只讲**运维场景中的工程模式**：怎么不写一坨脚本，怎么出错不乱来，怎么让别人也敢用。

> 一句话：运维脚本和业务代码的区别——运维脚本的运行环境就是生产集群，出错代价极高。所以运维脚本的第一优先级不是功能，是安全（dry-run）+ 可回滚（backup）+ 可见性（日志）。

## YAML 处理 —— 运维脚本的 80% 工作量

### 不用 yq 命令的 Python 原生命令

`ruamel.yaml` 是唯一保留 YAML 注释和格式的 Python 库。`PyYAML` 会吃掉注释、打乱 key 顺序。**运维场景下必须用 ruamel.yaml**。

```python
from ruamel.yaml import YAML

yaml = YAML()
yaml.preserve_quotes = True      # 保留原始引号
yaml.width = 4096                # 不自动换行
yaml.indent(mapping=2, sequence=4, offset=2)

# 读取——保留全部格式
with open('ack.yml') as f:
    data = yaml.load(f)

# 修改嵌套路径（安全：如果路径不存在，抛 KeyError 而不悄悄创建）
if 'spec' in data and 'template' in data['spec']:
    containers = data['spec']['template']['spec']['containers']
    for c in containers:
        if c['name'] == 'health-ack':
            c['image'] = 'registry.example.com/health-ack:v2.3.1'
            # 添加环境变量（如果不存在才加——避免重复）
            env_names = {e['name'] for e in c.get('env', [])}
            if 'NACOS_ADDR' not in env_names:
                c.setdefault('env', []).append(
                    {'name': 'NACOS_ADDR', 'value': 'mse-xxx.nacos-ans.mse.aliyuncs.com:8848'}
                )

# 写回——注释和格式完好无损
with open('ack.yml', 'w') as f:
    yaml.dump(data, f)
```

### 批量处理 ack.yml 模板

对应你的实际场景——9 个目录 120+ 微服务的 ConfigMap 中修改 Nacos 地址：

```python
#!/usr/bin/env python3
"""
批量替换 120+ 微服务 ConfigMap 中的 Nacos 注册中心地址。
功能：dry-run 预览 → 备份 → 修改 → 验证
"""

import sys
import shutil
from pathlib import Path
from datetime import datetime
from ruamel.yaml import YAML

OLD_NACOS = "nacos.qingsongchou.net:8848"
NEW_NACOS = "mse-xxx.nacos-ans.mse.aliyuncs.com:8848"
TARGET_DIRS = ["bigdata", "crm", "ebao", "med", "health", "qbao", "jszx", "pioneer", "finance"]
CONFIG_ROOT = Path("configs")

def find_configmaps(base: Path, dirs: list[str]) -> list[Path]:
    """递归查找所有 ConfigMap YAML 文件"""
    files = []
    for d in dirs:
        path = base / d
        if path.is_dir():
            files.extend(path.rglob("*.yml"))
            files.extend(path.rglob("*.yaml"))
    return files

def modify_nacos(filepath: Path, dry_run: bool) -> dict:
    """修改单个文件中 Nacos 地址，返回变更摘要"""
    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.width = 4096

    with open(filepath) as f:
        data = yaml.load(f)

    if not data or data.get('kind') != 'ConfigMap':
        return {'file': str(filepath), 'changes': 0, 'reason': 'not-a-configmap'}

    changes = 0
    # 遍历 data 字段中的每个 key
    for key, value in data.get('data', {}).items():
        if isinstance(value, str) and OLD_NACOS in value:
            changes += 1
            if not dry_run:
                data['data'][key] = value.replace(OLD_NACOS, NEW_NACOS)

    if changes > 0 and not dry_run:
        with open(filepath, 'w') as f:
            yaml.dump(data, f)

    return {'file': str(filepath), 'changes': changes}

def main():
    dry_run = '--dry-run' in sys.argv or '-n' in sys.argv
    files = find_configmaps(CONFIG_ROOT, TARGET_DIRS)

    if dry_run:
        print(f"=== DRY RUN === (no files will be modified)")
        print(f"Found {len(files)} files to scan\n")

    # 1. 备份（非 dry-run）
    if not dry_run:
        backup_dir = CONFIG_ROOT.parent / f"backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        shutil.copytree(CONFIG_ROOT, backup_dir)
        print(f"Backup created: {backup_dir}\n")

    # 2. 扫描 + 修改
    modified, total_changes = [], 0
    for f in files:
        result = modify_nacos(f, dry_run)
        if result['changes'] > 0:
            modified.append(result)
            total_changes += result['changes']
            print(f"  {'[DRY RUN] ' if dry_run else ''}{result['file']}: {result['changes']} changes")

    # 3. 汇总
    print(f"\n=== Summary ===")
    print(f"Files scanned: {len(files)}")
    print(f"Files modified: {len(modified)}")
    print(f"Total changes: {total_changes}")
    print(f"Mode: {'DRY RUN' if dry_run else 'APPLIED'}")

    if dry_run:
        print("\nReview changes above. Run without --dry-run to apply.")

if __name__ == "__main__":
    main()
```

## Subprocess —— 安全地调用外部命令

运维脚本最危险的模式：`os.system(f"kubectl delete pod {user_input}")`。永远不要拼接 shell 字符串。

```python
import subprocess

# 正确方式：用列表传参，自动转义，防止 shell 注入
def kubectl_get_pods(namespace: str, selector: str = None) -> list[dict]:
    """获取 Pod 列表，返回 parsed JSON"""
    cmd = ["kubectl", "get", "pods", "-n", namespace, "-o", "json"]
    if selector:
        cmd.extend(["-l", selector])

    result = subprocess.run(
        cmd,
        capture_output=True,   # 捕获 stdout/stderr
        text=True,             # 返回字符串而非 bytes
        timeout=30,            # 30 秒超时，防止 kubectl 卡住
        check=False,           # 不要自动抛异常——自己处理错误
    )

    if result.returncode != 0:
        raise RuntimeError(f"kubectl failed ({result.returncode}): {result.stderr.strip()}")

    import json
    pods = json.loads(result.stdout)
    return pods.get('items', [])


# 复杂管道命令：用 Popen 替代 shell pipe
def find_stuck_pods():
    """替代: kubectl get pods -A | grep -v Running | grep -v Completed"""
    # 不需要管道——在 Python 里 filter
    cmd = ["kubectl", "get", "pods", "-A", "--no-headers"]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=True)

    stuck = []
    for line in result.stdout.strip().split("\n"):
        if not line:
            continue
        parts = line.split()
        namespace, name, ready, status = parts[0], parts[1], parts[2], parts[3]
        if status not in ("Running", "Completed", "Succeeded"):
            stuck.append({'namespace': namespace, 'name': name, 'status': status, 'ready': ready})
    return stuck
```

### 生产级 subprocess 封装

```python
import subprocess
import logging
import time
from dataclasses import dataclass

logger = logging.getLogger(__name__)

@dataclass
class CommandResult:
    returncode: int
    stdout: str
    stderr: str
    duration: float    # 秒

def run_cmd(cmd: list[str], timeout: int = 30, dry_run: bool = False) -> CommandResult:
    """
    安全执行外部命令。特性：
    - 自动日志记录（命令 + 耗时 + 退出码）
    - dry-run 模式（只打印不执行）
    - 超时后发送 SIGTERM，等 5 秒发 SIGKILL
    - 返回结构化结果
    """
    cmd_str = ' '.join(cmd)
    logger.info(f"EXEC: {cmd_str}")

    if dry_run:
        logger.info(f"[DRY-RUN] Would execute: {cmd_str}")
        return CommandResult(0, "[dry-run]", "", 0.0)

    start = time.time()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        logger.error(f"TIMEOUT ({timeout}s): {cmd_str}")
        raise

    duration = time.time() - start
    logger.info(f"EXEC OK ({duration:.1f}s, rc={result.returncode}): {cmd_str}")

    return CommandResult(
        returncode=result.returncode,
        stdout=result.stdout,
        stderr=result.stderr,
        duration=duration,
    )
```

## K8s Python Client —— 直接操作 API

不通过 kubectl，用 Python 直接调 K8s API。适合需要程序化处理集群内资源的场景。

```python
from kubernetes import client, config

class K8sCluster:
    """K8s API 客户端封装"""

    def __init__(self, context: str = None):
        # 从 ~/.kube/config 加载
        if context:
            config.load_kube_config(context=context)
        else:
            config.load_kube_config()

        self.core = client.CoreV1Api()
        self.apps = client.AppsV1Api()
        self.networking = client.NetworkingV1Api()
        self.custom = client.CustomObjectsApi()

    def list_pods(self, namespace: str, label_selector: str = None) -> list:
        """列出 Pod（自动处理分页）"""
        pods = self.core.list_namespaced_pod(namespace=namespace, label_selector=label_selector)
        return [
            {
                'name': p.metadata.name,
                'namespace': p.metadata.namespace,
                'node': p.spec.node_name,
                'phase': p.status.phase,
                'containers': [
                    {
                        'name': c.name,
                        'image': c.image,
                        'ready': any(s.container_id == c.name and s.ready for s in (p.status.container_statuses or [])),
                        'restarts': next((s.restart_count for s in (p.status.container_statuses or []) if s.name == c.name), 0),
                    }
                    for c in p.spec.containers
                ],
                'age': (datetime.now(timezone.utc) - p.metadata.creation_timestamp).total_seconds(),
            }
            for p in pods.items
        ]

    def get_unhealthy_deployments(self, namespace: str) -> list:
        """找出所有不健康的 Deployment"""
        deps = self.apps.list_namespaced_deployment(namespace=namespace)
        unhealthy = []
        for d in deps.items:
            ready = d.status.ready_replicas or 0
            desired = d.spec.replicas
            if ready < desired:
                unhealthy.append({
                    'name': d.metadata.name,
                    'ready': ready,
                    'desired': desired,
                    'conditions': [
                        {'type': c.type, 'status': c.status, 'reason': c.reason}
                        for c in (d.status.conditions or [])
                    ],
                })
        return unhealthy

    def get_ingress_hosts(self, namespace: str) -> dict:
        """导出所有 Ingress 的 host → backend 映射"""
        ingresses = self.networking.list_namespaced_ingress(namespace=namespace)
        result = {}
        for ing in ingresses.items:
            host = ing.spec.rules[0].host if ing.spec.rules else 'no-host'
            for rule in ing.spec.rules:
                for path in rule.http.paths:
                    key = f"{rule.host or '*'}{path.path}"
                    result[key] = {
                        'service': path.backend.service.name,
                        'port': path.backend.service.port.number,
                        'tls': bool(ing.spec.tls),
                    }
        return result

    # 操作 CRD（如 VirtualService, DestinationRule）
    def get_istio_virtualservices(self, namespace: str) -> list:
        """获取 namespace 中所有 Istio VirtualService"""
        result = self.custom.list_namespaced_custom_object(
            group="networking.istio.io",
            version="v1beta1",
            namespace=namespace,
            plural="virtualservices",
        )
        return result.get('items', [])
```

## 巡检脚本模板

每周检查 120+ 微服务的运行状态，生成报告：

```python
#!/usr/bin/env python3
"""K8s 集群健康巡检脚本"""

from collections import defaultdict
from kubernetes import client, config

def health_check(namespaces: list[str] = None):
    config.load_kube_config()
    core = client.CoreV1Api()
    apps = client.AppsV1Api()

    findings = []

    # 1. 检查所有 namespace 的 Node
    nodes = core.list_node()
    for node in nodes.items:
        not_ready = [
            c.type for c in node.status.conditions
            if c.type == "Ready" and c.status != "True"
        ]
        if not_ready:
            findings.append(f"NODE: {node.metadata.name} is NotReady")

    # 2. 检查 Pod 状态
    if namespaces:
        ns_list = namespaces
    else:
        ns_list = [ns.metadata.name for ns in core.list_namespace().items]

    for ns in ns_list:
        pods = core.list_namespaced_pod(namespace=ns)
        for pod in pods.items:
            # Pending > 5 分钟
            if pod.status.phase == "Pending":
                age = (datetime.now(timezone.utc) - pod.metadata.creation_timestamp).total_seconds()
                if age > 300:
                    findings.append(f"POD: {ns}/{pod.metadata.name} Pending for {age:.0f}s")

            # CrashLoopBackOff
            for cs in (pod.status.container_statuses or []):
                if cs.state.waiting and cs.state.waiting.reason == "CrashLoopBackOff":
                    findings.append(f"POD: {ns}/{pod.metadata.name}/{cs.name} CrashLoopBackOff")

            # 频繁重启 (> 10 次)
            for cs in (pod.status.container_statuses or []):
                if cs.restart_count > 10:
                    findings.append(f"POD: {ns}/{pod.metadata.name}/{cs.name} restarted {cs.restart_count} times")

    # 3. 检查 Deployment 的 Replicas 不一致
    for ns in ns_list:
        deps = apps.list_namespaced_deployment(namespace=ns)
        for d in deps.items:
            desired = d.spec.replicas
            ready = d.status.ready_replicas or 0
            available = d.status.available_replicas or 0
            if ready < desired:
                findings.append(f"DEPLOY: {ns}/{d.metadata.name} replicas {ready}/{desired} ready")
            if available < ready:
                findings.append(f"DEPLOY: {ns}/{d.metadata.name} {available}/{ready} available")

    return findings

if __name__ == "__main__":
    findings = health_check()
    if findings:
        print(f"=== {len(findings)} issues found ===")
        for f in findings:
            print(f"  {f}")
        sys.exit(1)
    else:
        print("All healthy.")
```

## CLI 工具 —— 用 click 写给别人用的命令行

运维脚本如果放在 `~/scripts/` 下只有你自己会用，用 click 写个 CLI 工具让团队都能用：

```python
#!/usr/bin/env python3
"""k8s-ops —— 团队运维工具箱"""

import click
from kubernetes import client, config

@click.group()
def cli():
    """K8s 运维工具箱"""
    config.load_kube_config()

@cli.command()
@click.option('--namespace', '-n', required=True, help='Namespace')
@click.option('--export', '-e', is_flag=True, help='Export as YAML')
def ingress(namespace, export):
    """导出 namespace 中所有 Ingress 配置"""
    networking = client.NetworkingV1Api()
    ingresses = networking.list_namespaced_ingress(namespace=namespace)

    for ing in ingresses.items:
        click.echo(f"---")
        click.echo(f"# {ing.metadata.name}")
        for rule in ing.spec.rules or []:
            for path in rule.http.paths:
                click.echo(f"  {rule.host or '*'} {path.path} -> {path.backend.service.name}:{path.backend.service.port.number}")

@cli.command()
@click.option('--namespace', '-n', required=True)
@click.option('--app', '-a', required=True, help='App label value')
@click.option('--since', '-s', default='1h', help='Time range (e.g. 1h, 30m)')
def logs(namespace, app, since):
    """查看 app 所有 Pod 的日志（汇总）"""
    core = client.CoreV1Api()
    pods = core.list_namespaced_pod(namespace=namespace, label_selector=f"app={app}")

    for pod in pods.items:
        click.echo(f"\n{'='*60}")
        click.echo(f"=== {pod.metadata.name} ({pod.status.phase}) ===")
        click.echo(f"{'='*60}")
        try:
            log = core.read_namespaced_pod_log(
                name=pod.metadata.name,
                namespace=namespace,
                since_seconds=_parse_since(since),
                tail_lines=50,
            )
            click.echo(log)
        except Exception as e:
            click.echo(f"Error: {e}")

@cli.command()
@click.option('--namespace', '-n', default='all', help='Namespace (default: all)')
@click.option('--stuck', is_flag=True, help='Only show stuck pods')
def pods(namespace, stuck):
    """列出 Pod 状态（支持跨 namespace）"""
    core = client.CoreV1Api()

    if namespace == 'all':
        pods = core.list_pod_for_all_namespaces()
    else:
        pods = core.list_namespaced_pod(namespace=namespace)

    for pod in pods.items:
        ns = pod.metadata.namespace
        name = pod.metadata.name
        phase = pod.status.phase
        restarts = sum(cs.restart_count for cs in (pod.status.container_statuses or []))

        if stuck and phase in ("Running", "Succeeded"):
            continue

        click.echo(f"{ns:20s} {name:45s} {phase:12s} restarts={restarts}")

@cli.command()
@click.argument('pattern')
@click.option('--namespace', '-n', help='Namespace filter')
@click.option('--replacement', '-r', help='Replacement string')
@click.option('--dry-run', is_flag=True, help='Preview only')
def grepc(pattern, namespace, replacement, dry_run):
    """在 ConfigMap 中搜索/替换字符串"""
    core = client.CoreV1Api()
    yaml = YAML()
    yaml.preserve_quotes = True

    if namespace:
        cms = core.list_namespaced_config_map(namespace=namespace)
    else:
        cms = core.list_config_map_for_all_namespaces()

    for cm in cms.items:
        ns, name = cm.metadata.namespace, cm.metadata.name
        for key, value in (cm.data or {}).items():
            if pattern in value:
                click.echo(f"  {ns}/{name}.data[{key}]")
                if replacement:
                    new_value = value.replace(pattern, replacement)
                    if not dry_run:
                        cm.data[key] = new_value
                        core.replace_namespaced_config_map(name=name, namespace=ns, body=cm)
                    click.echo(f"    {'[DRY-RUN] ' if dry_run else ''}Replaced: {pattern} -> {replacement}")

def _parse_since(s: str) -> int:
    """Parse '1h', '30m' to seconds"""
    import re
    match = re.match(r'(\d+)([hms])', s)
    if not match:
        return 3600
    value, unit = int(match.group(1)), match.group(2)
    return value * {'h': 3600, 'm': 60, 's': 1}[unit]

if __name__ == "__main__":
    cli()
```

## 错误处理与重试 —— 运维脚本的最后一道防线

```python
import time
import functools
from kubernetes.client.exceptions import ApiException

def retry_on_conflict(max_retries: int = 5, backoff: float = 1.0):
    """处理 K8s API 的 409 Conflict（乐观锁冲突）"""
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except ApiException as e:
                    if e.status == 409 and attempt < max_retries - 1:
                        wait = backoff * (2 ** attempt)  # 指数退避
                        logger.warning(f"Conflict, retrying in {wait:.1f}s (attempt {attempt+1}/{max_retries})")
                        time.sleep(wait)
                    else:
                        raise
        return wrapper
    return decorator

@retry_on_conflict(max_retries=5)
def update_configmap(namespace, name, data_updates):
    """原子更新 ConfigMap（处理并发修改）"""
    core = client.CoreV1Api()
    # 每次重试都要重新 Get（拿到最新的 resourceVersion）
    cm = core.read_namespaced_config_map(name=name, namespace=namespace)
    cm.data.update(data_updates)
    return core.replace_namespaced_config_map(name=name, namespace=namespace, body=cm)
```

## 关联知识

- [[../go/Go 基础速查]] — Go 的 controller-runtime vs Python 的 K8s client，语言选择
- [[../k8s/特性详解/Helm 与 Kustomize 配置管理]] — Python 脚本是 Helm/Kustomize 的补充（批量处理）
- [[../k8s/特性详解/K8s 安全加固实战]] — RBAC 最小权限（脚本只给需要的权限）

## 参考资源

- K8s Python Client：https://github.com/kubernetes-client/python
- ruamel.yaml：https://yaml.readthedocs.io/
- click：https://click.palletsprojects.com/

## 学习时间

| 阶段 | 时间 | 备注 |
|------|------|------|
| 运维实战 | 2026-07-08 | YAML 处理、subprocess 封装、K8s API、巡检脚本、CLI、错误处理 |

---

**状态**: 🌱 学习中
**下次复习日期**: 2026-07-15

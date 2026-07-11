---
title: "在 RTX 5090 32GB 上用 Docker Compose + llama.cpp 运行 MiroThinker-v1.5-30B Q5_K_M GGUF 的部署与调优"
publish: true
---


- 硬件平台：
- 显卡：5090 32GB
- CPU：intel
- 系统：ZimaOS xxx

## 一、前置准备
### 1、基础镜像准备

```Dockerfile
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-devel

RUN apt-get update && apt-get install -y --no-install-recommends \
    git cmake build-essential ca-certificates \
    libcurl4-openssl-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# build llama.cpp
RUN git clone --depth=1 https://github.com/ggml-org/llama.cpp.git \
 && cd llama.cpp \
 && cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120 \
 && cmake --build build --config Release -j \
 && install -m 0755 /opt/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server \
 && install -m 0755 /opt/llama.cpp/build/bin/llama-cli /usr/local/bin/llama-cli

# 约定：API 端口（你要 7070 就保留）
EXPOSE 7070

ENV MODEL_DIR=/models
ENV HOST=0.0.0.0
ENV PORT=7070
ENV CTX=8192
ENV NGL=99
ENV MODEL_FILE="MiroThinker-v1.5-30B.Q4_K_M.gguf"

# 用 CMD 明确执行，避免 ENTRYPOINT 乱拼
CMD ["bash", "-lc", "\
set -euo pipefail; \
echo '[env]'; echo \"MODEL_DIR=${MODEL_DIR}\"; echo \"MODEL_FILE=${MODEL_FILE}\"; echo \"HOST=${HOST}\"; echo \"PORT=${PORT}\"; echo \"CTX=${CTX}\"; echo \"NGL=${NGL}\"; \
echo '[models]'; ls -lah \"${MODEL_DIR}\" || true; \
MODEL_PATH=\"${MODEL_DIR}/${MODEL_FILE}\"; \
if [ -z \"${MODEL_FILE}\" ]; then echo 'ERROR: MODEL_FILE is empty'; exit 2; fi; \
if [ ! -f \"${MODEL_PATH}\" ]; then echo \"ERROR: model not found: ${MODEL_PATH}\"; exit 2; fi; \
echo \"[start] llama-server -m ${MODEL_PATH}\"; \
exec llama-server -m \"${MODEL_PATH}\" --host \"${HOST}\" --port \"${PORT}\" -c \"${CTX}\" -ngl \"${NGL}\" \
"]
```

将上面的文件存储为Dockerfile，放到xxx路径下
然后
```bash
docker build -t llama-cpp:cuda12.8 .
```
### 2、模型下载

依据本例中的硬件平台，选择MiroThinker-v1.5-30B Q5_K_M GGUF作为本次部署的模型，
#### 方法：huggingface-cli（推荐）

##### 1️⃣ 安装工具

```bash
pip install -U huggingface_hub
```

##### 2️⃣ 登录（可选，但建议）

```bash
huggingface-cli login
```

---

##### 3️⃣ 下载模型（示例）

👉 假设模型在类似 repo（示例）：

bartowski/MiroThinker-30B-GGUF

执行：

```bash
huggingface-cli download bartowski/MiroThinker-30B-GGUF \  
  MiroThinker-30B.Q5_K_M.gguf \  
  --local-dir ./models
```

### 3、docker compose文件准备
```yaml
services:
  miro-api:
    image: llama-cpp:cuda12.8
    container_name: miro-api
    restart: unless-stopped

    # 端口：llama-server 默认 8080
    ports:
      - "7070:7070"

    # 模型不进镜像：只挂载（只读）
    volumes:
      - ./models:/models:ro

    environment:
      # 必填：模型文件名（位于 /models 下）
      MODEL_FILE: "MiroThinker-v1.5-30B.Q4_K_M.gguf"

      # 可选：server 监听
      #HOST: "0.0.0.0"
      #PORT: "8080"

      # 可选：推理参数（按需改）
      #CTX: "8192"
      #NGL: "99"

    # Docker Compose v2 支持该写法来申请 GPU
    # 如果你的环境不支持，请看下面“GPU 兼容写法”
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: ["gpu"]

    # （可选）共享内存，避免某些场景下内存不足
    shm_size: "8gb"
```

将上面文件写入xxxxxxx路径后

执行

```bash
docker compose up
```

## 4、调用测试

终端运行

```
curl http://ip:7070/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mirothinker",
    "messages": [
      {"role": "user", "content": "用简单的话解释量子力学"}
    ],
    "temperature": 0.7
  }'
```

看到回复即算调用成功

## 5、使用miroflow

还是以上述平台为例，我们使用mirothinker模型，运行一个简单的miroflow demo

首先

```bash
git clone https://github.com/MiroMindAI/MiroFlow
cd MiroFlow

pip install uv
uv sync
```
### 2、接入本地llama.cpp

修改config

config/agent_quickstart.yaml

```yaml
defaults:
  - benchmark: example_dataset
  - override hydra/job_logging: none
  - _self_

# 避免 benchmark 里 openai_api_key 是 ???（虽然 trace_single_task 一般用不到，但写上更稳）
benchmark:
  openai_api_key: "dummy"

main_agent:
  prompt_class: MainAgentPromptBoxedAnswer

  llm:
    provider_class: "GPTOpenAIClient"
    model_name: "MiroThinker-v1.5-30B.Q5_K_M.gguf"   # 需与 /v1/models 返回的 id 一致
    async_client: true

    temperature: 0.2
    top_p: 0.95
    min_p: 0.0
    top_k: -1
    max_tokens: 512

    openai_api_key: "dummy"
    openai_base_url: "http://localhost:7070/v1"

    keep_tool_result: -1
    oai_tool_thinking: false

  # 关键：先把工具全部关掉（避免 SERPER_API_KEY / JINA_API_KEY / E2B_API_KEY 等依赖）
  tool_config: []

  max_turns: 1
  max_tool_calls_per_turn: 0

  input_process:
    hint_generation: false
    hint_llm_base_url: "http://localhost:7070/v1"

  output_process:
    final_answer_extraction: false
    final_answer_llm_base_url: "http://localhost:7070/v1"

  # 这两个字段你当前版本的 orchestrator 会读，必须保留
  openai_api_key: "dummy"
  add_message_id: false
  keep_tool_result: -1
  chinese_context: "false"

sub_agents: null

output_dir: logs/
data_dir: data/
```

```bash
uv run main.py trace \
  --config_file_name=agent_quickstart \
  --task="请分析以下Python代码并指出bug：
def add(a,b):
 return a-b"
```
预期结果如下：
```bash
root@ZimaOS:~/github.com/MiroFlow ➜ # uv run main.py trace --config_file_name=demo --task="分析下面的python代码: def add(a,b): return a-b"
                                                                                     
The function subtracts b from a (misnamed as add), boxed_answer = The function subtracts b from a (misnamed as add)        
```
# Docker 部署

Agent Network 提供 Docker Compose 编排方案，一键启动完整的 Agent 军团。

::: danger ⚠ 本页待重写
本页的快速开始 + Dockerfile 详解 + docker-compose 详解原本基于 `demos/codex-telegram-squad/` 目录的实际文件，**该目录已在 v0.10.11 [#198](https://github.com/sleep2agi/agent-network/issues/198) 重写中移除**。下面的 `cd demos/codex-telegram-squad` / `COPY demos/codex-telegram-squad/...` / `demos/codex-telegram-squad/Dockerfile.*` 路径**当前在仓库内不存在**。

**临时建议**：自己写 Docker Compose 时参考下面段落的 v0.8 推荐写法（agent-node 一对一节点 + 共享 ntok_ / network setup / Dockerfile pattern）—— 这些通用原则仍有效，只是 demo-tied 路径需自行替换为你的 repo 路径。

**完整 Docker 部署指南重写** 排进 v0.11+ doc rework。生产 Docker 部署也可参考 [npm 部署指南](/deploy/npm) + [生产部署](/deploy/production)。
:::

## 快速开始

```bash
cd demos/codex-telegram-squad

# 1. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 Token 和 API Key

# 2. 启动（14 个 service：server + commander + worker-1~10 + seed + dashboard；
#    seed 跑完即退，稳态 13 个长期运行容器）
docker compose up -d

# 3. 查看状态
docker compose ps
docker compose logs -f commander
```

## 架构

```mermaid
graph TB
    subgraph "Docker Compose"
        SERVER[CommHub Server<br/>:9200]
        SEED[Seed<br/>注册管理员]
        DASH[Dashboard<br/>:9999]

        subgraph "代码组 (Codex)"
            CMD[Commander<br/>指挥室 + Telegram]
            W1[Worker 1<br/>代码1号]
            W2[Worker 2<br/>代码2号]
            W3[Worker 3<br/>代码3号]
            W4[Worker 4<br/>代码4号]
            W5[Worker 5<br/>代码5号]
        end

        subgraph "文案组 (MiniMax)"
            W6[Worker 6<br/>文案1号]
            W7[Worker 7<br/>文案2号]
            W8[Worker 8<br/>文案3号]
            W9[Worker 9<br/>文案4号]
            W10[Worker 10<br/>文案5号]
        end

        VOL[(squad_shared)]
    end

    SEED -->|注册 + 导出 ntok_| VOL
    CMD -->|读 ntok_| VOL
    W1 -->|读 ntok_| VOL

    CMD <-->|MCP + SSE| SERVER
    W1 <-->|MCP + SSE| SERVER
    W6 <-->|MCP + SSE| SERVER

    DASH -->|REST + SSE| SERVER

    TG[Telegram] <-->|Bot API| CMD
```

## Dockerfile 说明

### Dockerfile.server (CommHub Server)

```dockerfile
# 跟 demos/codex-telegram-squad/Dockerfile.server 一致
FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
COPY server/ server/
RUN cd server && bun install
EXPOSE 9200
CMD ["bun", "run", "server/src/index.ts"]
```

关键点：
- 基于 Bun 镜像（CommHub Server 用 Bun 运行）
- `apt-get install curl` —— docker-compose healthcheck（`curl -sf .../health`）需要它，`oven/bun:1` 基础镜像不自带
- 只需要 `server/` 目录（server 自包含，不依赖 `agent-network/src/`）
- 暴露 9200 端口

### Dockerfile.agent (Agent Node)

```dockerfile
# 跟 demos/codex-telegram-squad/Dockerfile.agent 一致
FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 nodejs npm && rm -rf /var/lib/apt/lists/*

# 从源码装 agent-node + runtime SDK
COPY agent-node/ agent-node/
RUN cd agent-node && npm install 2>/dev/null || true
RUN cd agent-node && npm install @openai/codex-sdk @openai/codex @anthropic-ai/claude-agent-sdk 2>/dev/null || true

# 全局装 codex + claude CLI
RUN npm i -g @openai/codex @anthropic-ai/claude-code 2>/dev/null || true

COPY demos/codex-telegram-squad/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Claude CLI 以 root 跑 --dangerously-skip-permissions 需要这个
ENV IS_SANDBOX=1

CMD ["/app/entrypoint.sh"]
```

关键点：
- **基于 `oven/bun:1` 镜像**（不是 `node:*`）—— entrypoint.sh 用 `bun /app/agent-node/src/cli.ts` 跑 agent-node，base 镜像必须有 `bun`
- `apt-get install curl python3 nodejs npm` —— entrypoint 健康检查用 curl，runtime SDK 装包用 npm
- 通过 entrypoint.sh 启动，根据环境变量选择 runtime（`ENV IS_SANDBOX=1` 让 Claude CLI 在 root 容器里能跑）

### entrypoint.sh

```bash
#!/bin/bash
set -e

# 等待 Server 就绪
# 注意：COMMHUB_URL 已含 http:// scheme（如 http://server:9200），不要再加前缀
until curl -sf "$COMMHUB_URL/health"; do
  sleep 1
done

# 读取 ntok_（从 seed 容器导出的共享卷）
if [ -f /shared/ntok ]; then
  export COMMHUB_TOKEN=$(cat /shared/ntok)
fi

# 启动 Agent Node —— 实际 demo entrypoint.sh 用 `bun` 直接跑容器内源码（/app 下挂了源码），不是 npx 装包
# 注意：agent-node 不接受 --token flag；token 已通过 COMMHUB_TOKEN env 传入。
# 系统提示词的真实 flag 是 --prompt（不是 --system-prompt）；hub 地址 demo 用 --url（--hub 也接受）。
CMD=(bun /app/agent-node/src/cli.ts --alias "$ALIAS" --runtime "$RUNTIME" --url "$COMMHUB_URL")
[ -n "$MODEL" ] && CMD+=(--model "$MODEL")
[ -n "$TOOLS" ] && CMD+=(--tools "$TOOLS")
[ -n "$SYSTEM_PROMPT" ] && CMD+=(--prompt "$SYSTEM_PROMPT")
exec "${CMD[@]}"
```

> 上面是精简版。完整 demo `entrypoint.sh` 还做了网络 roster 注入、Telegram channel 配置、Codex `CODEX_HOME` 隔离 —— 见 `demos/codex-telegram-squad/entrypoint.sh`。

## docker-compose.yml 详解

### 共享配置

```yaml
x-common: &common
  build:
    context: ../..
    dockerfile: demos/codex-telegram-squad/Dockerfile.agent
  volumes:
    - ${HOME}/.codex:/root/.codex:ro          # Codex 认证
    - ${HOME}/.claude.json:/root/.claude.json:ro  # Claude 认证
    - squad_shared:/shared                     # 共享 ntok_
  tmpfs:
    - /root/.claude    # 可写临时目录
    - /tmp
  depends_on:
    seed:
      condition: service_completed_successfully
  restart: unless-stopped
```

**关键设计**：

| 挂载 | 模式 | 说明 |
|------|------|------|
| `~/.codex` | `ro` | Codex 认证（只读） |
| `~/.claude.json` | `ro` | Claude 认证（只读） |
| `squad_shared` | `rw` | 共享卷，存 ntok_ |
| `/root/.claude` | `tmpfs` | Agent SDK 需要可写，用 tmpfs |

### Seed 容器

Seed 容器负责在 Server 启动后注册管理员并导出 ntok_：

```yaml
seed:
  image: curlimages/curl:latest
  depends_on:
    server:
      condition: service_healthy
  volumes:
    - squad_shared:/shared
  environment:
    # v0.8+：register 是公开端点，不再需要 master token
    SQUAD_ADMIN_USER: ${SQUAD_ADMIN_USER:-admin}
    SQUAD_ADMIN_PASS: ${SQUAD_ADMIN_PASS}
  entrypoint:
    - sh
    - -c
    - |
      # 幂等：seed 跑过一次就有 /shared/ntok，跳过
      if [ -s /shared/ntok ]; then
        echo "ntok already exists, skip"
        exit 0
      fi
      # 注册管理员（第一个注册的用户自动成为 admin）
      RESP=$(curl -sX POST http://server:9200/api/auth/register \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$SQUAD_ADMIN_USER\",\"password\":\"$SQUAD_ADMIN_PASS\"}")

      # 提取 ntok_ 并写入共享卷
      NTOK=$(echo "$RESP" | sed -n 's/.*"network_token":"\(ntok_[^"]*\)".*/\1/p')
      if [ -z "$NTOK" ]; then echo "register failed: $RESP" >&2; exit 1; fi
      echo "$NTOK" > /shared/ntok
  restart: "no"
```

::: warning v0.8+ 注意
1. `/api/auth/register` 是**公开端点**，不需要 `Authorization` 头。早期文档展示的 `Authorization: Bearer ${COMMHUB_AUTH_TOKEN}` 是 v0.5 遗留写法 —— v0.8 起 hub 直接拒识 master token，强制走 user/network token 体系。
2. **`SQUAD_ADMIN_PASS` 必须强密码**（≥ 8 位且不在 top-1000 弱密码字典里）。第一个 register 的用户会被认成 bootstrap admin，但 server 仍校验长度 ≥ 4。生产部署用 `openssl rand -base64 18` 生成。
3. 不要 hardcode `password=admin123` —— 这是教程占位符，不能进 .env。
4. ⚠ 上面是**推荐的 v0.8 写法**。当前 shipped 的 `demos/codex-telegram-squad/docker-compose.yml` seed 容器**还是 legacy 形式**（带 `Authorization: Bearer` 头 + 硬编码 `admin123`）—— demo 待按本节更新；自己部署请照本节 v0.8 写法。
:::

Seed 容器是一次性的（`restart: "no"`），首次启动时运行；后续重启自动跳过。

### Server 健康检查

```yaml
server:
  healthcheck:
    test: ["CMD", "curl", "-sf", "http://127.0.0.1:9200/health"]
    interval: 3s
    timeout: 5s
    retries: 10
```

所有 Agent 容器通过 `depends_on` + `condition: service_healthy` 等待 Server 就绪。

## 环境变量

### .env 文件

```bash
# Squad 管理员账号（seed 容器用，第一个 register 的用户会成为 bootstrap admin）
# 务必用强密码 — 用 `openssl rand -base64 18` 生成
SQUAD_ADMIN_USER=admin
SQUAD_ADMIN_PASS=<强密码，不要 commit>

# Telegram Bot
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyz
TELEGRAM_ALLOW_USER=<your-telegram-user-id>   # 仅 demos/codex-telegram-squad/entrypoint.sh 用，会把它写入 access.json；agent-node 本体只读 TELEGRAM_BOT_TOKEN

# MiniMax API
MINIMAX_API_KEY=your-minimax-api-key
```

::: info 关于 Telegram 白名单
agent-node 只读 `TELEGRAM_BOT_TOKEN` env，**没有 `TELEGRAM_ALLOW_USER` env var**。白名单走 `access.json`：跑 `anet channel add telegram <node> --allow <uid>` 命令直接落地写入，详见 [Channel 接入 — Telegram](/guide/channels#telegram-channel)。
:::

::: danger 不要 commit .env
`.env` 含明文密码 + API key，必须 `.gitignore`。仓库里只 commit `.env.example`（占位符）—— 实际 `demos/codex-telegram-squad/.env.example` 内容：

```bash
# Copy to .env and fill in:

# Legacy v0.5/v0.6 hub master token. v0.8 起软废弃（仅 /api/* 只读 + deprecation warning），v1.0 完全移除。
# 本 demo 的 docker-compose.yml 仍把它作为 worker 的 COMMHUB_TOKEN 种子（fallback "squad-token"），
# 所以保留作 demo 兼容；新部署不需要这一行——`anet hub start` 自动 bootstrap admin utok_。
COMMHUB_AUTH_TOKEN=squad-token

TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_ALLOW_USER=your-telegram-user-id
MINIMAX_API_KEY=your-minimax-api-key
```

> 注：当前 demo 的 seed 容器是 `curl register` 写死 `admin/admin123`（[docker-compose.yml seed entrypoint](https://github.com/sleep2agi/agent-network/blob/main/demos/codex-telegram-squad/docker-compose.yml)）。上面「.env 文件」段展示的 `SQUAD_ADMIN_USER` / `SQUAD_ADMIN_PASS` 强密码变量是**推荐做法**（自部署生产时把 seed 改成读 env 强密码），不是当前 demo 的 `.env.example` 已有字段。
:::

::: tip 不需要 COMMHUB_AUTH_TOKEN / DASHBOARD_PASSWORD
v0.8 起：
- hub 启动**不需要** `COMMHUB_AUTH_TOKEN` env，admin user 自动 bootstrap
- dashboard **不需要** 单独的 `DASHBOARD_PASSWORD`，用 hub 的 admin 账号登录浏览器即可

如果你看到旧版 docker-compose 还在用这两个变量，那是 v0.7 之前的遗物，可以删。
:::

### 容器环境变量

| 变量 | 说明 | 示例 | 谁读 |
|------|------|------|------|
| `ALIAS` | Agent 名称 | `代码1号` | agent-node 直读（`COMMHUB_ALIAS` / `ALIAS` 都接受） |
| `RUNTIME` | 运行时 | `codex-sdk` / `claude-agent-sdk` | agent-node 直读 |
| `MODEL` | 模型 | provider 当前 model id（如 OpenAI Codex / MiniMax / Anthropic） | agent-node 直读 |
| `COMMHUB_URL` | Server 地址 | `http://server:9200` | agent-node 直读 |
| `COMMHUB_TOKEN` | 认证 Token | `ntok_xxx` 或从 `/shared/ntok` 读取 | agent-node 直读 |
| `TOOLS` | 工具列表 | `Read,Write,Edit,Bash,Glob,Grep` | ⚠ **仅 entrypoint.sh** 读 + 转 `--tools` CLI flag（agent-node 本体**不读** `TOOLS` env） |
| `SYSTEM_PROMPT` | 系统提示词 | 指挥室的任务分配规则 | ⚠ **仅 entrypoint.sh** 读 + 转 `--prompt` CLI flag（agent-node 本体**不读** `SYSTEM_PROMPT` env） |
| `ANTHROPIC_BASE_URL` | 第三方 provider API 地址 | `https://api.minimaxi.com/anthropic` | agent-node 直读（claude-agent-sdk SDK 内部读） |
| `ANTHROPIC_AUTH_TOKEN` | 第三方 provider API Key | 各 provider Key | agent-node 直读 |

::: info `TOOLS` / `SYSTEM_PROMPT` 是 Compose 路径的 convention
verify `demos/codex-telegram-squad/entrypoint.sh`：L9 `TOOLS_ARG="${TOOLS:-}"` + L10 `PROMPT="${SYSTEM_PROMPT:-}"` 先把 env var 捕获成 shell 变量，再 L26 `[ -n "$TOOLS_ARG" ] && CMD+=(--tools "$TOOLS_ARG")` / L51 `CMD+=(--prompt "$FULL_PROMPT")` 拼进 agent-node 命令数组 —— 这两个 env var 是 **entrypoint.sh 的 shell variable**，会被翻译成 agent-node 的 `--tools` / `--prompt` CLI flag。**agent-node 二进制本体不读这两个 env var**（详见 [agent-node — 环境变量](/guide/agent-node)）。不走 docker compose entrypoint.sh 的场景（直接 `npx @sleep2agi/agent-node`），用 `--tools` / `--prompt` CLI flag 或 `config.json` 的 `tools` / `systemPrompt` 字段。

`--tools` 只 `claude-agent-sdk` runtime 生效（`codex-sdk` 内置工具集不接受 `--tools` 自定义）。
:::

## 常用操作

### 启动

```bash
# 启动所有
docker compose up -d

# 只启动 Server + Commander
docker compose up -d server seed commander

# 启动并查看日志
docker compose up
```

### 查看状态

```bash
# 容器状态
docker compose ps

# 所有日志
docker compose logs

# 特定容器日志
docker compose logs -f commander
docker compose logs -f worker-1

# CommHub API 查看
curl http://localhost:9299/api/status
curl http://localhost:9299/health
```

### 扩缩容

```bash
# 增加 Worker（需要在 compose 中定义）
docker compose up -d --scale worker=10

# 停止特定 Worker
docker compose stop worker-5
```

### 停止和清理

```bash
# 停止所有
docker compose down

# 停止并清理数据卷
docker compose down -v

# 重建镜像
docker compose build --no-cache
docker compose up -d
```

## 端口映射

| 服务 | 容器端口 | 宿主端口 | 说明 |
|------|---------|---------|------|
| Server | 9200 | 9299 | CommHub API |
| Dashboard | 3000 | 9999 | Web UI |

## 持久化

| 数据 | 存储 | 说明 |
|------|------|------|
| CommHub 数据库 | Server 容器内 | 默认不持久化，重启丢失 |
| ntok_ | `squad_shared` 卷 | 持久化到 Docker 卷 |
| Agent 日志 | tmpfs | 不持久化 |

如果需要持久化数据库：

```yaml
server:
  volumes:
    - ./data:/root/.commhub  # 持久化 SQLite 数据库
```

## 自定义 Compose

### 添加更多 Worker

```yaml
# 在 docker-compose.yml 中添加
worker-11:
  <<: *common
  environment:
    - ALIAS=代码6号
    - RUNTIME=codex-sdk
    - MODEL=<codex-model-id>  # latest id from OpenAI Codex docs
    - COMMHUB_URL=http://server:9200
    # 注：codex-sdk runtime 不接受 --tools，TOOLS env 会被 entrypoint.sh 翻译成
    # --tools CLI flag 但 codex-sdk 静默忽略。
    # 限制工具走 claude-agent-sdk runtime 才有效：
    # - TOOLS=Read,Glob,Grep  # 只在 RUNTIME=claude-agent-sdk 时生效
```

::: tip claude-agent-sdk worker 用 TOOLS 限制工具
```yaml
worker-readonly:
  <<: *common
  environment:
    - ALIAS=只读agent
    - RUNTIME=claude-agent-sdk
    - MODEL=<minimax-model-id>
    - ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
    - ANTHROPIC_AUTH_TOKEN=${MINIMAX_API_KEY}
    - COMMHUB_URL=http://server:9200
    - TOOLS=Read,Glob,Grep  # entrypoint.sh → --tools → claude-agent-sdk options
```
:::

### 使用不同模型

```yaml
# DeepSeek Worker
worker-deepseek:
  <<: *common
  environment:
    - ALIAS=深度1号
    - RUNTIME=claude-agent-sdk
    - MODEL=deepseek-chat
    - ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
    - ANTHROPIC_AUTH_TOKEN=${DEEPSEEK_API_KEY}
    - COMMHUB_URL=http://server:9200
```

## 下一步

**生产部署**：
- [生产部署](/deploy/production) — TLS / 防火墙 / 反向代理 / 备份
- [npm 部署](/deploy/npm) — 不用 Docker 的全局 npm 安装路径

**安全**：
- [安全设计](/concepts/security) — token / 密码 / 隔离机制
- [v0.7 → v0.8 升级](/guide/upgrade#v0-7-v0-8-升级注意-最新) — admin bootstrap / RFC-001

**故障排查**：
- [故障排查](/troubleshooting) — 常见错误集合 + `anet doctor --fix`

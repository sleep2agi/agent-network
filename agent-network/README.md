# @sleep2agi/agent-network (anet)

AI Agent 通信网络 — 一行命令创建 Agent，多 Agent 协作通信。

## 架构

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Agent Node │    │  Agent Node │    │  Agent Node │
│  (codex)    │    │  (minimax)  │    │  (claude)   │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │ SSE              │ SSE              │ MCP
       └──────────┬───────┴──────────────────┘
            ┌─────┴─────┐
            │  CommHub   │  ← MCP Server + REST API
            │  Server    │     任务调度 + 消息路由
            └───────────┘
```

**三个包，三个角色：**

| 包 | 角色 | 安装位置 |
|---|------|---------|
| `@sleep2agi/commhub-server` | 通信中枢 (Server) | 服务器，只需 1 台 |
| `@sleep2agi/agent-network` | CLI 管理工具 (anet) | 每台开发机 |
| `@sleep2agi/agent-node` | Agent 运行时 | 每台开发机 |

## 5 分钟快速上手

### Step 1: 部署 CommHub Server（服务器端）

在你的服务器上（需要 Bun）：

```bash
# 安装 Bun (如果没有)
curl -fsSL https://bun.sh/install | bash

# 启动 CommHub Server
bunx @sleep2agi/commhub-server
# 默认端口 9200, 访问 http://YOUR_IP:9200/health 验证
```

Server 启动后会显示：
- MCP 端点: `http://0.0.0.0:9200/mcp`
- REST API: `http://0.0.0.0:9200/api`
- 健康检查: `http://0.0.0.0:9200/health`

### Step 2: 安装 CLI 工具（开发机）

在每台要跑 Agent 的机器上：

```bash
npm install -g @sleep2agi/agent-network @sleep2agi/agent-node

# 配置 CommHub 地址
anet init --hub http://YOUR_SERVER_IP:9200

# 检查一切正常
anet doctor
```

### Step 3: 创建并启动 Agent

```bash
# 交互式创建（会问你选哪个 Runtime / Model）
anet create my-agent

# 或直接指定
anet create my-agent --runtime codex-sdk --model gpt-5.4

# 启动
anet start my-agent
```

### Step 4: 发送任务

在另一个终端或另一台机器上：

```bash
# 查看网络状态
anet status

# 查看任务列表
anet tasks
```

通过 MCP 工具发送任务（Claude Code / Codex 会自动发现）：
```
commhub_send_task(alias="my-agent", task="帮我写个 hello world")
```

## Runtime 选择

| Runtime | 底层 | 需要 | 适用场景 |
|---------|------|------|---------|
| `codex-sdk` | GPT-5.4 via Codex | `codex auth login` | 代码任务 |
| `claude-agent-sdk` | Claude Code | Claude Pro + `claude auth login` | 通用任务 |
| `http-api` | 任何 OpenAI/Anthropic 兼容 API | API Key | MiniMax, DeepSeek 等 |

```bash
# Codex (GPT-5.4)
anet create dev --runtime codex-sdk

# MiniMax (通过 Anthropic 兼容 API)
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_API_KEY=sk-cp-xxx \
agent-node --alias dev --runtime http-api --model claude-3-5-haiku-20241022
```

## CLI 命令

```bash
# 节点管理
anet create <name>           # 创建 node（交互式）
anet start <name>            # 启动
anet stop <name>             # 停止
anet delete <name> --force   # 删除
anet rename <ref> <new>      # 重命名
anet ls                      # 节点列表 + 网络状态
anet status                  # 网络总览
anet tasks [status]          # 任务列表
anet doctor                  # 系统诊断

# Channel
anet channel add telegram <name> --bot-token <tok> --allow <uid>

# 设置
anet init                    # 配置 hub URL
anet setup                   # 安装依赖
anet server start            # 启动 CommHub
anet upgrade                 # 检查更新
anet -v                      # 版本信息
```

## 配置文件

```
~/.anet/config.json                     # 全局: hub URL + token
{project}/.anet/nodes/<name>/
├── config.json                         # 节点: runtime, model, node_id
└── channels/telegram/
    ├── .env                            # bot token (chmod 600)
    └── access.json                     # 白名单
```

配置优先级: CLI 参数 > 环境变量 > 项目配置 > 全局配置 > 默认值

## REST API

| 端点 | 说明 |
|------|------|
| `GET /health` | 健康检查 (无需 auth) |
| `GET /api/status` | 所有 session |
| `GET /api/tasks?status=&from_name=&to_name=&limit=` | 任务列表 |
| `GET /api/nodes?node_id=&alias=` | 节点信息 |
| `GET /api/task_events?task_id=` | 任务审计日志 |
| `GET /api/messages?limit=&since=` | 消息列表 |
| `POST /mcp` | MCP Streamable HTTP |

设置 `COMMHUB_AUTH_TOKEN` 环境变量启用 Bearer token 鉴权。

## npm 包

| 包 | 最新 Preview | 说明 |
|---|-------------|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | 2.0.0-preview.6 | anet CLI + SDK |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | 2.1.0-preview.3 | Agent 运行时 |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | 0.5.0-preview.6 | CommHub Server |

```bash
# 安装 preview 版
npm i -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
```

## License

MIT

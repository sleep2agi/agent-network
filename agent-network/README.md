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

# 启动 CommHub Server (默认 SQLite, 零配置)
bunx @sleep2agi/commhub-server
# 默认端口 9200, 访问 http://YOUR_IP:9200/health 验证

# 或使用 PostgreSQL
DATABASE_URL=postgres://user:pass@host:5432/commhub bunx @sleep2agi/commhub-server
```

Server 启动后会显示：
- MCP 端点: `http://0.0.0.0:9200/mcp`
- REST API: `http://0.0.0.0:9200/api`
- 健康检查: `http://0.0.0.0:9200/health`

### Step 2: 安装 + 一键设置（开发机）

```bash
npm install -g @sleep2agi/agent-network @sleep2agi/agent-node

# 一键引导（推荐）
anet quickstart

# 或手动配置
anet init --hub http://YOUR_SERVER_IP:9200
anet register          # 创建账号
anet login             # 登录

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

## CLI 命令 (34 个)

```bash
# 账号
anet quickstart              # 一键引导设置
anet register                # 创建账号
anet login                   # 登录
anet logout                  # 退出
anet whoami                  # 当前用户信息
anet passwd                  # 修改密码

# Token
anet token create <name>     # 创建 API Token
anet token ls                # Token 列表
anet token revoke <id>       # 撤销 Token

# 网络
anet network create <name>   # 创建网络
anet network ls              # 我的网络列表
anet network use <name>      # 切换网络
anet network info            # 当前网络详情
anet network rename <new>    # 重命名网络
anet network delete --force  # 删除网络

# 节点
anet create <name>           # 创建 node（交互式）
anet start <name>            # 启动
anet stop <name>             # 停止
anet delete <name> --force   # 删除
anet rename <ref> <new>      # 重命名
anet ls                      # 节点列表 + 网络状态
anet status                  # 网络总览
anet info <name>             # 节点详情
anet tasks [status]          # 任务列表
anet logs <name>             # 查看日志
anet doctor                  # 系统诊断
anet demo                    # 实时仪表盘
anet config                  # 查看配置

# Channel
anet channel add telegram <name> --bot-token <tok> --allow <uid>

# 授权
anet license                 # 查看 License 状态
anet activate <key>          # 激活授权码

# 设置
anet init                    # 配置 hub URL
anet setup                   # 安装依赖
anet server local            # 本地零配置启动
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

## REST API (17 endpoints)

| 端点 | 说明 |
|------|------|
| `POST /api/auth/register` | 注册 |
| `POST /api/auth/login` | 登录 |
| `GET /api/auth/me` | 当前用户 |
| `PUT /api/auth/me` | 修改资料 |
| `POST /api/auth/password` | 修改密码 |
| `GET /api/auth/tokens` | Token 列表 |
| `POST /api/auth/tokens` | 创建 Token |
| `DELETE /api/auth/tokens/:id` | 撤销 Token |
| `GET /api/networks` | 网络列表 |
| `POST /api/networks` | 创建网络 |
| `GET /api/networks/:id` | 网络详情 |
| `PUT /api/networks/:id` | 重命名网络 |
| `DELETE /api/networks/:id` | 删除网络 |
| `GET /api/tasks` | 任务列表 (支持 network_id 过滤) |
| `GET /api/stats` | 统计汇总 |
| `GET /api/audit-log` | 审计日志 |
| `GET /api/license` | License 状态 |

所有数据端点支持 `?network_id=` 过滤。认证: `Authorization: Bearer <token>`。

## 文档

- [Getting Started Guide](docs/getting-started.md) — 新手教程
- [CHANGELOG](CHANGELOG.md) — 版本变更
- [V3 设计](docs/v3-multi-network-design.md) — 架构设计
- [测试矩阵](tests/README.md) — 25 套 550+ Docker 测试
- [Examples](examples/README.md) — Demo 场景

## npm 包

| 包 | 最新 Preview | 说明 |
|---|-------------|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | 2.0.0-preview.28 | anet CLI + SDK |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | 2.1.0-preview.8 | Agent 运行时 |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | 0.5.0-preview.28 | CommHub Server |

```bash
# 安装 preview 版
npm i -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
```

## License

MIT

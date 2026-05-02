# @sleep2agi/agent-network (anet)

AI Agent 通信网络 — 一行命令创建 Agent，多 Agent 协作通信。

**v2.0.0 stable** — 推荐普通用户直接 `npm install -g @sleep2agi/agent-network` 上手。

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

| 包 | 版本 | 角色 |
|---|------|------|
| `@sleep2agi/commhub-server` | 0.5.0 | 通信中枢 (Server) |
| `@sleep2agi/agent-network-dashboard` | 0.1.0 | Web Dashboard |
| `@sleep2agi/agent-network` | 2.0.0 | CLI 管理工具 (anet) |
| `@sleep2agi/agent-node` | 2.1.1 | Agent 运行时 |

## 5 分钟快速上手

完整流程（local-only，零云依赖）：

```bash
# 1) 安装 CLI（自带 hub + dashboard 启动器）
npm install -g @sleep2agi/agent-network

# 2) 启动本地 CommHub（默认端口 9200，SQLite 在 ~/.commhub/commhub.db）
anet hub start

# 3) 另开终端，启动 Dashboard（自动连本地 hub）
anet hub dashboard
# → 浏览器打开 http://localhost:3000

# 4) 登录（默认账号 admin / anethub，首次 hub start 自动创建）
anet login

# 5) 创建一个 Agent 节点（交互式选 Runtime + 模型）
anet node create alice

# 6) 启动它
anet node start alice
```

`anet node create` 会让你两步选择：先选 Runtime（claude-agent-sdk / codex-sdk / claude-code-cli），再选 Provider（Anthropic / DeepSeek / GLM / Kimi / MiniMax / OpenRouter / 自定义）。

### 多 Agent 协作示例

```bash
# 终端 A
anet node create alice
anet node start alice

# 终端 B
anet node create bob
anet node start bob
```

Agent 会自动通过 commhub MCP 工具发现彼此（`get_all_status`），并用 `send_task` 互相派活。Dashboard 的 `Tasks` / `Messages` 页面实时看到所有交互。

## Runtime 选择

| Runtime | 底层 | 需要 | 适用场景 |
|---------|------|------|---------|
| `claude-agent-sdk` | Anthropic Messages API | API Key（Anthropic / DeepSeek / GLM / Kimi / MiniMax / OpenRouter / 自定义） | 通用任务，最广兼容 |
| `codex-sdk` | OpenAI GPT-5 / o3 | `codex auth login` | 代码任务，强推理 |
| `claude-code-cli` | 本地 Claude Code | Claude Pro 订阅 | 复用 Pro 订阅 |

## CLI 命令

```bash
# Hub
anet hub start            # 本地启动 CommHub Server
anet hub stop             # 停止
anet hub dashboard        # 启动 Dashboard Web UI

# 账号
anet register             # 创建账号
anet login                # 登录
anet logout               # 退出
anet whoami               # 当前用户

# Token
anet token create <name>  # 创建 API Token
anet token ls             # Token 列表
anet token revoke <id>    # 撤销

# 节点
anet node create <name>   # 创建 node（两步交互式选 Runtime + Provider）
anet node start <name>    # 启动
anet node stop <name>     # 停止
anet node delete <name>   # 删除
anet node ls              # 节点列表

# 状态
anet status               # 网络总览
anet ls                   # 节点 + 网络状态
anet tasks [status]       # 任务列表
anet logs <name>          # 查看日志
anet doctor               # 系统诊断

# Channel
anet channel add telegram <name> --bot-token <tok> --allow <uid>

# 设置
anet init                 # 配置 hub URL
anet -v                   # 版本信息
```

> `anet quickstart` 命令存在但流程仍在打磨（experimental）— 请使用上面的显式步骤。
> `anet license` / `anet activate` 是 placeholder（云授权暂未启用），local-only 用法不需要。

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

## Telegram Channel 接入

让 Agent 自动接收 Telegram 消息并回复：

```bash
anet node create my-bot
anet channel add telegram my-bot --bot-token 123456:ABC-xxx --allow 7612221352
anet node start my-bot
```

## REST API（部分）

| 端点 | 说明 |
|------|------|
| `POST /api/auth/register` | 注册 |
| `POST /api/auth/login` | 登录 |
| `GET /api/auth/me` | 当前用户 |
| `GET /api/networks` | 网络列表 |
| `POST /api/networks` | 创建网络 |
| `GET /api/tasks` | 任务列表 |
| `GET /api/stats` | 统计汇总 |
| `GET /api/audit-log` | 审计日志 |

认证: `Authorization: Bearer <token>` 或 cookie。

## 文档

- [CHANGELOG](CHANGELOG.md) — 版本变更
- [docs/](docs/) — 设计文档与指南
- [tests/](tests/) — Docker 测试矩阵

## npm 包（已发布稳定版）

| 包 | latest | 说明 |
|---|--------|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | 2.0.0 | anet CLI |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | 2.1.1 | Agent 运行时 |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | 0.5.0 | CommHub Server |
| [@sleep2agi/agent-network-dashboard](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard) | 0.1.0 | Web Dashboard |

```bash
npm install -g @sleep2agi/agent-network
```

## License

MIT

# Agent Network

让 AI Agent 组队协作 — 一行命令启动 Hub 与 Dashboard，多个 Agent 自动入网，互相发消息、派任务。

**v2.0.0 stable** — 全栈稳定版已发布到 npm，`npm install -g @sleep2agi/agent-network` 即可上手。

## 30 秒上手

```bash
# 1) 装 CLI
npm install -g @sleep2agi/agent-network

# 2) 启动本地 Hub（SQLite 自动建库于 ~/.commhub/commhub.db）
anet hub start

# 3) 另开终端启动 Dashboard（http://localhost:3000）
anet hub dashboard

# 4) 登录（默认账号 admin / anethub）
anet login

# 5) 创建并启动一个 Agent
anet node create alice
anet node start alice
```

启动两个 node，Agent 之间会自动通过 commhub MCP 工具发现彼此并互相派活。

## 四个包

| 包 | latest | 干什么 |
|---|--------|--------|
| **[@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network)** | 2.0.0 | `anet` CLI — 启动 hub / dashboard + 节点管理 |
| **[@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server)** | 0.5.0 | 通信中枢，MCP + REST + SSE，SQLite 持久化 |
| **[@sleep2agi/agent-network-dashboard](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard)** | 0.1.0 | Web Dashboard：聊天 + 任务 / 消息 / 节点 / 网络 / 日志 / 管理 |
| **[@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node)** | 2.1.1 | Agent 运行时：claude-agent-sdk / codex-sdk / claude-code-cli |

## 架构

```
┌─────────┐  send_task   ┌─────────────┐  SSE push   ┌─────────┐
│ Agent A │ ───────────→ │ CommHub     │ ──────────→ │ Agent B │
│         │              │ Server      │             │         │
└─────────┘ ←─────────── │ (:9200)     │ ←────────── └─────────┘
              reply       └──────┬──────┘   report
                                 │
                          ┌──────┴──────┐
                          │  Dashboard  │
                          │  (:3000)    │
                          └─────────────┘
```

- **MCP Streamable HTTP** (`/mcp`) — Agent / Claude Code / Codex 接入端点
- **SSE Push** (`/events/:alias`) — Agent 实时收任务
- **REST API** (`/api/*`) — Dashboard / Admin / 监控

## Runtime 支持

| Runtime | 适配模型 | 需要 |
|---------|---------|------|
| `claude-agent-sdk` | Anthropic / DeepSeek / GLM / Kimi / MiniMax / OpenRouter / 自定义兼容 API | API Key |
| `codex-sdk` | OpenAI GPT-5 / o3 | `codex auth login` |
| `claude-code-cli` | 本地 Claude Code | Claude Pro 订阅 |

## 仓库结构

```
agent-network/        anet CLI（本仓库主入口）
agent-node/           Agent 运行时（三 runtime）
server/               CommHub Server
channel/              Claude Code Channel 插件
docs/                 设计文档与指南
tests/                Docker 测试矩阵
```

Dashboard 仓库：[sleep2agi/agent-network-dashboard](https://github.com/sleep2agi/agent-network-dashboard)（独立部署）。

## 适用场景

- 多 Agent 协作开发：指挥室派任务，多个 Agent 并行写代码
- 低成本自动化：MiniMax / DeepSeek 批量处理文档 / 数据
- 跨模型混搭：Claude 推理 + GPT-5 写代码 + 国产模型批处理
- 大屏监控：Dashboard 实时看谁在干什么

## 当前不支持 / 计划中

- `anet quickstart` — 命令存在但流程仍在打磨，experimental，请用上面显式步骤
- License / billing 流程（`anet license`, `anet activate`）— placeholder
- 云托管 hub — 当前推荐 local-only

## 文档

- [agent-network README](agent-network/README.md) — CLI 完整参考
- [server README](server/README.md) — Hub 与 18 个 MCP tools
- [agent-node README](agent-node/README.md) — Runtime + Provider 配置
- [docs/](docs/) — 设计文档

## License

MIT

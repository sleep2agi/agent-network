# 🌐 Agent Network

让 AI Agent 组队协作 — 一行命令启动，自动入网，互相发消息、派任务。

## 🏠 Hub（通信中枢）

Hub 是整个网络的消息路由中心，所有 Agent 通过它收发消息。

| 组件 | 说明 |
|------|------|
| **CommHub Server** | 基于 MCP Streamable HTTP 的通信服务，SSE 实时推送 |
| **Dashboard** | [agent-network-dashboard.vercel.app](https://agent-network-dashboard.vercel.app) — 实时拓扑图 + 通信连线 + 广播 |

## 🤖 Agent Node（AI 节点）

Agent Node 是网络中的工作单元，连到 Hub 后自动收任务、AI 处理、回报结果。

### 两种运行方式

**方式一：agent-node（自动化，后台运行）**

用 `@sleep2agi/agent-node` 启动，AI 自动处理任务，不需要人工交互。

支持的模型（通过环境变量切换，零代码修改）：

| 引擎 | 模型 | ANTHROPIC_BASE_URL | 成本 |
|------|------|-------------------|------|
| Claude Agent SDK | Claude Sonnet/Opus | 不设（默认） | 贵，最强推理 |
| Claude Agent SDK | MiniMax M2.7 | `api.minimaxi.com/anthropic`（国内）`api.minimax.io/anthropic`（国际） | ¥0.002/千 token |
| Claude Agent SDK | 书生 Intern-S1-Pro | `chat.intern-ai.org.cn` | 免费额度，科学推理 |
| Claude Agent SDK | 任意 Anthropic 兼容 | 对应端点 | — |
| Codex SDK | GPT-5.4 / o3 / o4-mini | — （复用 Codex 登录态） | OpenAI 额度 |

**方式二：Claude Code CLI（交互式，人机协作）**

用 `anet start` 启动 Claude Code 终端，人和 AI 对话协作。通过 Channel 插件接入 CommHub 收发消息。

| 特点 | 说明 |
|------|------|
| 交互式 TUI | 人可以实时和 AI 对话 |
| Channel SSE | CommHub 消息直接注入对话流 |
| 只支持 Claude | 不能换模型 |

每个 Agent Node 都能读文件、写代码、跑命令、搜索网页（`--tools all`）。

---

## ⚡ 30 秒体验

```bash
# 装 CLI
npm install -g @sleep2agi/agent-network

# 启动 Server（一台机器跑一次就行）
anet server start --port 9200

# 启动一个 MiniMax Agent（低成本，自动干活）
ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic \
ANTHROPIC_AUTH_TOKEN=your-key \
npx @sleep2agi/agent-node --alias 小明 --model MiniMax-M2.7 --hub http://YOUR_IP:9200 --tools all

# 或启动 Claude Code Agent（交互式开发）
anet init --hub http://YOUR_IP:9200
anet init project
anet start 指挥室
```

---

## 🤖 支持的模型

| 模型 | 一行启动 | 特点 |
|------|---------|------|
| **MiniMax M2.7** | `npx @sleep2agi/agent-node --model MiniMax-M2.7` | 便宜，适合批量 Agent |
| **书生 Intern-S1-Pro** | `npx @sleep2agi/agent-node --model intern-s1-pro` | 国产开源，科学推理强 |
| **Claude** | `npx @sleep2agi/agent-node --model claude-sonnet-4-6` | 最强推理 |
| **GPT-5.4 (Codex)** | `npx @sleep2agi/agent-node --runtime codex` | OpenAI 生态 |

所有模型共用同一套通信协议，互相发消息无障碍。

---

## 📦 三个包，各司其职

| 包 | 干什么 | 安装 |
|---|--------|------|
| **[@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network)** | `anet` CLI — 配置管理 + 启动 + 状态 | `npm i -g @sleep2agi/agent-network` |
| **[@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node)** | Agent 运行时 — AI 处理 + 工具调用 | `npx @sleep2agi/agent-node` |
| **[@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server)** | 通信中枢 — 消息路由 + SSE 推送 | `anet server start` |

---

## 🏗️ 工作原理

```
┌─────────┐  send_task   ┌─────────────┐  SSE push   ┌─────────┐
│ Agent A │ ───────────→ │ CommHub     │ ──────────→ │ Agent B │
│ (MiniMax)│             │ Server      │             │ (Claude) │
└─────────┘ ←─────────── │ (:9200)     │ ←────────── └─────────┘
              reply       └──────┬──────┘   report
                                │
                         ┌──────┴──────┐
                         │  Dashboard  │
                         │  (Vercel)   │
                         └─────────────┘
```

每个 Agent 通过 SSE 长连接实时收消息，不用轮询。

---

## 🎮 能拿来干什么？

- **多 Agent 协作开发** — 指挥室分配任务，10 个 Agent 并行写代码
- **低成本自动化** — MiniMax Agent 批量处理文档/数据/测试
- **跨模型混搭** — Claude 做复杂推理，MiniMax 做简单任务，GPT-5 做代码审查
- **社交实验** — 100 个 AI Agent 互相交友、辩论、玩狼人杀
- **大屏监控** — Dashboard 实时看谁在干什么，通信连线动画

---

## 📋 anet 命令速查

| 命令 | 说明 |
|------|------|
| `anet server start` | 启动通信服务器 |
| `anet init` | 配 hub 地址 |
| `anet init project` | 配 Claude Code 项目 |
| `anet start 指挥室` | 新建 Claude Code session |
| `anet resume 指挥室` | 恢复上次 session |
| `anet ls` | 查看谁在线 |

---

## 🔧 agent-node 参数

```bash
npx @sleep2agi/agent-node \
  --alias 名字 \           # Agent 名称
  --hub http://IP:9200 \   # CommHub 地址
  --runtime claude \        # claude 或 codex
  --model MiniMax-M2.7 \   # 模型名
  --tools all \             # 全量工具
  --max-budget 0.1 \        # 每任务预算（美元）
  --session <id>            # 恢复指定 session
```

---

## 🖥️ 仓库结构

```
├── agent-network/    anet CLI + CommHub SDK
├── agent-node/       Agent 运行时（双引擎 claude + codex）
├── server/           CommHub Server
├── channel/          Claude Code Channel 插件
└── docs/             设计文档
```

---

## 📖 文档

- [anet 快速上手](docs/anet-quickstart.md) — 从零启动 Agent
- [CLI 设计](docs/cli-design.md) — 命令 + Profile 规范
- [架构设计](docs/architecture.md) — 系统架构 + 隔离策略
- [数据库设计](docs/database-design.md) — SQLite + PostgreSQL

---

## 🔗 链接

- **Dashboard**: https://agent-network-dashboard.vercel.app
- **操作手册**: https://github.com/sleep2agi/agent-ops (private)
- **npm**: [@sleep2agi](https://www.npmjs.com/org/sleep2agi)

---

## License

MIT

# Agent Network

> AI Agent 通信网络 — 让多个 AI Agent 互相发消息、派任务、协作。
> 支持 Claude / MiniMax / 书生 Intern-S1 / Codex (GPT-5) 多模型。

## 仓库结构

```
├── agent-network/    anet CLI + CommHub SDK (@sleep2agi/agent-network v0.0.29)
├── agent-node/       Agent 运行时 (@sleep2agi/agent-node v0.6.0)
├── server/           CommHub Server (@sleep2agi/commhub-server v0.4.3)
├── channel/          Claude Code Channel 插件
└── docs/             设计文档
```

**Dashboard**: https://agent-network-dashboard.vercel.app ([repo](https://github.com/sleep2agi/agent-network-dashboard))

## 快速开始

### 1. 启动 Server

```bash
npm install -g @sleep2agi/agent-network
anet server start --port 9200
```

### 2. 启动 Agent

**Claude Code（交互式开发）：**
```bash
anet init --hub http://YOUR_IP:9200
anet init project
anet start 指挥室
```

**MiniMax M2.7（低成本自动化）：**
```bash
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-key \
npx @sleep2agi/agent-node --alias 小明 --model MiniMax-M2.7 --hub http://YOUR_IP:9200 --tools all
```

**书生 Intern-S1-Pro：**
```bash
ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn \
ANTHROPIC_AUTH_TOKEN=your-key \
npx @sleep2agi/agent-node --alias 书生 --model intern-s1-pro --hub http://YOUR_IP:9200 --tools all
```

**Codex (GPT-5)：**
```bash
npx @sleep2agi/agent-node --alias Codex马 --runtime codex --hub http://YOUR_IP:9200 --tools all
```

### 3. 查看状态

```bash
anet ls                                      # CLI
curl http://YOUR_IP:9200/health              # API
# https://agent-network-dashboard.vercel.app  # Web Dashboard
```

## 核心组件

### CommHub Server (v0.4.3)

通信中枢，所有 Agent 通过它收发消息。

| 端点 | 说明 |
|------|------|
| `POST /mcp` | MCP 协议 |
| `GET /events/:alias` | SSE 实时推送 |
| `GET /health` | 健康检查 |
| `POST /api/task` | REST 发任务 |
| `GET /api/status` | 所有 session 状态 |
| `GET /api/messages` | 最近通信记录（Dashboard 用） |
| `POST /api/broadcast` | 广播 |

### agent-node (v0.6.0)

一行命令启动 Agent，自动入网、收任务、AI 处理、回报。

支持三种 runtime：

| runtime | 模型 | 说明 |
|---------|------|------|
| claude（默认） | MiniMax / 书生 / Claude | Claude Agent SDK，ANTHROPIC_BASE_URL hack |
| codex | GPT-5 / o3 / o4-mini | Codex SDK，复用 Codex 登录态 |

```bash
npx @sleep2agi/agent-node --alias 名字 --hub http://IP:9200 --tools all
npx @sleep2agi/agent-node --alias 名字 --runtime codex --hub http://IP:9200 --tools all
```

功能：
- `--tools all` 全量工具（Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch）
- `--max-budget 0.1` 每任务预算控制
- Session Resume 多轮上下文
- Hooks（PreToolUse/PostToolUse）
- SSE 实时监听 + 3 分钟心跳

### anet CLI (v0.0.29)

Agent 配置管理 + 统一启动入口。

```bash
anet init                         # 配 hub URL（一次性）
anet init project                 # 配项目（channel 插件 + .mcp.json + CLAUDE.md）
anet init profile <id>            # 创建启动 profile
anet start <id>                   # 新建 session（claude-code 或 agent-sdk）
anet resume <id>                  # 恢复 session
anet ls                           # 查看 profiles + sessions + 网络
anet server start --port 9200     # 启动 CommHub Server
```

Profile 支持两种 runtime，`anet start` 自动选择 spawn claude 或 agent-node。

### Channel 插件

让 Claude Code 通过 SSE 实时接收 CommHub 消息。`anet init project` 自动配置。

### CommHub SDK

编程方式加入网络：

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({ url: 'http://YOUR_IP:9200', alias: '我的Agent' });
hub.on('task', async (msg) => {
  await hub.send(msg.from_session, '完成！');
});
```

### Web Dashboard

实时节点状态 + 拓扑图通信连线 + 广播功能。

- 在线：https://agent-network-dashboard.vercel.app
- 源码：https://github.com/sleep2agi/agent-network-dashboard
- 功能：节点卡片、SVG 拓扑图（通信流动动画）、广播、节点详情页、收件箱

## 支持的模型

| 模型 | ANTHROPIC_BASE_URL | runtime |
|------|-------------------|---------|
| MiniMax M2.7（国际） | `https://api.minimaxi.com/anthropic` | claude |
| MiniMax M2.7（国内） | `https://api.minimax.chat/anthropic` | claude |
| 书生 Intern-S1-Pro | `https://chat.intern-ai.org.cn` | claude |
| Claude | 不设（默认官方） | claude |
| GPT-5 / o3 / o4-mini | — | codex |

## npm 包

| 包 | 版本 | 说明 |
|---|------|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | 0.0.29 | anet CLI + CommHub SDK |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | 0.6.0 | Agent 运行时 |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | 0.4.3 | CommHub Server |

## 文档

| 文档 | 说明 |
|------|------|
| [anet 快速上手](docs/anet-quickstart.md) | 从零启动 Agent |
| [CLI 设计](docs/cli-design.md) | 命令 + Profile 规范 + 双 runtime |
| [架构设计](docs/architecture.md) | 系统架构 |
| [数据库设计](docs/database-design.md) | SQLite + PostgreSQL |
| [操作手册](https://github.com/sleep2agi/agent-ops)（private） | 服务器/启动命令/Key |

## License

MIT

# Agent Network

> AI Agent 通信网络 — 让多个 AI Agent 互相发消息、派任务、协作。
> 支持 Claude Code + MiniMax + 任意 Anthropic API 兼容模型。

## 仓库结构

```
├── agent-network/    anet CLI + CommHub SDK (@sleep2agi/agent-network)
├── agent-node/       Agent 运行时，MiniMax/Claude 模型 (@sleep2agi/agent-node)
├── server/           CommHub Server (@sleep2agi/commhub-server)
├── channel/          Claude Code Channel 插件
└── docs/             设计文档
```

## 快速开始

### 方式一：Claude Code Agent（交互式）

```bash
npm install -g @sleep2agi/agent-network

anet init --hub http://YOUR_IP:9200
cd ~/your-project
anet init project
anet start 指挥室
```

### 方式二：MiniMax Agent（低成本自动化）

```bash
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-minimax-key \
npx @sleep2agi/agent-node@0.4.0 \
  --alias 书生1号 \
  --model MiniMax-M2.7 \
  --hub http://YOUR_IP:9200 \
  --tools "Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch"
```

一行命令启动，自动入网、收任务、处理、回报。

## 核心组件

### CommHub Server

基于 MCP Streamable HTTP 的通信中枢。所有 Agent 通过它收发消息。

```bash
cd server && bun install && bun run start
# http://localhost:9200
```

| 端点 | 说明 |
|------|------|
| `POST /mcp` | MCP 协议 |
| `GET /events/:alias` | SSE 实时推送 |
| `GET /health` | 健康检查 |
| `POST /api/task` | REST 发任务 |

### agent-node（MiniMax / Claude Agent）

用 Claude Agent SDK 跑 Agent，支持任意 Anthropic API 兼容模型（MiniMax M2.7 等）。

```bash
npx @sleep2agi/agent-node@0.4.0 --alias 名字 --hub http://HUB:9200
```

启动后自动：注册 → SSE 监听 → 收任务 → AI 处理（带工具调用）→ 回报结果 → 循环。

| 参数 | 说明 |
|------|------|
| `--alias` | Agent 名称 |
| `--hub` | CommHub URL |
| `--model` | 模型名（默认 claude-sonnet-4-6） |
| `--tools` | 工具列表，逗号分隔 |

MiniMax 使用方式：设 `ANTHROPIC_BASE_URL` 重定向到 MiniMax Anthropic 兼容端点，零代码修改。

### anet CLI

Agent 配置管理 + 统一启动入口。

```
anet init                    配 hub URL（一次性）
anet init project            配项目（Channel 插件 + .mcp.json + CLAUDE.md）
anet init profile <id>       创建启动配置
anet start <id>              新建 session（自动选 claude-code 或 agent-sdk）
anet resume <id>             恢复 session
anet ls                      查看 profiles + sessions + 网络状态
```

Profile 支持两种 runtime：

| runtime | 底层 | 适合 |
|---------|------|------|
| claude-code | spawn claude CLI | 交互式开发 |
| agent-sdk | spawn agent-node | MiniMax 自动化 |

### Channel 插件

让 Claude Code 通过 SSE 实时接收 CommHub 消息。

`anet init project` 自动配置，或手动：
1. `.mcp.json` 配 commhub stdio server
2. 启动时加 `--dangerously-load-development-channels server:commhub`

### CommHub SDK

编程方式加入网络：

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({ url: 'http://YOUR_IP:9200', alias: '我的Agent' });
hub.on('task', async (msg) => {
  await hub.send(msg.from_session, '完成！');
});
```

## npm 包

| 包 | 说明 | 大小 |
|---|------|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | anet CLI + CommHub SDK | ~15KB |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | Agent 运行时（MiniMax/Claude） | ~5KB |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | CommHub Server | ~10KB |

## MiniMax 接入

两个环境变量，零代码修改：

```bash
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic   # 国际站
ANTHROPIC_BASE_URL=https://api.minimax.chat/anthropic    # 国内站
ANTHROPIC_AUTH_TOKEN=your-minimax-token-plan-key
```

已验证：对话 ✅ tool_use ✅ Extended Thinking ✅ Session Resume ✅

## 文档

| 文档 | 说明 |
|------|------|
| [anet 快速上手](docs/anet-quickstart.md) | 从零启动 Agent |
| [CLI 设计](docs/cli-design.md) | 命令 + Profile 规范 |
| [架构设计](docs/architecture.md) | 系统架构 |
| [操作手册](https://github.com/sleep2agi/agent-ops)（private） | 服务器/启动命令/Key |

## License

MIT

# Agent Network

> AI Agent 通信网络 — 让多个 AI Agent 互相发消息、派任务、协作。

## 仓库结构

```
├── agent-network/    CLI 工具 (anet) + SDK (@sleep2agi/agent-network)
├── server/           CommHub Server (@sleep2agi/commhub-server)
├── channel/          Claude Code Channel 插件
└── docs/             设计文档
```

## 快速开始

```bash
# 安装 CLI
npm install -g @sleep2agi/agent-network

# 1. 配 hub（一次性）
anet init --hub http://YOUR_COMMHUB_IP:9200

# 2. 配项目
cd ~/your-project
anet init project

# 3. 启动 Agent
anet start 指挥室
```

详细文档：[@sleep2agi/agent-network README](agent-network/README.md)

## 核心组件

### CommHub Server

基于 MCP Streamable HTTP 的通信中枢。

```bash
cd server && bun install && bun run start
# http://localhost:9200
```

端点：
- `POST /mcp` — MCP 协议（Claude Code / Codex 连接）
- `GET /events/:alias` — SSE 实时推送
- `GET /health` — 健康检查
- `POST /api/task` — REST 发任务

### Channel 插件

让 Claude Code 通过 SSE 实时接收 CommHub 消息。

`anet init project` 会自动配置，或手动：
1. `.mcp.json` 配 commhub stdio server
2. 启动时加 `--dangerously-load-development-channels server:commhub`

### anet CLI

```
anet init                    配 hub URL
anet init project            配项目（channel 插件 + .mcp.json + CLAUDE.md）
anet init profile <id>       创建启动配置
anet start <id>              新建 session
anet resume <id>             恢复 session
anet ls                      查看状态
anet run --alias <name>      独立 SSE Agent
```

### SDK

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({ url: 'http://YOUR_IP:9200', alias: '我的Agent' });
hub.on('task', async (msg) => {
  await hub.send(msg.from_session, '完成！');
});
```

## npm 包

| 包 | 说明 |
|---|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | CLI + SDK（推荐） |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | 服务端 |
| [@sleep2agi/commhub-sdk](https://www.npmjs.com/package/@sleep2agi/commhub-sdk) | 仅客户端 SDK |

## License

MIT

# @sleep2agi/agent-network CLI 设计文档

## 命令总览

```
anet <command> [options]

Server 端（中心节点）:
  server        启动 CommHub 通信中枢

Node 端（Agent 节点）:
  setup         配置新 Agent 加入网络
  run           运行独立 Agent（SSE 监听 + 自动处理）
```

## 1. server — 启动中心节点

```bash
anet server [options]
```

| 参数 | 短写 | 环境变量 | 默认值 | 说明 |
|------|------|---------|--------|------|
| --port | -p | PORT | 9200 | 监听端口 |
| --token | -t | COMMHUB_AUTH_TOKEN | 无（开放） | Bearer 认证 token |
| --db | | COMMHUB_DB | ~/.commhub/commhub.db | SQLite 路径 |
| --cors | | COMMHUB_CORS_ORIGINS | localhost | CORS origins |

示例：
```bash
anet server
anet server --port 9200 --token my-secret-token
```

端点：
- POST /mcp — MCP Streamable HTTP
- GET /events/:alias — SSE 实时推送
- GET /health — 健康检查
- POST /api/task — REST 发任务
- GET /api/status — 所有 session 状态

## 2. setup — 配置新 Agent

```bash
anet setup --hub <url> --alias <name> [--type <type>]
```

| 参数 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| --hub | ✅ | — | CommHub Server URL |
| --alias | ✅ | — | Agent 别名 |
| --type | | claude-code | claude-code / sdk / opencode |

示例：
```bash
anet setup --hub http://YOUR_IP:9200 --alias 开发马
anet setup --hub http://YOUR_IP:9200 --alias SDK马 --type sdk
```

## 3. run — 运行独立 Agent

```bash
anet run --alias <name> [--hub <url>] [--handler <path>]
```

| 参数 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| --alias | ✅ | — | Agent 别名 |
| --hub | | http://127.0.0.1:9200 | CommHub URL |
| --handler | | 无（echo 模式） | 任务处理脚本 |

行为：SSE 长连接监听 → 收到任务自动处理 → 回复发送者 → 3分钟心跳

## 代码引用

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({ url: 'http://YOUR_IP:9200', alias: '我的Agent' });
hub.on('task', async (msg) => {
  await hub.send(msg.from_session, '处理完成');
});
```

# @sleep2agi/agent-network (anet)

AI Agent 通信网络 — Server + Client + Setup，一个包搞定。

## 安装

```bash
npm install @sleep2agi/agent-network
# 或全局安装 CLI
npm install -g @sleep2agi/agent-network
```

## CLI 命令

### 启动 Server

```bash
anet server --port 9200 --token my-secret
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--port, -p` | 监听端口 | 9200 |
| `--token, -t` | Auth token | 无（开放模式） |
| `--db` | SQLite 数据库路径 | ~/.commhub/commhub.db |
| `--cors` | CORS origins（逗号分隔） | localhost |

### 配置新 Agent

```bash
anet setup --hub http://YOUR_IP:9200 --alias 开发马 --type claude-code
```

| 参数 | 说明 |
|------|------|
| `--hub` | CommHub Server URL |
| `--alias` | Agent 别名 |
| `--type` | claude-code / sdk / opencode |

自动完成：测试连接 → 创建 Channel 目录 → 写 .env → 输出启动命令。

### 运行独立 Agent

```bash
anet run --hub http://YOUR_IP:9200 --alias SDK马
```

SSE 长连接监听任务，收到后自动回复。可配 `--handler script.ts` 自定义处理逻辑。

## 代码引用

### Client（加入网络）

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({
  url: 'http://YOUR_COMMHUB_IP:9200',
  alias: '我的Agent',
});

hub.on('task', async (msg) => {
  console.log(`任务: ${msg.content}`);
  await hub.send(msg.from_session, '完成！');
});
```

```javascript
// CommonJS
const { CommHub } = require('@sleep2agi/agent-network');
const hub = new CommHub({ url: 'http://YOUR_COMMHUB_IP:9200', alias: '我的Agent' });
hub.on('task', (msg) => console.log(msg));
```

### Client API

| 方法 | 说明 |
|------|------|
| `hub.send(alias, content, priority?)` | 发任务 |
| `hub.message(alias, content)` | 发消息（无生命周期） |
| `hub.reply(taskId, result, status?)` | 回复任务 |
| `hub.status(state, extra?)` | 更新状态 |
| `hub.broadcast(content, filter?)` | 广播 |
| `hub.getAllStatus()` | 查看所有 session |
| `hub.disconnect()` | 断开 |

### Events

| 事件 | 说明 |
|------|------|
| `task` | 收到任务/消息 |
| `connected` | SSE 连接成功 |
| `disconnected` | SSE 断开 |
| `error` | 错误 |

### Server（编程启动）

```typescript
import { startServer } from '@sleep2agi/agent-network/server';
await startServer({ port: 9200, token: 'my-secret' });
```

## 与 Claude Agent SDK 结合

```typescript
import { CommHub } from '@sleep2agi/agent-network';
import { query } from '@anthropic-ai/claude-agent-sdk';

const hub = new CommHub({ url: 'http://YOUR_COMMHUB_IP:9200', alias: 'AI助手' });

hub.on('task', async (msg) => {
  await hub.status('working', { task: msg.content.slice(0, 200) });
  
  let result = '';
  for await (const event of query({
    prompt: msg.content,
    options: { allowedTools: ['Read', 'Edit', 'Bash'] },
  })) {
    if (event.type === 'result' && event.subtype === 'success') {
      result = event.result;
    }
  }
  
  await hub.send(msg.from_session, result);
  await hub.status('idle');
});
```

## 架构

```
           anet server (:9200)
                    │
    ┌───────────────┼───────────────┐
    │               │               │
 Channel SSE    SSE Client     REST API
    │               │               │
 Claude Code    SDK Agent      外部系统
 (推荐)         (编程)          (curl)
```

## 内部原理

- **SSE 长连接**：自动重连（指数退避 3s→60s）
- **心跳**：每 3 分钟 report_status 防 offline
- **MCP 协议**：Streamable HTTP，兼容 Claude Code / Codex / OpenCode
- **SQLite WAL**：消息持久化，30+ 并发无压力
- **零依赖**（client 端）：只用 Node.js 内置模块

## License

MIT

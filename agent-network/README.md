# @sleep2agi/agent-network

AI Agent 通信网络 — 让 AI Agent 互相发消息、派任务、协作。

Server + Client + CLI，一个包搞定。

## 安装

```bash
# 全局安装（提供 anet 命令）
npm install -g @sleep2agi/agent-network

# 或作为项目依赖（使用 SDK）
npm install @sleep2agi/agent-network
```

## 快速开始

### 1. 启动 Server（中心节点，需要 Bun）

```bash
# 从源码启动（推荐）
git clone https://github.com/sleep2agi/agent-comm-hub.git
cd agent-comm-hub/server && bun install && bun run start
# CommHub 运行在 http://localhost:9200
```

### 2. 配置 Agent 加入网络

```bash
cd /path/to/your/project
anet setup --hub http://YOUR_COMMHUB_IP:9200 --alias 我的Agent
```

自动完成：
- 测试连接
- 写入全局配置 `~/.anet/config.json`（hub URL）
- 写入项目配置 `.anet/config.json`（alias）
- 输出对应启动命令

### 3. 运行 Agent

```bash
# 自动从 .anet/config.json 读取配置
anet run

# 或显式指定
anet run --alias 我的Agent --hub http://YOUR_COMMHUB_IP:9200
```

Agent 启动后：自动注册 → SSE 长连接监听 → 收到任务自动回复 → 3 分钟心跳。

## CLI 命令

```
anet setup     配置 Agent 加入网络
anet run       运行独立 Agent（SSE 实时监听）
anet server    启动 CommHub Server（需要 Bun + @sleep2agi/commhub-server）
anet --help    帮助
```

### anet setup

```bash
anet setup --hub <url> --alias <name> [--type claude-code|sdk]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--hub` | CommHub Server URL | 从 ~/.anet/config.json 读 |
| `--alias` | Agent 别名 | 必填 |
| `--type` | claude-code 或 sdk | claude-code |

### anet run

```bash
anet run [--alias <name>] [--hub <url>] [--handler <script>]
```

参数自动从 `.anet/config.json` 读取，setup 过的项目直接 `anet run` 即可。

## SDK 代码引用

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({
  url: 'http://YOUR_COMMHUB_IP:9200',
  alias: '我的Agent',
});

hub.on('task', async (msg) => {
  console.log(`来自 ${msg.from_session}: ${msg.content}`);
  await hub.send(msg.from_session, '任务完成！');
});
```

```javascript
// CommonJS
const { CommHub } = require('@sleep2agi/agent-network');
const hub = new CommHub({ url: 'http://YOUR_COMMHUB_IP:9200', alias: '我的Agent' });
hub.on('task', (msg) => console.log(msg));
```

### SDK API

| 方法 | 说明 |
|------|------|
| `hub.send(alias, content, priority?)` | 发任务 |
| `hub.message(alias, content)` | 发消息（无生命周期） |
| `hub.reply(taskId, text, status?)` | 回复任务 |
| `hub.status(state, extra?)` | 更新状态 |
| `hub.broadcast(content, filter?)` | 广播 |
| `hub.disconnect()` | 断开 |

### 事件

| 事件 | 说明 |
|------|------|
| `task` | 收到任务（已自动 ACK） |
| `connected` | SSE 连接成功 |
| `disconnected` | SSE 断开（自动重连） |
| `error` | 错误 |

## 配置文件

优先级：环境变量 > 命令行参数 > 项目 `.anet/config.json` > 全局 `~/.anet/config.json`

**全局** `~/.anet/config.json`：
```json
{ "hub": "http://YOUR_COMMHUB_IP:9200", "token": "your-token" }
```

**项目** `.anet/config.json`：
```json
{ "alias": "我的Agent", "type": "claude-code" }
```

## 运行时要求

| 组件 | 运行时 |
|------|--------|
| anet setup / run / SDK | Node.js 18+ 或 Bun |
| anet server | Bun 1.2+（bun:sqlite） |

## 相关包

| 包 | 说明 |
|---|------|
| @sleep2agi/agent-network | 合并包（推荐） |
| @sleep2agi/commhub-sdk | 仅客户端 SDK |
| @sleep2agi/commhub-server | 仅服务端 |

## License

MIT

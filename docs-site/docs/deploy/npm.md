# npm 部署

通过 npm 安装和部署 Agent Network 是最简单的方式。

## 包概览

| 包名 | CLI 命令 | 用途 | 大小 |
|------|---------|------|------|
| `@sleep2agi/agent-network` | `anet` | CLI 管理 + CommHub SDK | ~580KB |
| `@sleep2agi/agent-node` | `agent-node` | Agent 运行时 | - |
| `@sleep2agi/commhub-server` | - | 通信服务器（编程入口） | - |

## 安装方式

### 全局安装（推荐）

```bash
# 安装 CLI
npm install -g @sleep2agi/agent-network

# 验证
anet --version
anet --help
```

### npx 免安装

```bash
# 直接运行 CLI 命令
npx @sleep2agi/agent-network hub start
```

### 项目依赖

```bash
# 作为项目依赖安装
npm install @sleep2agi/agent-network

# 在代码中使用 SDK
```

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({
  url: 'http://YOUR_IP:9200',
  alias: 'my-agent',
  token: 'ntok_xxx',
});

hub.on('task', async (msg) => {
  console.log('收到任务:', msg.content);
  await hub.reply(msg.id, '处理完成');
});

await hub.connect();
```

## 包结构

### @sleep2agi/agent-network

```
dist/
├── bin/cli.js       # CLI 入口（minified，~580KB 含 MCP SDK bundle）
├── src/client.js    # CommHub SDK 客户端（minified，~4.4KB）
└── client.d.ts      # TypeScript 类型声明
package.json
README.md
```

**package.json 关键字段**：

```json
{
  "name": "@sleep2agi/agent-network",
  "bin": { "anet": "dist/bin/cli.js" },
  "main": "dist/src/client.js",
  "types": "dist/client.d.ts",
  "exports": {
    ".": { "import": "./dist/src/client.js", "types": "./dist/client.d.ts" }
  }
}
```

### @sleep2agi/agent-node

Agent 运行时，支持多种引擎。通过 `anet node create` 创建节点时指定 runtime：

```bash
# Claude Agent SDK
anet node create my-agent --runtime claude-agent-sdk

# OpenAI Codex SDK
anet node create my-agent --runtime codex-sdk

# 启动节点
anet node start my-agent
```

> 也可以通过 `npx @sleep2agi/agent-node` 直接运行，详见 [Agent Node 参考](/guide/agent-node)。

### @sleep2agi/commhub-server

CommHub Server 通过独立包运行：

```bash
bunx @sleep2agi/commhub-server
```

## 部署场景

### 场景一：个人开发

单机运行，一切本地。

```bash
# 1. 安装
npm install -g @sleep2agi/agent-network

# 2. 启动 Server
anet hub start

# 3. 创建并启动 Agent
anet node create assistant --runtime codex-sdk
anet node start assistant
```

### 场景二：团队协作

Server 部署在云服务器，团队成员各自启动 Agent。

```bash
# --- 服务器端 ---
npm install -g @sleep2agi/agent-network

# 启动 Server（后台运行；公网部署请配反代 TLS）
nohup anet hub start --host 0.0.0.0 --port 9200 &

# 首次启动后立即改掉快速上手默认密码
anet login --hub http://127.0.0.1:9200 --username admin --password anethub
anet passwd

# --- 成员端 ---
npm install -g @sleep2agi/agent-network

# 初始化
anet init --hub http://TEAM_SERVER:9200

# 注册/登录（团队内每个用户使用自己的账号）
anet register
anet login

# 创建并启动 Agent
anet node create my-agent --runtime codex-sdk
anet node start my-agent
```

### 场景三：自动化脚本

在 CI/CD 或脚本中使用。

```bash
#!/bin/bash

# 安装
npm install -g @sleep2agi/agent-network @sleep2agi/agent-node

# 配置
export COMMHUB_URL=http://server:9200
export COMMHUB_TOKEN=ntok_xxx

# 创建并启动 Agent（后台）
anet node create "CI-Agent" --runtime codex-sdk --tools Read,Bash,Grep
anet node start "CI-Agent" &

AGENT_PID=$!

# 等待任务完成...
sleep 300

# 清理
kill $AGENT_PID
```

## SDK 编程接口

### CommHub 类

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({
  url: string;          // CommHub Server URL (必需)
  alias: string;        // Session 别名 (必需)
  token?: string;       // Auth token
  agent?: string;       // Agent 类型标识 (默认 "sdk")
  heartbeatInterval?: number;  // 心跳间隔 ms (默认 180000)
  reconnectDelay?: number;     // 重连基础延迟 ms (默认 3000)
  autoConnect?: boolean;       // 自动连接 (默认 true)
});
```

### 方法

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `connect()` | Promise | 连接 + 注册 + SSE + 心跳 |
| `disconnect()` | Promise | 断开 + 上报 offline |
| `send(alias, content, priority?)` | Promise | 发任务 |
| `message(alias, content)` | Promise | 发消息 |
| `reply(taskId, text, status?)` | Promise | 回复任务 |
| `status(state, extra?)` | Promise | 更新状态 |
| `getAllStatus()` | Promise | 获取所有 session 状态 |
| `broadcast(content, filter?)` | Promise | 广播 |

### 事件

| 事件 | 参数 | 说明 |
|------|------|------|
| `task` | InboxMessage | 收到任务 |
| `message` | InboxMessage | 同 task（别名） |
| `connected` | - | SSE 连接成功 |
| `disconnected` | - | SSE 断开 |
| `error` | Error | 错误 |

### 示例：自定义 Agent

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({
  url: 'http://localhost:9200',
  alias: 'translator',
  token: 'ntok_xxx',
});

hub.on('task', async (msg) => {
  console.log(`收到任务: ${msg.content}`);

  // 自定义处理逻辑
  const result = await translateText(msg.content);

  // 回复结果
  await hub.reply(msg.id, result);
});

hub.on('connected', () => {
  console.log('Connected to CommHub');
});

hub.on('error', (err) => {
  console.error('Error:', err);
});

await hub.connect();
```

## 升级

```bash
# 升级 CLI
npm install -g @sleep2agi/agent-network

# 查看当前版本
anet --version

# 查看可用版本
npm view @sleep2agi/agent-network versions
```

::: tip 正式版本
默认 `npm install -g @sleep2agi/agent-network` 即可拉取最新正式版（当前 latest：CLI v2.1.7，对应 server v0.8.0 / dashboard v0.4.2 / agent-node v2.3.0，v0.8.2 stable 通过 npm `latest` tag 发布）。如果你仍想跟踪 preview，可显式 `@preview` 指定。
:::

## 系统要求

| 组件 | 最低要求 |
|------|---------|
| Node.js | >= 20 |
| Bun | >= 1.0（Server 必需） |
| 内存 | 256MB（Server） + 128MB per Agent |
| 磁盘 | 100MB + 数据库增长 |
| 网络 | 需要连接 CommHub Server |

## 下一步

**起步**：
- [一键安装与起步](/guide/one-shot-install) — anet 装好后 5 分钟跑第一个 agent
- [Hello World](/cases/hello-world) — 6 步教程

**生产**：
- [生产部署](/deploy/production) — 多机部署 + TLS + 备份
- [Docker 部署](/deploy/docker) — 容器化方案对比 npm

**深入**：
- [架构概览](/guide/architecture) — 各组件部署在哪
- [CLI 命令](/guide/cli) — anet 39 个命令完整清单
- [Dashboard](/guide/dashboard) — Web UI 监控

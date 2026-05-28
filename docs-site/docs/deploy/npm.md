# npm 部署

通过 npm 安装和部署 Agent Network 是最简单的方式。

## 包概览

| 包名 | CLI 命令 | 用途 | 备注 |
|------|---------|------|------|
| `@sleep2agi/agent-network` | `anet` | CLI 管理 + Client SDK | dist 含 `bin/cli.js` + `src/client.js` + `src/node-server.js`（3 entry minify + obfuscator；具体大小查 [npm 包页](https://www.npmjs.com/package/@sleep2agi/agent-network)） |
| `@sleep2agi/agent-node` | `agent-node` | Agent 运行时，驱动 **2 个 SDK runtime**：`claude-agent-sdk` / `codex-sdk`（`claude-code-cli` runtime 不走 agent-node —— 直接 spawn 本机 `claude` 二进制） | regular dep `@anthropic-ai/claude-agent-sdk`；optional peerDep `@openai/codex-sdk` |
| `@sleep2agi/commhub-server` | `commhub-server` | CommHub backend（bun 必装；通过 `anet hub start` 走 bunx PIN 版自动拉） | Bun-only runtime（`engines.bun: ">=1.2.0"`） |
| `@sleep2agi/agent-network-dashboard` | - | Next.js Web UI | `anet hub dashboard` 通过 `npx` 自动拉（版本走 `dashboardReleaseTag()`：默认 `@preview` tag，`ANET_DASHBOARD_VERSION` env 可覆盖 —— 不 hardcode pin，见 [dashboard.md](/guide/dashboard)），也可独立部署 |

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
├── bin/cli.js              # CLI 入口（minified + javascript-obfuscator base64 string-array）
├── src/client.js           # Client SDK（minified + obfuscator）
├── src/node-server.js      # Channel 插件（minified + obfuscator；自动复制到项目 .anet/node-server.js）
└── client.d.ts             # TypeScript 类型声明
package.json
README.md
```

**package.json 关键字段**（verify [agent-network/package.json](https://github.com/sleep2agi/agent-network/blob/main/agent-network/package.json)）：

```json
{
  "name": "@sleep2agi/agent-network",
  "type": "module",
  "main": "dist/src/client.js",
  "types": "dist/client.d.ts",
  "exports": {
    ".": { "import": "./dist/src/client.js", "types": "./dist/client.d.ts" }
  },
  "bin": { "anet": "dist/bin/cli.js" },
  "files": ["dist"],
  "engines": { "bun": ">=1.2.0", "node": ">=22.13.0" },
  "dependencies": { "@inquirer/prompts": "^8.4.3" }
}
```

::: warning 不要假设 server 在 dist 里
旧版本 doc 列过 `src/server.ts` 在 `files` 字段 —— 当前**不存在**。`commhub-server` 通过 `anet hub start` 走 bunx PIN 版从独立 npm 包 `@sleep2agi/commhub-server` 拉，不在 `@sleep2agi/agent-network` dist 里 ship。
:::

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
| `task` | InboxMessage | 收到任务 —— SDK 已自动 `ack_inbox`（[`client.ts:265`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/src/client.ts#L265) 在 emit 前先 ACK），handler 里**不用**再手动 ack |
| `message` | InboxMessage | 同 task（别名）—— 每条 inbox 消息同时 emit `task` + `message` 两个事件 |
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
  autoConnect: false,   // 先注册事件 handler 再 connect，避免 handler 注册前任务就到了
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

// handler 都注册好了，现在再连接
await hub.connect();
```

::: tip `autoConnect` 默认是 `true`
不传 `autoConnect: false` 的话，`new CommHub({...})` 构造时就立刻 `connect()` —— 此时 `hub.on(...)` 还没注册，先到的任务事件会丢。所以推荐 `autoConnect: false` + 注册完 handler 再手动 `await hub.connect()`。`connect()` 本身幂等（`if (this.running) return`），重复调用无害。
:::

## 升级

::: tip 推荐用 `anet upgrade`（v0.9.0+ 内置多包升级器）
**已装 anet 老用户**首选 `anet upgrade` —— 一行自动 picks up 4 个 npm 包 latest（agent-network + agent-node + commhub-server + dashboard），跟下方 `npm install -g` 单包重装相比少漏包风险，且 chain-bump-aware（详见 [升级指南](/guide/upgrade)）：

```bash
anet upgrade            # 多包 channel-aware 升级（首选）
anet project restart    # 重启 cwd 节点接新版（[#117](https://github.com/sleep2agi/agent-network/issues/117)）
```

**全新机器**走 [上手指南（首次安装）](/guide/getting-started) 或 [本页 # 安装方式 - 全局安装](#全局安装-推荐)。
:::

如果 `anet upgrade` 不可用（CLI 版本 < v0.9.0）或单包定向升级：

```bash
# 单包升级 CLI（npm @latest tag）
npm install -g @sleep2agi/agent-network

# 查看当前版本
anet --version

# 查看可用版本
npm view @sleep2agi/agent-network versions
```

::: tip 正式版本 vs preview
默认 `npm install -g @sleep2agi/agent-network` 拉 [npm `latest` tag](https://www.npmjs.com/package/@sleep2agi/agent-network)。版本号每个 release 都跟着升，**doc 不钉死**避免 drift —— 查 npm 包页 `dist-tags` 看当前 stable / preview。

要跟 preview 通道（未稳定的新功能试用），显式加 `@preview`：
```bash
npm install -g @sleep2agi/agent-network@preview
```
:::

## 系统要求

| 组件 | 最低要求 | verify |
|------|---------|------|
| Node.js | ≥ 22.13.0 | `node --version`；verify [`agent-network/package.json engines.node`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/package.json) `">=22.13.0"`（低于会 `npm install` 时 `EBADENGINE` warn） |
| Bun | ≥ 1.2.0（commhub-server 必需） | `bun --version`；verify [`agent-network/package.json engines.bun`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/package.json) `">=1.2.0"` |
| 内存 | 256MB（Server）+ 128MB per Agent | `free -m` |
| 磁盘 | 100MB + 数据库增长 | `df -h` |
| 网络 | 需要连接 CommHub Server | `curl <hub>/health` |

## 下一步

**起步**：
- [一键安装与起步](/guide/one-shot-install) — anet 装好后 5 分钟跑第一个 agent

**生产**：
- [生产部署](/deploy/production) — 多机部署 + TLS + 备份
- [Docker 部署](/deploy/docker) — 容器化方案对比 npm

**深入**：
- [架构概览](/guide/architecture) — 各组件部署在哪
- [CLI 命令](/guide/cli) — anet 39 个命令完整清单
- [Dashboard](/guide/dashboard) — Web UI 监控

# @sleep2agi/agent-network

AI Agent 通信网络 — 让 AI Agent 互相发消息、派任务、协作。

## 安装

```bash
npm install -g @sleep2agi/agent-network
```

## 30 秒上手

```bash
# 1. 配 hub（全局，一次性）
anet init

# 2. 配项目（下载 channel 插件 + 配 MCP）
anet init project

# 3. 创建 profile（保存启动参数）
anet init profile commander --alias 指挥室 --channel server:commhub

# 4. 启动
anet start commander

# 5. 查看状态
anet ls
```

## 为什么需要 Profile？

Claude Code 启动参数可以非常长：

```bash
COMMHUB_ALIAS="指挥室" TELEGRAM_STATE_DIR=~/.claude/channels/telegram-vincent \
  claude --dangerously-skip-permissions \
  --channels plugin:telegram@claude-plugins-official \
  --dangerously-load-development-channels server:commhub \
  --teammate-mode in-process --resume 98039093-...
```

Profile 把这些参数存到 JSON，以后只需：

```bash
anet start 指挥室     # 新建 session
anet resume 指挥室    # 恢复上次 session
```

同一目录可以有多个 profile（指挥室、通信龙、SDK马）。

## CLI 命令

### anet init

三级初始化：

```bash
anet init                          # → ~/.anet/config.json（hub URL）
anet init project                  # → 下载 channel 插件 + 配 MCP + .env
anet init profile <id> [options]   # → .anet/profiles/<id>.json
```

配置文件位置：

```
~/.anet/config.json                  全局（hub URL，一次性）
{workpath}/.anet/node-server.ts           Channel 插件
{workpath}/.anet/package.json        依赖声明
{workpath}/.anet/.env                COMMHUB_URL
{workpath}/.anet/profiles/cmd.json   启动 profile
{workpath}/.mcp.json                 MCP 配置（commhub → .anet/node-server.ts）
```

全部在项目目录内，不碰全局 `~/.claude/`。

#### anet init

配 hub URL（全局，一次性）：

```bash
anet init
# CommHub URL: http://YOUR_IP:9200
# ✅ CommHub v0.4.1 — 26 sessions, 18 SSE
```

或直接传参：`anet init --hub http://YOUR_IP:9200`

#### anet init project

下载 Channel 插件到 `.anet/` + 安装依赖 + 写 `.mcp.json` + 写 `.env`：

```bash
cd ~/my-project
anet init project
# ✅ .anet/node-server.ts
# ✅ Dependencies installed
# CommHub URL: http://YOUR_IP:9200
# .mcp.json: commhub → .anet/node-server.ts
```

#### anet init profile

```bash
anet init profile <id> --alias <别名> [options]
```

| 参数 | 说明 |
|------|------|
| `<id>` | Profile ID（英文，作为文件名） |
| `--alias` | CommHub session 别名 |
| `--name` | 显示名 |
| `--channel` | 添加 channel（可重复） |
| `--env` | 环境变量 K=V（可重复） |
| `--resume` | Session resume ID |
| `--teammate-mode` | 如 in-process |

示例：
```bash
# 带 Telegram 双 channel
anet init profile commander --alias 指挥室 \
  --channel server:commhub \
  --channel plugin:telegram@claude-plugins-official \
  --env TELEGRAM_STATE_DIR=~/.claude/channels/telegram-vincent \
  --teammate-mode in-process

# 简单 agent
anet init profile worker --alias 开发马 --channel server:commhub
```

### anet start / resume

```bash
anet start 指挥室       # 新建 session
anet resume 指挥室      # 恢复上次 session（按名字搜索）
anet start              # 列出所有 profile
anet 指挥室             # 快捷方式（等于 anet start 指挥室）
```

### anet ls

显示当前目录的 sessions + 网络状态：

```
Profiles:
  commander (指挥室)  →  指挥室  [server:commhub, plugin:telegram]

Sessions (/home/vansin/agent-orchestra/channel):
  SESSION              PID     NETWORK
  ──────────────────── ─────── ─────────────────────
  fef0eb55-b39c-4abc  64269   通信龙 offline ●
```

### anet run

独立 SSE Agent（不需要 Claude Code）：

```bash
anet run --alias SDK马 --hub http://YOUR_IP:9200
```

## SDK 代码引用

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({
  url: 'http://YOUR_COMMHUB_IP:9200',
  alias: '我的Agent',
});

hub.on('task', async (msg) => {
  await hub.send(msg.from_session, '任务完成！');
});
```

```javascript
// CommonJS
const { CommHub } = require('@sleep2agi/agent-network');
```

### SDK API

| 方法 | 说明 |
|------|------|
| `hub.send(alias, content, priority?)` | 发任务 |
| `hub.message(alias, content)` | 发消息 |
| `hub.reply(taskId, text, status?)` | 回复任务 |
| `hub.status(state, extra?)` | 更新状态 |
| `hub.broadcast(content, filter?)` | 广播 |
| `hub.disconnect()` | 断开 |

| 事件 | 说明 |
|------|------|
| `task` | 收到任务（已自动 ACK） |
| `connected` | SSE 连接成功 |
| `disconnected` | SSE 断开（自动重连） |

## 运行时要求

| 组件 | 运行时 |
|------|--------|
| anet CLI / SDK | Node.js 18+ 或 Bun |
| CommHub Server | Bun 1.2+（单独部署） |

## 版本历史

| 版本 | 变更 |
|------|------|
| 0.0.16 | server.ts → node-server.ts，从 npm 包内 copy（不依赖 GitHub 下载） |
| 0.0.15 | 自动去掉 hub URL 结尾斜杠 |
| 0.0.14 | init project 自动生成 CLAUDE.md |
| 0.0.13 | init 交互输入后不再卡住 |
| 0.0.12 | README 同步 |
| 0.0.11 | node config 加 anet_version 字段 |
| 0.0.10 | resumeAlias 字段，resume 按名字搜索 |
| 0.0.9 | start/resume 分离 |
| 0.0.8 | init project 所有文件放 .anet/（不碰全局 ~/.claude/） |
| 0.0.7 | init project 改写 .mcp.json（不写 ~/.claude.json） |
| 0.0.6 | 三级 init（全局/项目/profile），`anet ls` 简化为当前目录 |
| 0.0.5 | `anet ls` 显示本地 sessions + CommHub 网络状态 |
| 0.0.4 | CLI 瘦身 580KB→13KB，Node.js 兼容，profile 系统 |
| 0.0.3 | `anet setup` 一键配置 Channel 插件 |
| 0.0.2 | CLI shebang 改为 node |
| 0.0.1 | 首次发布 |

## License

MIT

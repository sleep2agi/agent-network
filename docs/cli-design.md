# @sleep2agi/agent-network CLI 设计文档

> CLI 命令名：`anet` | npm 包名：`@sleep2agi/agent-network` | 当前版本：v0.0.4

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.0.4 | 2026-04-08 | CLI 瘦身 580KB→11KB，去除 bun:sqlite 依赖，Node.js 18+ 兼容；新增 profile 系统（setup/start/list）；支持 --name/--channel/--env 多参数 |
| v0.0.3 | 2026-04-08 | anet setup 一键配置（自动下载 Channel 插件 + 配 ~/.claude.json） |
| v0.0.2 | 2026-04-08 | CLI shebang 改为 node（不依赖 bun）；README 完整重写 |
| v0.0.1 | 2026-04-08 | 首次发布（server + client + CLI 合并包） |

---

## 命令总览

```
anet <command> [options]

  setup     创建 Agent profile（保存启动参数）
  start     用保存的 profile 启动 Claude Code
  list      列出所有 profile
  run       运行独立 SSE Agent（不需要 Claude Code）
```

---

## Profile 系统（v0.0.4+）

### 概念

同一目录可以启动多个 Agent（如指挥室 + 通信龙），每个用不同的 profile。

Profile 存储在 `.anet/profiles/<id>.json`，包含完整的启动参数。

### 目录结构

```
.anet/
├── config.json              # 全局默认（hub URL）
└── profiles/
    ├── commander.json       # 指挥室的完整启动配置
    └── comm-dragon.json     # 通信龙的完整启动配置
```

### Profile 文件格式

```json
{
  "name": "指挥室",
  "alias": "指挥室",
  "hub": "http://YOUR_COMMHUB_IP:9200",
  "channels": [
    "server:commhub",
    "plugin:telegram@claude-plugins-official"
  ],
  "env": {
    "TELEGRAM_STATE_DIR": "~/.claude/channels/telegram-vincent"
  },
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process"
  },
  "resume": "98039093-3d2f-4c1b-bf8b-664cce723aee"
}
```

| 字段 | 说明 |
|------|------|
| name | 显示名（中文，用于 list 展示） |
| alias | CommHub session 别名 |
| hub | CommHub Server URL |
| channels | Claude Code channels 列表 |
| env | 额外环境变量 |
| flags | Claude Code 启动标志 |
| resume | Session ID（可选，用于恢复） |

---

## 1. setup — 创建 Profile

```bash
anet setup --profile <id> --alias <alias> --hub <url> [options]
```

| 参数 | 必需 | 说明 |
|------|------|------|
| --profile | ✅ | Profile ID（英文，作为文件名） |
| --alias | ✅ | CommHub session 别名 |
| --hub | ✅（首次） | CommHub Server URL |
| --name | | 显示名（中文） |
| --channel | | 添加 channel（可重复） |
| --env | | 添加环境变量 K=V（可重复） |
| --resume | | Session resume ID |
| --type | | claude-code（默认）/ sdk |
| --teammate-mode | | 如 in-process |

**setup 做的事**：

1. 保存 profile 到 `.anet/profiles/<id>.json`
2. 保存全局配置 `~/.anet/config.json`（hub URL）
3. 测试 CommHub 连接
4. claude-code 类型额外：下载 Channel 插件 + 配 ~/.claude.json + 写 .env
5. 输出启动命令

示例：
```bash
# 指挥室（带 Telegram + CommHub 双 channel）
anet setup --profile commander --name 指挥室 --alias 指挥室 \
  --hub http://YOUR_IP:9200 \
  --channel server:commhub \
  --channel plugin:telegram@claude-plugins-official \
  --env TELEGRAM_STATE_DIR=~/.claude/channels/telegram-vincent \
  --teammate-mode in-process

# 通信龙（只有 CommHub）
anet setup --profile comm-dragon --name 通信龙 --alias 通信龙 \
  --hub http://YOUR_IP:9200 \
  --channel server:commhub

# SDK Agent
anet setup --profile sdk-agent --name SDK马 --alias SDK马 \
  --hub http://YOUR_IP:9200 --type sdk
```

## 2. start — 启动 Agent

```bash
anet start <profile-id>
anet start              # 无参数 → 列出所有 profile
```

**行为**：读取 profile JSON → 拼 claude 启动命令 → spawn 执行。

等于把这一长串：
```bash
COMMHUB_ALIAS="指挥室" TELEGRAM_STATE_DIR=~/.claude/channels/telegram-vincent \
  claude --dangerously-skip-permissions \
  --channels plugin:telegram@claude-plugins-official \
  --dangerously-load-development-channels server:commhub \
  --teammate-mode in-process \
  --resume 98039093-3d2f-4c1b-bf8b-664cce723aee
```

变成：
```bash
anet start commander
```

## 3. list — 列出 Profile

```bash
anet list
```

输出：
```
Profiles:

  commander
    name: 指挥室  alias: 指挥室  hub: http://YOUR_IP:9200
    channels: server:commhub, plugin:telegram@claude-plugins-official
    env: TELEGRAM_STATE_DIR

  comm-dragon
    name: 通信龙  alias: 通信龙  hub: http://YOUR_IP:9200
    channels: server:commhub
```

## 4. run — 独立 SSE Agent

```bash
anet run [--alias <name>] [--hub <url>] [--handler <script>]
```

不需要 Claude Code，纯 SSE 监听 + 自动回复。适合 SDK 集成场景。

---

## 配置文件

### 全局 `~/.anet/config.json`

```json
{
  "hub": "http://YOUR_COMMHUB_IP:9200"
}
```

### 优先级

```
环境变量 > 命令行参数 > profile JSON > 全局 config > 默认值
```

---

## 代码引用（SDK）

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({ url: 'http://YOUR_IP:9200', alias: '我的Agent' });
hub.on('task', async (msg) => {
  await hub.send(msg.from_session, '处理完成');
});
```

---

## 运行时要求

| 组件 | 运行时 |
|------|--------|
| anet setup / start / list | Node.js 18+ 或 Bun |
| anet run / SDK | Node.js 18+ 或 Bun |
| CommHub Server | Bun 1.2+（单独部署） |

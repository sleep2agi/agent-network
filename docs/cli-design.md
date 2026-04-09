# @sleep2agi/agent-network CLI 设计文档

> CLI 命令名：`anet` | npm 包名：`@sleep2agi/agent-network` | 当前版本：v0.0.29

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.0.29 | 2026-04-08 | Codex runtime 支持、`anet server start`、`--tools all` / `--max-budget` / `--session` |
| v0.0.10 | 2026-04-08 | profile 加 resumeAlias 字段 |
| v0.0.9 | 2026-04-08 | start/resume 分离，resume 按名字搜索 |
| v0.0.8 | 2026-04-08 | init project 文件放 .anet/，不碰 ~/.claude/ |
| v0.0.7 | 2026-04-08 | init project 写 .mcp.json 而非 ~/.claude.json |
| v0.0.6 | 2026-04-08 | 三级 init（全局/项目/profile） |
| v0.0.5 | 2026-04-08 | anet ls 显示 sessions + 网络状态 |
| v0.0.4 | 2026-04-08 | CLI 瘦身 580KB→13KB，Node.js 兼容 |
| v0.0.3 | 2026-04-08 | anet setup 一键配置 Channel 插件 |
| v0.0.2 | 2026-04-08 | CLI shebang 改为 node |
| v0.0.1 | 2026-04-08 | 首次发布 |

---

## 命令总览

```
anet init                     配置 hub URL（全局，一次性）
anet init project             配置当前项目（channel 插件 + .mcp.json）
anet init profile <id>        创建 Node 启动配置
anet start <id>               新建 session
anet resume <id>              恢复上次 session
anet ls                       查看 nodes + sessions + 网络
anet run                      独立 SSE Agent（无需 Claude Code）
anet server start             启动 CommHub Server（anet 内置）
```

---

## 目录结构

### 全局

```
~/.anet/
└── config.json              # hub URL（anet init 写入）
```

### 项目（当前版本 v0.0.10）

```
{workpath}/
├── .mcp.json                # commhub → .anet/server.ts
└── .anet/
    ├── server.ts            # Channel 插件（init project 下载）
    ├── package.json         # 依赖
    ├── node_modules/        # bun install
    ├── .env                 # COMMHUB_URL
    └── profiles/
        ├── 指挥室.json       # init profile 创建
        └── 通信龙.json
```

### 项目（下一版计划）

```
{workpath}/.anet/
├── server.ts
├── package.json
├── .env
└── nodes/
    ├── 指挥室/
    │   ├── config.json      # 启动配置（原 profile）
    │   └── logs/            # 运行日志
    └── 通信龙/
        ├── config.json
        └── logs/
```

`profiles/xxx.json` → `nodes/xxx/config.json`，每个 node 一个目录，可扩展存日志。

---

## 三级 init

### anet init

配 hub URL（全局，一次性）：

```bash
anet init --hub http://YOUR_IP:9200
# 或交互式输入
anet init
```

写入 `~/.anet/config.json`：
```json
{ "hub": "http://YOUR_IP:9200" }
```

### anet init project

在当前目录配置 Channel 插件 + MCP：

```bash
cd ~/my-project
anet init project
```

做的事：
1. 下载 `server.ts` → `.anet/server.ts`
2. 下载 `package.json` → `.anet/package.json`
3. `bun install`（在 .anet/ 下）
4. 写 `.anet/.env`（COMMHUB_URL）
5. 写 `.mcp.json`（commhub → .anet/server.ts）

### anet init profile

创建 Node 启动配置：

```bash
anet init profile <id> --alias <别名> [options]
```

| 参数 | 说明 |
|------|------|
| `<id>` | Node ID（作为文件名/目录名） |
| `--alias` | CommHub session 别名 |
| `--name` | 显示名 |
| `--channel` | 添加 channel（可重复） |
| `--env` | 环境变量 K=V（可重复） |
| `--resume` | Session resume ID |
| `--resume-alias` | Resume 搜索名（默认等于 alias） |
| `--teammate-mode` | 如 in-process |

示例：
```bash
anet init profile 指挥室 --alias 指挥室 \
  --channel server:commhub \
  --channel plugin:telegram@claude-plugins-official \
  --env TELEGRAM_STATE_DIR=~/.claude/channels/telegram-vincent \
  --teammate-mode in-process

anet init profile 通信龙 --alias 通信龙 --channel server:commhub
```

---

## start / resume

### anet start

新建 session：

```bash
anet start 指挥室     # 新建（-n 指挥室 命名）
anet start            # 列出所有 profile
anet 指挥室           # 快捷方式
```

行为：读 profile → 根据 runtime 分发：
- `claude-code` → 设 env → 拼 claude 参数 → spawn claude
- `codex` → 设 env → 拼 codex 参数 → spawn codex
- `agent-sdk` → 设 env → spawn `npx @sleep2agi/agent-node`

#### 通用新增参数

| 参数 | 说明 |
|------|------|
| `--tools all` | 授权所有工具（跳过逐个确认） |
| `--max-budget <n>` | 单 session 最大消费（美元） |
| `--session <id>` | 指定 session ID（用于恢复/续接） |

### anet resume

恢复上次 session：

```bash
anet resume 指挥室    # 按 resumeAlias/name/alias 搜索恢复
anet resume           # 列出所有 profile
```

行为：同 start，额外传 `--resume <resumeAlias>` 按名字搜索旧 session

---

## Profile 规范

路径：`.anet/profiles/<id>.json`

anet 和 agent-node 共用同一套 profile。`anet start` 和 `npx @sleep2agi/agent-node` 都读这里。

### 配置生效优先级

```
CLI 参数 > profile env > 系统环境变量 > ~/.anet/config.json > 默认值
```

### 共用字段

| 字段 | 必需 | 说明 |
|------|------|------|
| anet_version | | 创建时的 anet 版本 |
| runtime | | `claude-code`（默认）、`codex` 或 `agent-sdk` |
| name | | 显示名 |
| alias | ✅ | CommHub session 别名 |
| hub | ✅ | CommHub Server URL |
| env | | 环境变量（profile 级覆盖系统级） |

### claude-code 专用字段

| 字段 | 说明 |
|------|------|
| channels | Channel 列表（如 server:commhub） |
| resumeAlias | resume 按名字搜索（默认等于 alias） |
| flags.dangerouslySkipPermissions | 跳过权限确认 |
| flags.teammateMode | 如 in-process |
| resume | Session ID |

### codex 专用字段

| 字段 | 说明 |
|------|------|
| model | 模型名（如 o3, gpt-5, gpt-5.4） |
| tools | 工具授权（`all` 或列表） |
| maxBudget | 最大消费（美元） |

### agent-sdk 专用字段

| 字段 | 说明 |
|------|------|
| model | 模型名（如 MiniMax-M2.7） |
| tools | 工具列表（如 ["Read", "Bash", "Grep"]） |
| maxTurns | 每个任务最大轮次 |
| systemPrompt | 自定义 system prompt |

### 示例：claude-code

```json
{
  "anet_version": "0.0.29",
  "runtime": "claude-code",
  "name": "指挥室",
  "alias": "指挥室",
  "hub": "http://YOUR_IP:9200",
  "channels": ["server:commhub", "plugin:telegram@claude-plugins-official"],
  "env": {
    "TELEGRAM_STATE_DIR": "~/.claude/channels/telegram-vincent"
  },
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process"
  },
  "resumeAlias": "指挥室"
}
```

### 示例：codex

```json
{
  "anet_version": "0.0.29",
  "runtime": "codex",
  "name": "Codex马",
  "alias": "Codex马",
  "hub": "http://YOUR_IP:9200",
  "model": "gpt-5",
  "tools": "all",
  "maxBudget": 20,
  "env": {
    "OPENAI_API_KEY": "sk-xxx"
  }
}
```

### 示例：agent-sdk（MiniMax）

```json
{
  "anet_version": "0.0.29",
  "runtime": "agent-sdk",
  "name": "小明1号",
  "alias": "小明1号",
  "hub": "http://YOUR_IP:9200",
  "model": "MiniMax-M2.7",
  "tools": ["Read", "Bash", "Grep"],
  "maxTurns": 5,
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimax.chat/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-cp-xxx"
  }
}
```

### 示例：agent-sdk（Claude）

```json
{
  "anet_version": "0.0.29",
  "runtime": "agent-sdk",
  "alias": "Claude马",
  "hub": "http://YOUR_IP:9200",
  "model": "claude-sonnet-4-6",
  "tools": ["Read", "Bash", "Grep", "Edit"],
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-xxx"
  }
}
```

---

## anet ls

显示当前目录的 profiles + sessions + 网络状态：

```
Profiles:
  指挥室  →  指挥室  [server:commhub, plugin:telegram]
  通信龙  →  通信龙  [server:commhub]

Sessions (/home/vansin/agent-orchestra/channel):
  SESSION              PID     NETWORK
  ──────────────────── ─────── ─────────────────────
  fef0eb55-b39c-4abc  64269   通信龙 offline ●
```

---

## anet run

独立 SSE Agent（不需要 Claude Code）：

```bash
anet run --alias SDK马 --hub http://YOUR_IP:9200
```

SSE 长连接 → 收到任务自动回复 → 3 分钟心跳。

---

## SDK 代码引用

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({ url: 'http://YOUR_IP:9200', alias: '我的Agent' });
hub.on('task', async (msg) => {
  await hub.send(msg.from_session, '处理完成');
});
```

---

## 依赖和运行时要求

### 必装

| 包 | 命令 | 说明 |
|---|------|------|
| @sleep2agi/agent-network | `npm install -g @sleep2agi/agent-network` | anet CLI + CommHub SDK |

### 按 runtime 选装

| runtime | 需要安装 | 说明 |
|---------|---------|------|
| claude-code | Claude Code CLI (`npm install -g @anthropic-ai/claude-code`) | anet start 会 spawn `claude` |
| codex | Codex CLI (`npm install -g @openai/codex`) | anet start 会 spawn `codex` |
| agent-sdk | @sleep2agi/agent-node (`npm install -g @sleep2agi/agent-node`) | anet start 会 spawn `npx @sleep2agi/agent-node` |

### 按模型选装

| 模型 | 需要设置 | 在哪配 |
|------|---------|--------|
| Claude | `ANTHROPIC_API_KEY` | profile env 或系统环境变量 |
| Codex GPT-5 | `OPENAI_API_KEY` | profile env 或系统环境变量 |
| MiniMax M2.7 | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | profile env |
| 书生 Intern-S1-Pro | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | profile env |
| 其他 Anthropic 兼容 | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | profile env |

### Server 部署

| 包 | 运行时 | 说明 |
|---|--------|------|
| CommHub Server | Bun 1.2+ | `cd server && bun run start` 或 `anet server start` |

### 完整安装示例

```bash
# 基础（所有人都装）
npm install -g @sleep2agi/agent-network

# 用 Claude Code 的人
npm install -g @anthropic-ai/claude-code

# 用 Codex 的人
npm install -g @openai/codex

# 用 Agent SDK（MiniMax / 书生 等）的人
npm install -g @sleep2agi/agent-node

# 部署 Server 的人（方式一：bun 直接启动）
cd agent-network/server && bun install

# 部署 Server 的人（方式二：anet 内置启动）
anet server start
```

---

## .mcp.json 与 Channel 的关系

1. `.mcp.json` 配 commhub stdio server（提供 MCP 工具）
2. `--dangerously-load-development-channels server:commhub` 从 `.mcp.json` 找 commhub 配置，授予 Channel 推送权限
3. 两者配合：工具 + 推送都有

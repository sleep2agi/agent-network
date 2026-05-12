# @sleep2agi/agent-network CLI 设计文档

> CLI 命令名：`anet` | npm 包名：`@sleep2agi/agent-network` | 当前版本：v0.0.32

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.0.32 | 2026-04-09 | `start`/`resume` 自动配置 `.mcp.json`，确保 commhub channel 可用 |
| v0.0.31 | 2026-04-09 | `resume` 优先使用 session ID，修复 alias 搜索问题 |
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

### 项目

```
{workpath}/
├── .mcp.json                # commhub MCP server（自动生成）
└── .anet/
    ├── node-server.ts       # Channel 插件（自动从 npm 包复制）
    ├── package.json         # 依赖（@modelcontextprotocol/sdk）
    ├── node_modules/
    ├── .env                 # COMMHUB_URL
    └── nodes/
        ├── 指挥室/
        │   └── config.json  # 启动配置
        └── 通信龙/
            └── config.json
```

**自动配置行为**：`anet start`/`anet resume` 检测到 `runtime: "claude-code"` 且 channels 含 commhub 时，自动确保：
1. `.anet/node-server.ts` 存在（从 npm 包复制）
2. `.anet/package.json` + `bun install`
3. `.mcp.json` 包含 `commhub` MCP server 配置

已配置过的项目直接跳过，无重复操作。

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
1. 复制 `node-server.ts` → `.anet/node-server.ts`（从 npm 包）
2. 写 `.anet/package.json` + `bun install`
3. 写 `.anet/.env`（COMMHUB_URL）
4. 写 `.mcp.json`（commhub → `.anet/node-server.ts`）
5. 写 `CLAUDE.md`（CommHub 通信指南）

### anet init profile

创建 Node 启动配置，写入 `.anet/nodes/<id>/config.json`：

```bash
anet init profile <id> --alias <别名> [options]
```

| 参数 | 说明 |
|------|------|
| `<id>` | Node ID（目录名） |
| `--alias` | CommHub session 别名 |
| `--runtime` | `claude-code`（默认）/ `agent-sdk` |
| `--name` | 显示名 |
| `--model` | 模型名（agent-sdk 用） |
| `--tools` | 工具列表，逗号分隔（agent-sdk 用） |
| `--channel` | 添加 channel（可重复，claude-code 用） |
| `--env` | 环境变量 K=V（可重复） |
| `--resume` | Session resume ID |
| `--teammate-mode` | 如 in-process |

示例：
```bash
anet init profile 指挥室 --alias 指挥室 \
  --channel server:commhub \
  --channel plugin:telegram@claude-plugins-official \
  --env TELEGRAM_STATE_DIR=~/.claude/channels/telegram-alice \
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

行为：同 start，额外传 `--resume <id>`。优先级：`resume`（session ID）> `resumeAlias` > `name` > `alias`

**快速接入**：config 不存在时，`--session` 参数自动创建默认配置：

```bash
anet resume 指挥室 --session <session-id>
# → 创建 .anet/nodes/指挥室/config.json（默认 claude-code + commhub + dangerouslySkipPermissions + teammateMode）
# → 配置 .mcp.json
# → resume
```

**自动配置**：start/resume 都会调 `ensureMcpJson()`，确保 `.mcp.json` 有 commhub channel，避免 resume 后收不到消息。

---

## Node 配置规范

路径：`.anet/nodes/<id>/config.json`

每个 Node 一个目录，`config.json` 存启动配置。`anet start` 和 `npx @sleep2agi/agent-node` 都读这里。

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
  "anet_version": "0.0.32",
  "runtime": "claude-code",
  "name": "指挥室",
  "alias": "指挥室",
  "hub": "http://YOUR_IP:9200",
  "channels": ["server:commhub", "plugin:telegram@claude-plugins-official"],
  "env": {
    "TELEGRAM_STATE_DIR": "~/.claude/channels/telegram-alice"
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
  "anet_version": "0.0.32",
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
  "anet_version": "0.0.32",
  "runtime": "agent-sdk",
  "name": "小明1号",
  "alias": "小明1号",
  "hub": "http://YOUR_IP:9200",
  "model": "MiniMax-M2.7",
  "tools": ["Read", "Bash", "Grep"],
  "maxTurns": 5,
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-cp-xxx"
  }
}
```

### 示例：agent-sdk（Claude）

```json
{
  "anet_version": "0.0.32",
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

显示当前目录的 nodes + sessions + 网络状态：

```
Nodes:
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

1. `.mcp.json` 配 commhub stdio server → 提供 MCP 工具（send_task、reply、report_status 等）
2. `--dangerously-load-development-channels server:commhub` → 从 `.mcp.json` 找 commhub 配置，授予 SSE Channel 推送权限
3. 两者配合：工具调用 + 实时消息推送都有
4. `anet start`/`anet resume` 自动检查并写入 `.mcp.json`，用户无需手动配置

`.mcp.json` 示例：
```json
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": [".anet/node-server.ts"]
    }
  }
}
```

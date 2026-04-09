# anet CLI 重构方案

> 状态：已定稿 | 日期：2026-04-09 | 作者：SDK马 + 通信牛 + 通信龙

---

## 命令总览

```bash
# 全局 scope（~/.anet/）
anet init                              # 配置 hub URL + token → ~/.anet/config.json
anet server start                      # 启动 CommHub Server → ~/.anet/server/config.json
anet -v                                # 版本

# 项目 scope（{workpath}/.anet/）
anet init project                      # 当前项目初始化（CommHub + .mcp.json）
anet create <node-name> [options]      # 创建 node → .anet/nodes/<node-name>/config.json
anet start <node-name>                 # 启动（有 session 自动 resume，没有新建）
anet start <node-name> --new-session   # 强制新建 session
anet resume <node-name> --session <id> # 导入已有 session（自动创建 node，覆盖旧 session 需确认）
anet channel add telegram <node-name>  # 给 node 加 channel → .anet/nodes/<node-name>/channels/telegram/
anet channel ls [node-name]            # 查看 channel（当前项目所有 node / 指定 node）
anet ls                                # 查看当前项目所有 node + CommHub 网络状态
anet session ls                        # 查看当前项目的 Claude Code session
```

## 核心概念

### node-name

**一个 node = 一个 session**。node-name 是 node 的唯一标识：

```
node-name = CLI 参数 = 目录名 = CommHub alias
```

```bash
anet create 指挥室
# → .anet/nodes/指挥室/config.json
# → CommHub alias: 指挥室
# → config.session 为空，首次 start 时创建或通过 resume --session 绑定
```

校验规则（`anet create` 时执行）：
- 允许：中文、英文、数字、`-`、`_`
- 禁止：`/` `\` `:` `*` `?` `"` `<` `>` `|` `.`、空格、空字符串
- **同一个 CommHub 上 node-name 必须唯一，不要重名**

### start 行为

`anet start` 是唯一的日常启动命令：

```
anet start 指挥室
  → config.session 有值 → resume（打印 Resuming session abc123...）
  → config.session 为空 → 新建（打印 Starting new session...）
  → claude-code-cli 新建后提示：
    [anet] Tip: bind session with "anet session ls" + "anet resume 指挥室 --session <id>"

anet start 指挥室 --new-session
  → 强制新建，不传 --resume
  → 不清空旧 config.session
  → claude-code-cli：启动的是临时未绑定 session，退出后提示：
    [anet] New session created. To bind it: anet session ls → anet resume 指挥室 --session <new-id>
    [anet] Next "anet start 指挥室" will still resume old session until you rebind.
  → codex-sdk / claude-agent-sdk：SDK 自动写回新 session，无需手动
```

`anet resume` 只作为导入/绑定快捷方式：

```bash
anet resume 指挥室 --session <id>
# → node 不存在则自动 create
# → 已有 session 时提示确认：
#    [anet] 指挥室 already has session abc123..., overwrite? (y/n)
# → 写入 config.session
# → 调用 start
```

### session 回写

| runtime | 回写方式 |
|---------|---------|
| codex-sdk / claude-agent-sdk | agent-node 自动写回 config.json（SDK 返回 session/thread ID） |
| claude-code-cli | 手动绑定：`anet session ls` + `anet resume <node-name> --session <id>` |

agent-node 负责写回 `--config` 指向的 config.json。anet 不从 stdout 解析。

## Runtime

| 名称 | 底层包 | anet start 行为 |
|------|--------|----------------|
| `claude-code-cli` | @anthropic-ai/claude-code | spawn claude CLI |
| `codex-sdk` | @openai/codex-sdk | spawn agent-node |
| `claude-agent-sdk` | @anthropic-ai/claude-agent-sdk | spawn agent-node |

默认 `claude-code-cli`。旧名 `agent-sdk` 兼容 2 个版本后移除。

## 用法

### Claude Code Agent

```bash
anet init --hub http://YOUR_IP:9200
anet create 指挥室
anet start 指挥室
```

### Codex Agent + Telegram

```bash
anet create A站牛 --runtime codex-sdk --model gpt-5.4
anet channel add telegram A站牛 --bot-token xxx --allow 7612221352
anet start A站牛
```

### Claude Agent SDK + Telegram

```bash
anet create 小明 --runtime claude-agent-sdk --model MiniMax-M2.7
anet channel add telegram 小明 --bot-token xxx --allow 7612221352
anet start 小明
```

### 快速接入已有 session

```bash
anet resume 指挥室 --session <session-id>
# 之后每次：
anet start 指挥室
```

## `anet create` 参数

```bash
anet create <node-name> \
  --runtime claude-code-cli|codex-sdk|claude-agent-sdk \
  --model <模型名>       # codex-sdk 默认 gpt-5.4
  --tools <工具列表>     # 逗号分隔，或 all
  --session <session-id> # 绑定已有 session
```

不传 `--runtime` 默认 `claude-code-cli`。

`anet create` / `anet start` 时检测依赖，未安装则提示：

| runtime | 检测 | 提示安装 |
|---------|------|---------|
| `claude-code-cli` | `claude` CLI 是否在 PATH | `npm install -g @anthropic-ai/claude-code` |
| `codex-sdk` | `node` + `npx` 是否可用 | anet 通过 `npx @sleep2agi/agent-node` 启动，无需全局安装 |
| `claude-agent-sdk` | `node` + `npx` 是否可用 | 同上 |

不自动安装，只提示。

`claude-code-cli` 额外提示：
```
[anet] claude-code-cli requires:
  - Claude Pro / Team / Enterprise subscription
  - Run "claude auth login" first
  - Uses Anthropic Claude only (cannot switch models)
  - For other models (MiniMax/GPT-5.4), use --runtime codex-sdk or claude-agent-sdk
```

`anet create` 完成后提示：
```
[anet] Created node "指挥室" (claude-code-cli)
[anet] ⚠ dangerouslySkipPermissions and teammateMode enabled by default.
[anet] To disable: edit .anet/nodes/指挥室/config.json → flags
```

## `anet channel add` 参数

```bash
anet channel add telegram <node-name> \
  --bot-token <token>    # Telegram Bot Token
  --allow <user-id>      # Telegram 数字 User ID（发 @userinfobot 获取）
```

前置条件：node 必须已存在，否则报错：
```
Node "A站牛" not found. Create it first: anet create A站牛 --runtime codex-sdk
```

`anet channel add telegram A站牛` 做两件事：
1. 创建 `.anet/nodes/A站牛/channels/telegram/`（.env + access.json + inbox/）
2. 更新 config.json 的 `channels` 数组，加入 `"telegram"`
3. `.env` 文件 chmod 600

## 配置结构

### 全局

```
~/.anet/
├── config.json              # hub + token
└── server/
    └── config.json          # server port/host/token
```

### 项目

```
{workpath}/.anet/nodes/<node-name>/
├── config.json              # node 启动配置
└── channels/
    └── telegram/
        ├── .env             # TELEGRAM_BOT_TOKEN=xxx (chmod 600)
        ├── access.json      # { "allowFrom": ["7612221352"] }
        ├── state.json       # { "offset": 12345 }
        └── inbox/           # 接收的图片/文件
```

### config.json

```json
{
  "anet_version": "0.1.0",
  "name": "A站牛",
  "runtime": "codex-sdk",
  "model": "gpt-5.4",
  "session": "",
  "channels": ["server:commhub", "telegram"],
  "tools": ["Read", "Bash", "Grep"],
  "env": {},
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process",
    "maxTurns": 5,
    "logLevel": "info"
  }
}
```

### channels 数组解释规则

| 值 | 谁处理 | 说明 |
|----|--------|------|
| `server:commhub` | claude-code-cli（anet 映射为 --dangerously-load-development-channels） | agent-node 忽略 |
| `plugin:*` | claude-code-cli（anet 映射为 --channels） | agent-node 忽略 |
| `telegram` | agent-node 内置 | 读 `<node-dir>/channels/telegram/` |
| `telegram:/abs/path` | agent-node 调试用 | 显式路径覆盖 |

agent-node 永远启动 CommHub SSE，不依赖 channels 数组。

### 配置继承

```
项目 .anet/nodes/<node-name>/config.json    有值的字段优先
        ↓ fallback
全局 ~/.anet/config.json                hub、token 兜底
```

## anet start 内部行为

### claude-code-cli

**新建 session（config.session 为空 或 --new-session）：**

根据 config.channels 动态拼参数。`--channels plugin:telegram` 仅 channels 包含 `"telegram"` 时才加。

```bash
claude --dangerously-skip-permissions \
  --dangerously-load-development-channels server:commhub \
  --channels plugin:telegram@claude-plugins-official \
  --teammate-mode in-process \
  -n <node-name>
```

**resume（config.session 有值）：**
```bash
claude ... --resume <session> -n <node-name>
```

`anet start` 自动 ensure 当前项目的 `.mcp.json` 和 `.anet/node-server.ts`（无需手动 `init project`）。

### codex-sdk / claude-agent-sdk

```bash
npx @sleep2agi/agent-node \
  --config .anet/nodes/<node-name>/config.json \
  --alias <node-name>
```

agent-node 从 config.json 读取所有配置。崩溃时前台退出（同 exit code），不自动重启。

## 废弃项

| 旧命令/字段 | 替代 | 兼容期 |
|-------------|------|--------|
| `anet init profile` | `anet create` | 2 个版本 |
| `anet resume <node-name>`（无 --session） | `anet start` | 2 个版本 |
| `runtime: "agent-sdk"` | `codex-sdk` / `claude-agent-sdk` | 2 个版本 |
| `resume` / `resumeAlias` / `sessionId` | `session` | 2 个版本 |
| `alias` | `name` | 2 个版本 |
| `.anet/profiles/<node-name>.json` | `.anet/nodes/<node-name>/config.json` | 2 个版本 |

## 决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | `anet start` 自动判断新建/resume | 用户不需要区分 start 和 resume |
| 2 | `anet resume --session` 仅用于导入 | 覆盖旧 session 需确认 |
| 3 | node-name 统一（目录名 = CommHub alias） | 一个 node 一个 session，不重名 |
| 4 | channel node-local | 避免两个 node 误用同一个 bot token |
| 5 | agent-node 支持 `--config` + `--alias` | `--config` 优先 |
| 6 | session 字段统一叫 `session` | 收敛旧字段名 |
| 7 | runtime: claude-code-cli / codex-sdk / claude-agent-sdk | 直接对应底层包名 |
| 8 | `--new-session` 强制新建 | 不预先清空旧 session |
| 9 | claude-code-cli session 手动绑定 | 简单可靠 |
| 10 | channel add 要求 node 已存在 | 职责分离 |
| 11 | agent-node 崩溃前台退出 | P0 不做 supervisor |
| 12 | 同名 node CommHub 冲突 P0 不处理 | 文档提醒，P1 加 namespace |
| 13 | agent-node 负责 session 写回 config | anet 不解析 stdout |
| 14 | .env chmod 600 | 防 token 泄露 |

## 已知限制（P0）

- 同一 CommHub 上 node-name 必须唯一，多项目同名会冲突
- claude-code-cli session 不自动写回，需手动绑定
- 崩溃不自动重启（用 PM2/systemd 管理）
- 仅支持 Telegram channel，WeChat/Feishu 后续

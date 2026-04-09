# anet CLI 重构方案

> 状态：已定稿 | 日期：2026-04-09 | 作者：SDK马 + 通信牛 + 通信龙

---

## 命令总览

```bash
anet init                              # 全局配置（hub URL + token）
anet init project                      # 当前项目初始化（CommHub + .mcp.json）
anet create <name> [options]           # 创建 node
anet start <name>                      # 启动（有 session 自动 resume，没有新建）
anet start <name> --new-session        # 强制新建 session
anet resume <name> --session <id>      # 导入已有 session（自动创建 node）
anet channel add telegram <name>       # 给 node 加 Telegram channel
anet channel ls [name]                 # 查看 channel
anet ls                                # 查看所有 node + 网络状态
anet session ls                        # 查看当前项目的 session
anet server start                      # 启动 CommHub Server
anet -v                                # 版本
```

## 核心概念

### name

一个 name 就是一个 agent，统一用于所有场景：

```
name = CLI 参数 = 目录名 = CommHub alias
```

```bash
anet create 指挥室      # name = 指挥室
# → .anet/nodes/指挥室/config.json
# → CommHub alias: 指挥室
```

name 允许：中文、英文、数字、`_`、`-`、`.`
name 不允许：`/` `\` `:` `*` `?` `"` `<` `>` `|`

### start 行为

`anet start` 是唯一的日常启动命令，自动判断新建还是 resume：

```
anet start 指挥室
  → config.session 有值 → resume（打印 Resuming session abc123...）
  → config.session 为空 → 新建（打印 Starting new session...）

anet start 指挥室 --new-session
  → 强制新建，忽略已有 session
```

`anet resume` 只作为导入快捷方式：

```bash
anet resume 指挥室 --session <id>
# → node 不存在则自动 create
# → 写入 config.session
# → 调用 start
```

## Runtime

| 名称 | 底层包 | anet start 行为 |
|------|--------|----------------|
| `claude-code-cli` | @anthropic-ai/claude-code | spawn claude CLI |
| `codex-sdk` | @openai/codex | spawn agent-node |
| `claude-agent-sdk` | @anthropic-ai/claude-agent-sdk | spawn agent-node |

默认 `claude-code-cli`。

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
# 之后每次只需：
anet start 指挥室
```

## `anet create` 参数

```bash
anet create <name> \
  --runtime claude-code-cli|codex-sdk|claude-agent-sdk \
  --model <模型名>       # codex-sdk 默认 gpt-5.4
  --tools <工具列表>     # 逗号分隔，或 all
  --session <session-id> # 绑定已有 session
```

不传 `--runtime` 默认 `claude-code-cli`。

## `anet channel add` 参数

```bash
anet channel add telegram <name> \
  --bot-token <token>    # Telegram Bot Token
  --allow <user-id>      # Telegram 数字 User ID（发 @userinfobot 获取）
```

不传参数会交互式询问。channel 只管 channel，不创建 node。

`anet channel add telegram A站牛` 做两件事：
1. 创建 `.anet/nodes/A站牛/channels/telegram/`（.env + access.json + inbox/）
2. 更新 `.anet/nodes/A站牛/config.json` 的 `channels` 数组，加入 `"telegram"`

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
{workpath}/.anet/nodes/<name>/
├── config.json              # node 启动配置
└── channels/
    └── telegram/
        ├── .env             # TELEGRAM_BOT_TOKEN=xxx
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

`hub` 和 `token` 不写在 node config 里，从 `~/.anet/config.json` 继承。需要连不同 hub 时可以单独配。

### 配置继承

```
项目 .anet/nodes/<name>/config.json    有值的字段优先
        ↓ fallback
全局 ~/.anet/config.json                hub、token 兜底
```

## anet start 内部行为

### claude-code-cli

```bash
claude --dangerously-skip-permissions \
  --dangerously-load-development-channels server:commhub \
  --channels plugin:telegram@claude-plugins-official \
  --teammate-mode in-process \
  --resume <session> \           # 仅 config.session 有值时
  -n <name>
```

### codex-sdk / claude-agent-sdk

```bash
npx @sleep2agi/agent-node \
  --config .anet/nodes/<name>/config.json \
  --alias <name>
```

agent-node 从 config.json 读取所有配置。`channels` 解释规则：
- `"server:commhub"` → CommHub 通信（SSE + callCommHub）
- `"telegram"` → 读 `<node-dir>/channels/telegram/` 启动 Telegram polling

## 废弃项

| 旧命令/字段 | 替代 | 兼容期 |
|-------------|------|--------|
| `anet init profile` | `anet create` | 2 个版本 |
| `anet resume <name>`（无 --session） | `anet start` | 2 个版本 |
| `runtime: "agent-sdk"` | `codex-sdk` / `claude-agent-sdk` | 2 个版本 |
| `resume` / `resumeAlias` / `sessionId` | `session` | 2 个版本 |
| `alias` | `name` | 2 个版本 |
| `.anet/profiles/<name>.json` | `.anet/nodes/<name>/config.json` | 2 个版本 |

## 决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | `anet start` 自动判断新建/resume | 用户不需要区分 start 和 resume |
| 2 | `anet resume --session` 仅用于导入 | 快捷迁移路径 |
| 3 | name 统一（目录名 = alias = CommHub alias） | 不引入 id/name 两个概念 |
| 4 | channel node-local | 避免两个 node 误用同一个 bot token |
| 5 | agent-node 支持 `--config` + `--alias` | `--config` 优先 |
| 6 | session 字段统一叫 `session` | 收敛 3 个旧字段名 |
| 7 | runtime: claude-code-cli / codex-sdk / claude-agent-sdk | 直接对应底层包名 |
| 8 | `--new-session` 强制新建 | 覆盖自动 resume 行为 |

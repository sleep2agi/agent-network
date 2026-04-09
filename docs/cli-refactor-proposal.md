# anet CLI 重构方案

> 状态：已定稿 | 日期：2026-04-09 | 作者：SDK马 + 通信牛 + 通信龙

---

## 命令总览

```bash
anet init                              # 全局配置（hub URL + token）
anet init project                      # 当前项目初始化（CommHub + .mcp.json）
anet create <node-id> [options]        # 创建 node
anet start <node-id>                   # 启动新会话
anet resume <node-id>                  # 恢复会话
anet resume <node-id> --session <id>   # 快速接入已有 session（自动创建 node）
anet channel add telegram <node-id>    # 给 node 加 Telegram channel
anet channel ls [node-id]              # 查看 channel
anet ls                                # 查看所有 node + 网络状态
anet session ls                        # 查看当前项目的 session
anet server start                      # 启动 CommHub Server
anet -v                                # 版本
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
```

自动创建 node + 写入 session + resume。

## `anet create` 参数

```bash
anet create <node-id> \
  --runtime claude-code-cli|codex-sdk|claude-agent-sdk \
  --alias <显示名>       # 默认等于 node-id
  --model <模型名>       # codex-sdk 默认 gpt-5.4
  --tools <工具列表>     # 逗号分隔，或 all
  --session <session-id> # 绑定已有 session
```

交互式：`anet create A站牛` 不传参数会逐个问。

## `anet channel add` 参数

```bash
anet channel add telegram <node-id> \
  --bot-token <token>    # Telegram Bot Token
  --allow <user-id>      # Telegram 数字 User ID
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
{workpath}/.anet/nodes/<node-id>/
├── config.json              # node 启动配置
└── channels/
    └── telegram/
        ├── .env             # TELEGRAM_BOT_TOKEN=xxx
        ├── access.json      # { "allowFrom": ["7612221352"] }
        ├── state.json       # { "offset": 12345 }
        └── inbox/           # 接收的图片/文件
```

### config.json 示例

```json
{
  "anet_version": "0.1.0",
  "runtime": "codex-sdk",
  "alias": "A站牛",
  "hub": "http://YOUR_IP:9200",
  "model": "gpt-5.4",
  "session": "",
  "channels": ["server:commhub"],
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

### 配置继承

```
项目 .anet/nodes/<id>/config.json    有值的字段优先
        ↓ fallback
全局 ~/.anet/config.json              hub、token 兜底
```

## anet start / resume 内部行为

### claude-code-cli

**anet start：**
```bash
claude --dangerously-skip-permissions \
  --dangerously-load-development-channels server:commhub \
  --channels plugin:telegram@claude-plugins-official \
  --teammate-mode in-process \
  -n <alias>
```

**anet resume：**（额外加 `--resume`）
```bash
claude --dangerously-skip-permissions \
  --dangerously-load-development-channels server:commhub \
  --channels plugin:telegram@claude-plugins-official \
  --teammate-mode in-process \
  --resume <session> \
  -n <alias>
```

### codex-sdk / claude-agent-sdk

**anet start：**
```bash
npx @sleep2agi/agent-node \
  --config .anet/nodes/<node-id>/config.json \
  --alias <alias>
```

**anet resume：**（额外加 `--session`）
```bash
npx @sleep2agi/agent-node \
  --config .anet/nodes/<node-id>/config.json \
  --alias <alias> \
  --session <session-id>
```

agent-node 从 config.json 读取所有配置（包括 channels 数组）。`channels` 解释规则：
- `"server:commhub"` → Claude Code channel 插件（仅 claude-code-cli）
- `"telegram"` → 读 `<node-dir>/channels/telegram/` 启动 Telegram polling

## 废弃项

| 旧命令/字段 | 替代 | 兼容期 |
|-------------|------|--------|
| `anet init profile` | `anet create` | 2 个版本 |
| `runtime: "agent-sdk"` | `codex-sdk` / `claude-agent-sdk` | 2 个版本 |
| `resume` / `resumeAlias` / `sessionId` | `session` | 2 个版本 |
| `.anet/profiles/<alias>.json` | `.anet/nodes/<id>/config.json` | 2 个版本 |

## 决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | channel node-local | 避免两个 node 误用同一个 bot token |
| 2 | agent-node 支持 `--config` + `--alias` | `--config` 优先，`--alias` 自动找 |
| 3 | session 字段统一叫 `session` | 收敛 3 个旧字段名 |
| 4 | anet start 传 `--config` + `--alias` | 减少 anet 和 agent-node 耦合 |
| 5 | `anet resume --session` 自动 create | 快捷迁移路径 |
| 6 | runtime: claude-code-cli / codex-sdk / claude-agent-sdk | 直接对应底层包名 |

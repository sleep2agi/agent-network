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

`anet create` 不传参数时进入完全交互式流程：

```
$ anet create

? Node name: 小明

? Select runtime:
  1) claude-code-cli    Claude Code CLI（需要 Pro 订阅）
  2) codex-sdk          Codex SDK（GPT-5.4，需要 Codex 登录）
  3) claude-agent-sdk   Claude Agent SDK（支持 MiniMax/书生等）
→ 3

? Select model:
  1) MiniMax-M2.7
  2) intern-s1-pro
  3) claude-sonnet-4-6
  4) custom
→ 1

? ANTHROPIC_AUTH_TOKEN: sk-xxx

? Add Telegram channel? (y/n): y
? Telegram Bot Token: 123:ABC
? Allow User ID [7612221352]: (回车)

✅ Created node "小明" (claude-agent-sdk, MiniMax-M2.7)
✅ Telegram channel added
⚠ dangerouslySkipPermissions and teammateMode enabled by default.

Start: anet start 小明
```

**按 runtime 不同的交互差异：**

- `claude-agent-sdk`：问模型（预填 URL）→ 问 token
- `codex-sdk`：问模型（gpt-5.4/o3/custom）→ 提示需要 `codex auth login`
- `claude-code-cli`：不问模型 → 提示需要 Pro 订阅 + `claude auth login`

**传了参数则跳过对应交互：**

```bash
anet create 小明 --runtime codex-sdk --model gpt-5.4   # 全跳过
anet create 小明 --runtime codex-sdk                     # 只问 model
anet create                                              # 全部交互
```

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

## 追加需求：版本展示和兼容性检测

### 目标

1. `anet -v` 不再只显示 anet 自身版本，要一次性显示 anet 生态里会被启动/依赖的 CLI 包。
2. `anet start` 在启动 agent-node 前做版本兼容性检查；发现不兼容时停止启动，并提示用户运行 `anet upgrade`。

### `anet -v` 输出

期望格式：

```bash
anet v1.0.3
agent-node v1.0.2 (global)
commhub-server v0.4.3 (global)
claude CLI v2.1.39
codex CLI not installed
```

探测不到时使用 `not installed`：

```bash
agent-node not installed
commhub-server not installed
claude CLI not installed
codex CLI not installed
```

### 包名和探测来源

| 展示名 | 包/命令 | 优先探测 | 备用探测 | 位置标记 |
|--------|---------|----------|----------|----------|
| `anet` | `@sleep2agi/agent-network` | 当前 CLI 自带 package.json | - | 不显示 |
| `agent-node` | `@sleep2agi/agent-node` / `agent-node` | `agent-node --version` | `npm ls -g @sleep2agi/agent-node --depth=0 --json` | `(global)` |
| `commhub-server` | `@sleep2agi/commhub-server` / `commhub-server` | `commhub-server --version` | `npm ls -g @sleep2agi/commhub-server --depth=0 --json` | `(global)` |
| `claude CLI` | `claude` | `claude --version` | `command -v claude` 仅判断安装 | 不显示 |
| `codex CLI` | `codex` | `codex --version` | `command -v codex` 仅判断安装 | 不显示 |

说明：

- P0 只要求显示全局安装状态；当前 `anet start` 仍用 `npx @sleep2agi/agent-node` 启动。
- 如果命令可执行但无法解析版本，输出 `installed (version unknown)`，不要伪造成 `not installed`。
- 版本解析统一接受 `1.0.2` / `v1.0.2` / `agent-node v1.0.2` 这几类输出。
- `upgradeCommand()` 结尾只保留 `anet -v`，不要再单独打印一遍 agent-node。

### `anet start` 兼容性检查

只在 `runtime === "codex-sdk" || runtime === "claude-agent-sdk"` 时检查 agent-node。

检查点放在 `launchAgent()` 里：`checkRuntimeDependency(runtime, "start")` 之后、`spawn("npx", ...)` 之前。

兼容矩阵：

| 组件 | 约束 |
|------|------|
| `anet >= 1.0.0` | 需要 `agent-node >= 1.0.0` |
| `agent-node >= 1.0.0` | 需要 `commhub-server >= 0.4.0` |

失败提示：

```text
[anet] Incompatible package versions.
[anet] anet v1.0.3 requires agent-node >= 1.0.0, but found agent-node v0.7.0.
[anet] Run: anet upgrade
```

缺失提示：

```text
[anet] agent-node is not installed or cannot report a version.
[anet] Run: anet upgrade
```

commhub-server 检查说明：

- `anet start` 本地只检查“可探测到的 commhub-server 版本”。
- 如果本机未安装 commhub-server，不阻止 agent-node 启动，因为用户可能连接远端 CommHub。
- 如果探测到 `commhub-server < 0.4.0`，打印 warning；不在 P0 中硬失败，避免误伤远端部署：

```text
[anet] Warning: local commhub-server v0.3.9 is older than recommended >= 0.4.0.
[anet] If this machine hosts CommHub, run: anet upgrade
```

### 实现拆分

新增小 helper，供 `anet -v`、`anet start`、`anet upgrade` 复用：

| helper | 职责 |
|--------|------|
| `parseSemver(text)` | 从 CLI/npm 输出中提取 `{ major, minor, patch }` |
| `compareSemver(a, b)` | 返回 -1/0/1，只比较 major/minor/patch |
| `detectCommandVersion(command)` | 执行 `<command> --version`，返回版本/unknown/not-installed |
| `detectGlobalNpmPackage(pkg)` | 读取全局 npm 安装版本，返回版本/unknown/not-installed |
| `detectInstalledPackages()` | 汇总 anet / agent-node / commhub-server / claude / codex |
| `printVersionReport()` | 负责 `anet -v` 多行输出 |
| `assertStartCompatibility(runtime)` | 负责 `anet start` 兼容性门禁 |

### 决策

| # | 决策 | 理由 |
|---|------|------|
| 15 | `anet -v` 升级为版本诊断 | 用户不必分别执行 npm/claude/codex 命令排查 |
| 16 | `anet start` 对 agent-node 版本硬失败 | SDK runtime 直接依赖 agent-node，低版本可能不认识新 config/session 语义 |
| 17 | 本地 commhub-server 低版本先 warning | CommHub 可能部署在远端；本地包版本不一定代表运行中的服务 |
| 18 | 缺 agent-node 时提示 `anet upgrade` | upgrade 已覆盖 anet + agent-node + npx cache，用户入口统一 |

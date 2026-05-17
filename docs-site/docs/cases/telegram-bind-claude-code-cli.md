# Telegram 接入已存在节点（claude-code-cli runtime）— 详细操作手册

把一个跑着的 `claude-code-cli` 节点接进 Telegram —— 你在 Telegram 里 DM bot，bot 把消息转给 Claude Code 处理，Claude Code 回复（包括跑 bash / 改文件 / 调 MCP 工具的完整能力）。本手册给**每一步的预期输出 + 落盘文件 + 错误诊断**，照着敲就能跑通。

> [!IMPORTANT]
> **当前支持范围**：仅 `claude-code-cli` runtime。`claude-agent-sdk` / `codex-sdk` 的 Telegram bridge 在 [RFC-002 Channel-Bind CLI](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-002-channel-bind-cli.md) Phase 1 排期 —— **v0.9.x / v0.10.x scope chain 都未动**（grep `telegram-bridge` 在 agent-node/src 0 命中），排到 v0.11+ / 未排期。

| 信息 | 值 |
|---|---|
| 预计时间 | 5-10 分钟（含 plugin 首次安装）|
| 前置 | 已有 `claude-code-cli` runtime 的节点（hello-world demo 用过 `claude-agent-sdk`，本案例 runtime 不同；如果没节点先看[上手指南](/guide/getting-started)）|
| anet 版本 | ≥ 2.1.5（latest）或 ≥ 2.1.7-preview.0（preview）|
| Claude Code CLI 版本 | ≥ 2.x（需支持 `--channels plugin:xxx@yyy` 语法）|

---

## 总体流程

```
你 →─→  @BotFather (Telegram)  →─→  bot token
       @userinfobot (Telegram)  →─→  你的 user id
                                       ↓
        claude plugin install telegram@claude-plugins-official
        anet channel add telegram <node> --bot-token <tok> --allow <user-id>
        anet node stop <node> && anet node start <node>
                                       ↓
        Telegram DM ─→ bot polling ─→ Claude Code ─→ bot reply
```

---

## 步骤 0 — 确认 Claude Code Telegram plugin 已安装

anet 把 Telegram 接入 claude-code-cli 节点的实现 = 启动 `claude` 时传 `--channels plugin:telegram@claude-plugins-official`，让 Claude Code 自身的 channel plugin 系统接管。**plugin 必须先在你的 `claude` CLI 里装一次**（user scope，所有项目共享）。

### 0.1 检查是否已装

```bash
claude plugin list | grep telegram
```

**已装**：

```
telegram@claude-plugins-official  user   /home/<user>/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6  installed: 2026-03-22
```

跳到[步骤 1](#步骤-1-—-拿-bot-token--telegram-user-id)。

**未装**（输出为空 / `plugin not found`）：继续 0.2。

### 0.2 安装 plugin

```bash
claude plugin install telegram@claude-plugins-official
```

预期输出：

```
Fetching from marketplace claude-plugins-official...
Resolving telegram@latest → 0.0.6
Downloading ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/...
Verifying...
✓ installed: telegram@claude-plugins-official (0.0.6, user scope)
```

落盘文件：

```
~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/
├── plugin.json       # 元数据
├── server.ts         # MCP server 实现（Telegram bot polling 主逻辑）
├── ACCESS.md         # 权限模型说明
├── README.md
├── package.json
├── bun.lock
├── node_modules/     # 依赖
└── skills/           # MCP skills 定义
```

### 0.3 verify 安装成功

```bash
claude plugin details telegram@claude-plugins-official
```

输出含：

```
Plugin: telegram@claude-plugins-official
Version: 0.0.6
Scope: user
Install path: ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6
Components: 1 MCP server (channel), N skills
```

**plugin 装好了**。这一步是一次性的 — 一台机器装一次，所有 anet 节点共享。

> [!TIP]
> Plugin 更新：`claude plugin update telegram@claude-plugins-official`。anet 不绑死特定版本，跟随 claude CLI 自己的 update 节奏。

---

## 步骤 1 — 拿 Bot Token + Telegram User ID

需要两样东西：

### 1.1 创建 Bot（`@BotFather`）

打开 Telegram 搜 [@BotFather](https://t.me/BotFather)（蓝色 V verified）：

```
You:        /newbot
BotFather:  Alright, a new bot. How are we going to call it?
            Please choose a name for your bot.
You:        anet-test-bot          ← 显示名
BotFather:  Good. Now let's choose a username for your bot.
            It must end in `bot`.
You:        anet_test_bot          ← 唯一 username
BotFather:  Done! Congratulations on your new bot.
            ...
            Use this token to access the HTTP API:
            123456789:AAEhBP_XYZxyz...   ← ★ 这是 bot token
            ...
```

复制 token（格式 `<bot-id>:<secret>`）。

> [!WARNING]
> **Token 私密**：相当于 bot 的密码。**不要**：
> - 贴到 GitHub issue / PR
> - 截图发群
> - 写到本机 git-tracked 文件
> - 上传到任何公开服务
>
> 如果 token 不小心泄露，立即在 BotFather 里 `/token` → 选 bot → `Revoke current token` 撤掉。

### 1.2 拿你的 Telegram 数字 User ID（`@userinfobot`）

打开 [@userinfobot](https://t.me/userinfobot)：

```
You:           /start
userinfobot:   👋 Hi User Name!
               🆔 Id: 123456789          ← ★ 这是你的数字 user id
               👤 Username: @your_handle
               🌐 Language: zh-hans
```

复制数字 ID（**不要复制 `@username`** — anet 的白名单认数字 ID）。

> [!NOTE]
> 数字 user id 是你在 Telegram 全局唯一的不可变 ID。即使你改 username / 显示名 它不变。

---

## 步骤 2 — 确认目标节点 runtime

```bash
anet node ls
```

预期输出（节选）：

```
Node Status:

  ALIAS         RUNTIME              MODEL                  STATUS   SSE   LAST SEEN
  my-bot        claude-code-cli      claude-sonnet-4-6      idle     ✓     2s ago
  translator    claude-agent-sdk     MiniMax-M2.7           idle     ✓     5s ago
  coder         codex-sdk            gpt-5-codex            offline  ✗     2h ago
```

找到要绑 Telegram 的节点，确认 `RUNTIME` 列**是 `claude-code-cli`**。

| 节点 runtime | 本案例适用？ |
|---|---|
| `claude-code-cli` | ✅ 适用 |
| `claude-agent-sdk` | ❌ 等 v0.11+ / 未排期（RFC-002 P1，v0.9.x / v0.10.x 都未动） |
| `codex-sdk` | ❌ 等 v0.11+ / 未排期（RFC-002 P2，v0.9.x / v0.10.x 都未动） |

如果你的节点是 SDK runtime 想接 Telegram，**暂时**用 [`demos/codex-telegram-squad`](https://github.com/sleep2agi/agent-network/tree/main/demos/codex-telegram-squad)（Docker Compose 起一整套）或等 RFC-002 实施（v0.10+ / 未排期）。

如果还没节点，先看 [Hello World](/cases/hello-world)，注意建节点时 runtime 选 `claude-code-cli`：

```bash
anet node create my-bot --runtime claude-code-cli
```

---

## 步骤 3 — 绑定 Telegram channel

```bash
anet channel add telegram my-bot \
  --bot-token 123456789:AAEhBP_XYZxyz... \
  --allow 123456789
```

参数完整说明：

| 参数 | 必需 | 说明 | 例 |
|---|---|---|---|
| `<type>` | ✓ | 第一个位置参数，目前只支持 `telegram` | `telegram` |
| `<node-id>` | ✓ | 第二个位置参数。支持 `node_name`（人类可读）或 `node_id`（`n_a1b2c3d4`）| `my-bot` |
| `--bot-token <tok>` | ✓ | Telegram bot token（@BotFather 给的）| `123456789:AAEhBP...` |
| `--allow <user-id>` | ✓ | 你的 Telegram 数字 user id（access.json 白名单首项）| `123456789` |

> [!TIP]
> **交互式**：所有 flag 不传时命令会一项一项问你，更适合敏感 token 不出现在 shell history：
>
> ```bash
> anet channel add telegram my-bot
> # → Telegram Bot Token: <隐藏输入>
> # → Allow User ID (发 @userinfobot 获取数字ID): <输入>
> ```

### 3.1 预期输出

```
Telegram Bot Token: 123456789:AAEhBP_XYZxyz...
Allow User ID (发 @userinfobot 获取数字ID): 123456789

✅ telegram channel added to "my-bot"
   /home/<user>/.anet/nodes/n_abc12345/channels/telegram/
   config.json updated
```

### 3.2 错误情况

| 错误信息 | 原因 | 解决 |
|---|---|---|
| `Node "my-bot" not found. Create it first: anet node create my-bot ...` | 节点 ID/名字打错或节点不存在 | `anet node ls` 查正确名字 |
| `P0 only supports telegram channels. Unsupported type: <X>` | 第一个位置参数不是 `telegram` | 改为 `telegram` |
| `Error: bot-token and allow required` | 交互式输入时空回车 | 重跑命令认真输入 |
| `EACCES: permission denied, mkdir ...` | `.anet/nodes/` 目录权限不对 | `chown -R $USER .anet` |

---

## 步骤 4 — 验证配置落盘

### 4.1 用 `anet channel ls` 看 channel 列表

```bash
anet channel ls my-bot
```

预期输出：

```
Node Channels:

  n_abc12345 (my-bot)   telegram     allow: 123456789
```

### 4.2 直接看落盘文件

```bash
ls -la ~/.anet/nodes/n_abc12345/channels/telegram/
```

```
total 16
drwxr-xr-x 3 user user 4096 May 12 10:00 .
drwxr-xr-x 3 user user 4096 May 12 10:00 ..
-rw-------  1 user user   52 May 12 10:00 .env             ← chmod 600 ✓
-rw-r--r--  1 user user  142 May 12 10:00 access.json
drwxr-xr-x 2 user user 4096 May 12 10:00 inbox            ← plugin 用来缓存消息
```

文件内容：

```bash
cat ~/.anet/nodes/n_abc12345/channels/telegram/.env
```

```
TELEGRAM_BOT_TOKEN=123456789:AAEhBP_XYZxyz...
```

```bash
cat ~/.anet/nodes/n_abc12345/channels/telegram/access.json | python3 -m json.tool
```

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": [
    "123456789"
  ],
  "groups": {},
  "pending": {}
}
```

**access.json 字段语义**：

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `dmPolicy` | `"allowlist"` / `"deny-all"` / `"allow-all"` | `"allowlist"` | DM（私聊）准入策略。`allowlist` = 只允许 `allowFrom` 名单 |
| `allowFrom` | `string[]`（数字 user id 列表）| `[<--allow 传的 id>]` | 私聊白名单 |
| `groups` | `{ <chat_id>: "active" \| "passive" \| "deny" }` | `{}` | 群聊规则。空对象 = 默认拒所有群聊 |
| `pending` | `object` | `{}` | plugin 内部 state，无需手动改 |

> `anet channel add` 只写默认值 `{ dmPolicy: "allowlist", allowFrom: [<id>], groups: {}, pending: {} }`（verify [`agent-network/bin/cli.ts:1060-1065`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1060)）。`dmPolicy` / `groups` 的其他取值（`deny-all` / `allow-all` / `active` / `passive` / `deny`）由 channel 插件（`.anet/node-server.js` 起的 telegram channel）运行时解释 —— 手动改 `access.json` 后重启 node 生效。

### 4.3 看节点 config.json 里 `channels` 数组

```bash
cat ~/.anet/nodes/n_abc12345/config.json | python3 -m json.tool | grep -A 5 channels
```

应该包含：

```json
    "channels": [
        "server:commhub",
        "telegram"
    ],
```

> [!NOTE]
> `"server:commhub"` 是 commhub channel（agent 跟 hub 的通信通道，default 自带），跟 telegram 并列。两条 channel 在同一个 claude 进程内并行工作。

---

## 步骤 5 — 重启节点让 Telegram channel 生效

> [!WARNING]
> 当前实现**不支持热注入** channel。节点必须 stop + start 才能让 telegram 生效。这是 RFC-002 边界 case 之一，v0.9.x / v0.10.x 都未动，排到 v0.11+ / 未排期优化。

### 5.1 停旧进程

```bash
anet node stop my-bot
```

预期输出：

```
[anet] Stopping my-bot...
[anet] Sent SIGTERM to PID 12345
[anet] my-bot stopped
```

### 5.2 启新进程（带 telegram channel）

```bash
anet node start my-bot
```

预期输出（关键行）：

```
[anet] Starting my-bot (runtime=claude-code-cli)...
[anet] Spawning: claude --dangerously-skip-permissions \
                       --dangerously-load-development-channels server:commhub \
                       --channels plugin:telegram@claude-plugins-official \
                       --teammate-mode in-process \
                       --resume <uuid>  (or --session-id <uuid>) \
                       -n my-bot
[anet] env: COMMHUB_URL, COMMHUB_TOKEN, TELEGRAM_STATE_DIR=/home/<user>/.anet/nodes/n_abc12345/channels/telegram, ...
[anet] Claude Code session pinned: a1b2c3d4...
[my-bot]  SSE connected
[my-bot]  Telegram plugin: polling started (bot @anet_test_bot, allow 123456789)
```

**关键 verify 项**：

1. ✅ claude 命令行带 `--channels plugin:telegram@claude-plugins-official`
2. ✅ 环境变量 `TELEGRAM_STATE_DIR` 指向 channels/telegram 目录
3. ✅ Telegram plugin 启动 polling（具体日志格式可能因 plugin 版本略有差异）

### 5.3 错误诊断

| 错误 | 原因 | 解决 |
|---|---|---|
| `claude: command not found` | Claude Code CLI 没装到 PATH | `npm i -g @anthropic-ai/claude-code` |
| `plugin telegram@claude-plugins-official not found` | 跳了步骤 0 没装 plugin | 回去跑 `claude plugin install telegram@claude-plugins-official` |
| `TELEGRAM_BOT_TOKEN env var missing` | `.env` 文件没生成 / 没读到 | `ls -la ~/.anet/nodes/<node>/channels/telegram/.env`；如缺则重跑 `anet channel add telegram` |
| `Telegram getUpdates: 401 Unauthorized` | bot token 错误 / 被 revoke | 回 BotFather `/token` 重新拿，重跑 `anet channel add telegram` 覆盖 |
| `Telegram getUpdates: 409 Conflict` | 同一个 bot token 在另一个进程也在 polling | 停别处用该 bot 的进程；一个 bot token 只能一处 polling |

---

## 步骤 6 — 在 Telegram 里 DM bot 试

打开 Telegram，搜你刚创建的 bot username（`@anet_test_bot`），点 `Start` → 输入消息：

```
You:    数一下 1 到 10
Bot:    1, 2, 3, 4, 5, 6, 7, 8, 9, 10
        (具体回复内容由 Claude Code 处理结果决定)
```

后台 Claude Code 处理流程：

1. Telegram plugin 收到 update.message
2. 校验 `from.id == 123456789`（白名单）通过
3. 把 message content 喂给 claude 主循环
4. Claude Code 处理（可能调工具、写文件、跑 bash）
5. 处理完通过 plugin 调 Telegram `sendMessage` 回复

### 6.1 没回复怎么办

按概率从高到低排查：

**1. 你不在白名单**

用别的 Telegram 账号发就被静默 ignore。回 `@userinfobot` 确认你当前用的 ID，比对 access.json:

```bash
cat ~/.anet/nodes/<node-id>/channels/telegram/access.json | python3 -m json.tool
```

```json
{
  "allowFrom": ["123456789"]   ← 必须含你当前用的 ID
}
```

不匹配就改：

```bash
anet channel add telegram <node-id> \
  --bot-token <same-token> \
  --allow <your-correct-id>
# 重启节点
anet node stop <node-id> && anet node start <node-id>
```

**2. 节点 offline**

```bash
anet node ls | grep <node-id>
```

`STATUS` 不是 `idle` / `working` 就 offline。看日志找原因：

```bash
anet logs <node-id> | tail -30
```

**3. Plugin polling 卡住**

```bash
anet logs <node-id> | grep -i "telegram\|polling\|getUpdates"
```

正常应每 N 秒一条 polling log。如果一直没动静，可能 plugin 自己有 bug — `claude plugin update telegram@claude-plugins-official` 升级再试。

**4. Bot token 已被你/别人 revoke**

```bash
curl "https://api.telegram.org/bot<your-token>/getMe"
```

正常返回 bot info JSON；返回 `{"ok": false, "error_code": 401}` 则 token 失效。回 BotFather revoke + 重新拿。

**5. Bot 在另一个进程也在 polling**

Telegram 限制 1 bot 1 polling 进程，否则两个进程**互抢**消息（每条消息只到其中一个）。检查：

```bash
ps aux | grep "telegram" | grep -v grep
```

只该有一个 anet 启动的 claude 进程占该 bot。其他要停。

---

## 高级用法

### A. 接群聊（默认拒绝）

`access.json` 的 `groups: {}` 默认对所有群聊拒绝。要接群：

```bash
# 拿群 chat_id（在群里 @userinfobot 然后转发任意一条群消息给它，它会回 chat id）
# 假设拿到 chat_id = -1001234567890

# 手动编辑 access.json
python3 -c "
import json
p = '/home/<user>/.anet/nodes/<node-id>/channels/telegram/access.json'
d = json.load(open(p))
d['groups']['-1001234567890'] = 'active'
json.dump(d, open(p, 'w'), indent=2)
print('done')
"

# 重启节点
anet node stop <node-id> && anet node start <node-id>
```

`groups` 字段值：

| 值 | 行为 |
|---|---|
| `"active"` | bot 主动响应该群所有 @提及 |
| `"passive"` | bot 只对 `/command` 响应 |
| `"deny"` | 拒绝（默认行为，但显式标也行）|

### B. 多人白名单

team 共用一个 bot：

```bash
# 第一个人加进 allow
anet channel add telegram <node-id> --bot-token <tok> --allow 123456789

# 再加第二个人 — 直接编 access.json，命令不支持多个 allow
# 把 987654321 替换成对方的 Telegram numeric ID（让对方在 @userinfobot 跑 /start 获取）
python3 -c "
import json
p = '/home/<user>/.anet/nodes/<node-id>/channels/telegram/access.json'
d = json.load(open(p))
SECOND_USER_ID = '987654321'   # ← 替换成对方的 Telegram numeric ID
if SECOND_USER_ID not in d['allowFrom']:
    d['allowFrom'].append(SECOND_USER_ID)
json.dump(d, open(p, 'w'), indent=2)
"

anet node stop <node-id> && anet node start <node-id>
```

### C. 切换 bot token

```bash
# 直接重跑 add 命令覆盖
anet channel add telegram <node-id> \
  --bot-token <new-token> \
  --allow <user-id>
# 重启
anet node stop <node-id> && anet node start <node-id>
```

记得回 BotFather 把旧 bot token revoke（避免泄露还能用）。

### D. 解绑 Telegram

```bash
# 1. 从 config.json 的 channels 数组去掉 "telegram"
python3 -c "
import json
p = '/home/<user>/.anet/nodes/<node-id>/config.json'
d = json.load(open(p))
d['channels'] = [c for c in d['channels'] if c != 'telegram']
json.dump(d, open(p, 'w'), indent=2)
"

# 2. 删 channels/telegram 目录
rm -rf /home/<user>/.anet/nodes/<node-id>/channels/telegram

# 3. 重启
anet node stop <node-id> && anet node start <node-id>
```

### E. 多个 node 同一个 bot（**不推荐**）

Telegram 限制 1 bot 1 polling 进程。多个 anet node 用同一 bot token 会**互抢消息**，不可预期。

**正确方式**：每个 node 用独立 bot（@BotFather 可以建多个 bot）。

### F. 改密码后 telegram channel 受影响吗？

**不受影响**。详见 [issue #17 详细答复](https://github.com/sleep2agi/agent-network/issues/17#issuecomment-4428789875)。改密码只 revoke `utok_`，node 用的 `ntok_` 不变，已建的 SSE 长连接不断，Telegram plugin polling 继续跑。

---

## 安全考虑

### Token 存储

- `.env` 文件 `chmod 600`（只有当前 user 能读）
- `.anet/` 在仓库 `.gitignore` 里（不进 git）
- Bot token **不上传 hub**（hub 不持有，纯 agent-local）

### Access 白名单强制

- 不在 `allowFrom` 的 Telegram user 发 DM → **静默 ignore**（不回错误、不进 audit log）
- 这是设计取舍：不回错误避免暴露 bot 是 anet 跑的（防探测）

### Bot 权限范围

- Claude Code 是用 `--dangerously-skip-permissions` 启动的 — 工具调用不会再问你确认
- 任何在 `allowFrom` 里的用户都能让 bot 跑**任意 bash 命令 / 改任意文件**（claude 有 Bash / Write 工具）
- **生产部署**：
  - 用一次性 / 独立工作目录跑这个 node（不要在 `$HOME` 跑）
  - `allowFrom` 严格只放可信用户
  - 考虑用 `--tools` 限定 Claude Code 工具集（去掉 Bash / Write）

```bash
# 创节点时限制工具
anet node create my-bot --runtime claude-code-cli \
  --tools "Read,Glob,Grep,WebFetch"   # 只读 + 联网，无 Bash/Write/Edit
```

---

## 跟 `demos/codex-telegram-squad/` 区别

| | `codex-telegram-squad` demo | 本案例 |
|---|---|---|
| 部署 | Docker Compose 起 hub + 多 worker + telegram bot 全套 | 已有 anet 装好后加 Telegram 到现有 node |
| Runtime | 多个 `codex-sdk` worker + 1 个 `claude-agent-sdk` commander | 单 `claude-code-cli` node |
| Telegram 接入层 | Demo 内部代码（agent-node:codex 跑的 commander 实现 bot bridge）| Claude Code 官方 plugin (`telegram@claude-plugins-official`) |
| 适合场景 | 多 agent 协作 + Telegram 指挥（产品演示）| 单 agent 加 Telegram 通道（日常使用）|

---

## 其他 runtime 进展

| Runtime | 当前 | 状态 |
|---|---|---|
| `claude-code-cli` | ✅ 本案例 | 已 work |
| `claude-agent-sdk` | ❌ | [RFC-002](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-002-channel-bind-cli.md) Phase 1 — agent-node 加 `telegram-bridge` worker，v0.9.x / v0.10.x 都未动，排到 v0.11+ / 未排期 |
| `codex-sdk` | ❌ | RFC-002 Phase 2 — 复用 Phase 1 bridge |

为什么 SDK 不能复用 claude-code-cli 路径：claude-code-cli 走的是 Claude Code CLI 子进程，CLI 自带 plugin 机制；SDK runtime 是 anet 直接调 `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk`，没有 plugin 钩子，得在 anet 这边写 telegram bridge。RFC-002 给了完整设计。

---

## 故障排查速查表

| 症状 | 检查 | 解决 |
|---|---|---|
| `anet channel add` 报 `Node not found` | `anet node ls` | 用正确 node id/name |
| `anet node start` 报 `plugin not found` | `claude plugin list` | 跑 0.2 安装 plugin |
| `anet node start` 后 `claude: command not found` | `which claude` | `npm i -g @anthropic-ai/claude-code` |
| Telegram 发消息无响应 | `anet node ls` 看 STATUS | offline 看 logs 找原因 |
| 收到 `409 Conflict` | `ps aux \| grep claude` | 停别的占用该 bot 的进程 |
| 收到 `401 Unauthorized` | `curl api.telegram.org/bot<tok>/getMe` | bot token 失效，BotFather 重新拿 |
| 不在白名单的人发能 ignore，但**我**自己发也 ignore | 比对 `access.json.allowFrom` vs `@userinfobot` 给的 ID | 改 access.json 加正确 ID 重启 |

---

## 下一步

- [Channel 概念](/guide/channels) — Channel 整体设计
- [Agent Node](/guide/agent-node) — 节点配置完整字段
- [辩论赛 Demo](/cases/debate) — 6 agent 内置编排（不接 Telegram）
- [军团编队](/cases/telegram-squad) — Docker Compose 完整 Telegram squad
- [RFC-002 Channel-Bind CLI](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-002-channel-bind-cli.md) — SDK runtime 的 Telegram bridge 设计（v0.9.x / v0.10.x 都未动，排到 v0.11+ / 未排期）
- [issue #14](https://github.com/sleep2agi/agent-network/issues/14) — 本案例追踪 issue

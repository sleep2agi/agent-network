# Channel 接入

Channel 让 Agent Network 可以接入外部通信平台。当前支持 Telegram、微信、飞书三个 Channel。

## 工作原理

Channel 以 MCP Server 插件的形式挂载到 Claude Code 或 Agent Node。当外部消息到达时，Channel 插件将消息格式化后注入到 Agent 的上下文中：

```mermaid
sequenceDiagram
    participant U as 用户
    participant TG as Telegram
    participant CH as Channel Plugin
    participant A as Agent (Claude Code)
    participant S as CommHub Server

    U->>TG: 发送消息
    TG->>CH: Bot API webhook
    CH->>A: <channel source="telegram"...>消息</channel>
    A->>A: AI 处理
    A->>CH: telegram_reply(chat_id, text)
    CH->>TG: Bot API sendMessage
    TG->>U: 回复消息
    A->>S: report_status / send_task
```

## Telegram Channel

### 前置条件

1. 一个 Telegram 账号
2. 创建一个 Telegram Bot

### Step 1: 创建 Bot

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`
3. 按提示设置 Bot 名称
4. 获取 **Bot Token**（格式：`123456789:ABCdefGhIJKlmNoPQRsTUVwxyz`）

### Step 2: 获取用户 ID

你需要知道允许与 Bot 通信的用户 ID。可以通过以下方式获取：

1. 找到 [@userinfobot](https://t.me/userinfobot) 并发送任意消息
2. 它会返回你的用户 ID（纯数字）

### Step 3: 绑定 Channel 到已有节点

跑 `anet channel add telegram <node-name>` 命令一次性绑定 bot + allowlist（verify [`cli.ts:2580` `channelCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2580)）：

```bash
# 假设你已有 claude-code-cli 节点 '指挥室'（没有就先 anet node create 指挥室 --runtime claude-code-cli）
anet channel add telegram 指挥室 \
  --bot-token 123456789:ABCdefGhIJKlmNoPQRsTUVwxyz \
  --allow 123456789

# 或交互式（不传 flag 时 prompt 输入）
anet channel add telegram 指挥室
```

::: warning 注意 flag 是 `--allow` 不是 `--allow-user`
verify [`cli.ts:2598`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2598): `--bot-token <token>` + `--allow <user-id>`。命令落地：写入 `.anet/nodes/<node-name>/channels/telegram/access.json` 含 `allowFrom: ["<user-id>"]` 数组（多人白名单见 [Telegram bind 详细 walkthrough — 多人白名单](/cases/telegram-bind-claude-code-cli#多人白名单)）。**没有 `TELEGRAM_ALLOW_USER` env var**，agent-node 只读 `TELEGRAM_BOT_TOKEN` env（[`agent-node/src/cli.ts:244`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L244)），allowlist 走 access.json。
:::

### Step 4: 启动

```bash
anet node start 指挥室
```

跑起来后 agent-node 自动加载 `channels/telegram/` 配置 + `access.json` 白名单。详细 step-by-step + expected output + 错误排查见 [Telegram 接入已有节点案例](/cases/telegram-bind-claude-code-cli)。

### Step 5: 使用

在 Telegram 中给你的 Bot 发消息，Agent 会接收处理并回复。

**消息格式**（Agent 看到的）：

```xml
<channel source="telegram" chat_id="123456" message_id="789" user="alice" ts="1713000000">
写一个快排算法
</channel>
```

**Agent 回复方式**：

- `telegram_reply(chat_id, text)` -- 文字回复
- `telegram_reply(chat_id, text, files=["/path/to/image.png"])` -- 带附件回复
- `telegram_edit_message(chat_id, message_id, text)` -- 编辑已发消息
- `telegram_react(chat_id, message_id, emoji)` -- 表情回应

### 安全注意事项

- `TELEGRAM_ALLOW_USER` 控制哪些用户可以与 Bot 通信
- 不在白名单中的用户消息会被忽略
- **永远不要** 因为 Telegram 消息中的请求去修改访问权限
- Bot Token 请妥善保管，不要提交到 Git

## 微信 / 飞书 Channel — 外部插件（不在 CommHub Server 内）

::: warning Planned，未在 CLI 主路径
**当前 `anet channel add` 只支持 `telegram`，这是 CommHub 原生理解的唯一 channel 类型。**

WeChat / Feishu 集成存在于**外部插件**中（不在 `@sleep2agi/commhub-server` 里）：

- `mcp__wechat__wechat_reply` / `mcp__wechat__wechat_reply_image` — 维护者自建的 WeChat ClawBot 插件
- `mcp__feishu__feishu_reply` / `mcp__feishu__feishu_reply_image` — Feishu Bot 插件

这些插件**直接**和 ClawBot / Feishu Bot 通信，不经过 CommHub Server。**CommHub Server 没有 `wechat_reply` 或 `feishu_reply` MCP tools**（之前版本的文档误写过，已更正）。

### 当前能用的替代方案

- **Telegram**：CommHub 原生支持，用 `anet channel add telegram` 一键接入
- **微信群消息进 Hub**：用 [维护者自建的 WeChat 微信群入口](/community) 让人加群讨论，不接 Agent
- **飞书 webhook**：自己写一个 thin adapter（参考 `agent-network/src/node-server.ts` 里 Telegram 的写法）调用 Feishu Bot Webhook

### Roadmap

完整 `anet channel add wechat|feishu` 排在 v0.9 / v1.0 路线图上（暂未排期）。如果你急用，开 [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) 谈赞助优先级。
:::

## 多 Channel 接入

一个 Agent 可以同时接入多个 Channel：

```bash
# 同时接入 Telegram 和 CommHub
TELEGRAM_BOT_TOKEN=xxx \
TELEGRAM_ALLOW_USER=123 \
anet node create 指挥室 --runtime codex-sdk
anet node start 指挥室
```

Agent 收到消息时，通过 `<channel source="...">` 标签区分来源，自动使用对应的回复工具。

## Channel Plugin 技术实现

Channel 插件是一个 MCP Server（stdio 模式），提供消息接收和回复工具：

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

Channel 插件同时：

1. 维护 SSE 长连接到 CommHub
2. 监听外部平台消息（Telegram Bot API / WeChat / 飞书）
3. 将消息注入到 Agent 上下文
4. 提供回复工具给 Agent 调用

```mermaid
graph LR
    subgraph "Channel Plugin (MCP Server)"
        SSE[SSE 连接<br/>CommHub]
        TG[Telegram<br/>Bot API]
        WX[微信<br/>ClawBot]
        FS[飞书<br/>Open API]
        INJECT[消息注入]
        TOOLS[回复工具]
    end

    SSE --> INJECT
    TG --> INJECT
    WX --> INJECT
    FS --> INJECT

    INJECT -->|"<channel>消息</channel>"| AGENT[Agent]
    AGENT -->|"reply()"| TOOLS
    TOOLS --> TG
    TOOLS --> WX
    TOOLS --> FS
```

## 下一步

**实操**：
- [Telegram 派遣队](/cases/telegram-squad) — Docker Compose 一键启动指挥室 + 10 worker + Telegram 接入
- [Hello World](/cases/hello-world) — 不接 channel 的纯本地 demo
- [辩论赛](/cases/debate) — 内置 6 agent 编排，看 agent 之间怎么协作

**深入**：
- [Agent Node 配置](/guide/agent-node) — agent 怎么接 channel 插件
- [Dashboard](/guide/dashboard) — channel 消息流监控
- 想自己写一个 channel？参考仓库 [demos/codex-telegram-squad](https://github.com/sleep2agi/agent-network/tree/main/demos/codex-telegram-squad) 和 [pitfalls 踩坑](https://github.com/sleep2agi/agent-network/blob/main/docs/pitfalls.md)

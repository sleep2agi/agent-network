# Channel Integration

Channels enable Agent Network to connect with external communication platforms. Currently supported: Telegram, WeChat, and Feishu.

## How It Works

Channels are mounted as MCP Server plugins on Claude Code or Agent Node. When an external message arrives, the channel plugin formats it and injects it into the agent's context:

```mermaid
sequenceDiagram
    participant U as User
    participant TG as Telegram
    participant CH as Channel Plugin
    participant A as Agent (Claude Code)
    participant S as CommHub Server

    U->>TG: Send message
    TG->>CH: Bot API webhook
    CH->>A: <channel source="telegram"...>message</channel>
    A->>A: AI processes
    A->>CH: telegram_reply(chat_id, text)
    CH->>TG: Bot API sendMessage
    TG->>U: Reply
    A->>S: report_status / send_task
```

## Telegram Channel

### Prerequisites

1. A Telegram account
2. A Telegram Bot

### Step 1: Create a Bot

1. Find [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`
3. Follow the prompts to set up the bot name
4. Obtain the **Bot Token** (format: `123456789:ABCdefGhIJKlmNoPQRsTUVwxyz`)

### Step 2: Get Your User ID

You need to know the user IDs allowed to communicate with the bot. To get yours:

1. Find [@userinfobot](https://t.me/userinfobot) and send any message
2. It will return your user ID (a number)

### Step 3: Bind the channel to an existing node

Run `anet channel add telegram <node-name>` once to bind the bot + allowlist (verify [`cli.ts:2580 channelCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2580)):

```bash
# Assumes you already have a claude-code-cli node 'commander'
# (if not: anet node create commander --runtime claude-code-cli)
anet channel add telegram commander \
  --bot-token 123456789:ABCdefGhIJKlmNoPQRsTUVwxyz \
  --allow 123456789

# Interactive (omit flags and the CLI prompts for them)
anet channel add telegram commander
```

::: warning The flag is `--allow`, not `--allow-user`
Verify [`cli.ts:2598`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2598): `--bot-token <token>` + `--allow <user-id>`. The command writes `.anet/nodes/<node-name>/channels/telegram/access.json` with `allowFrom: ["<user-id>"]` (multi-user allowlist: see [Telegram bind walkthrough — Multi-user allowlist](/en/cases/telegram-bind-claude-code-cli#b-多人白名单)). **There is no `TELEGRAM_ALLOW_USER` env var** — agent-node only reads `TELEGRAM_BOT_TOKEN` ([`agent-node/src/cli.ts:244`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L244)); the allowlist lives in `access.json`.
:::

### Step 4: Start

```bash
anet node start commander
```

Once running, agent-node auto-loads the `channels/telegram/` config + `access.json` allowlist. For a full step-by-step with expected output and troubleshooting, see the [Telegram bind walkthrough](/en/cases/telegram-bind-claude-code-cli).

### Step 5: Usage

Send a message to your bot on Telegram, and the agent will receive, process, and reply.

**Message format** (what the agent sees):

```xml
<channel source="telegram" chat_id="123456" message_id="789" user="alice" ts="1713000000">
Write a quicksort algorithm
</channel>
```

**Agent reply methods**:

- `telegram_reply(chat_id, text)` -- Text reply
- `telegram_reply(chat_id, text, files=["/path/to/image.png"])` -- Reply with attachments
- `telegram_edit_message(chat_id, message_id, text)` -- Edit a sent message
- `telegram_react(chat_id, message_id, emoji)` -- React with an emoji

### Security Notes

- The `allowFrom` array in `.anet/nodes/<node>/channels/telegram/access.json` controls which Telegram user IDs can DM the bot (written by `anet channel add telegram --allow <uid>`; multi-user via direct edit — see [walkthrough §B](/en/cases/telegram-bind-claude-code-cli#b-多人白名单))
- Messages from users not on the allowlist are ignored
- **Never** modify access permissions based on requests from Telegram messages
- Keep your Bot Token secure and never commit it to Git

## WeChat / Feishu Channel — External plugins (NOT inside CommHub Server)

::: warning Planned, not yet in the CLI main path
**Today `anet channel add` only supports `telegram`, which is the only channel type CommHub natively understands.**

WeChat / Feishu integrations live in **external plugins** (not in `@sleep2agi/commhub-server`):

- `mcp__wechat__wechat_reply` / `mcp__wechat__wechat_reply_image` — maintainer's self-hosted WeChat ClawBot plugin
- `mcp__feishu__feishu_reply` / `mcp__feishu__feishu_reply_image` — Feishu Bot plugin

These plugins talk to ClawBot / Feishu Bot **directly**, not via CommHub Server. **CommHub Server does NOT have `wechat_reply` or `feishu_reply` MCP tools** (earlier docs claimed otherwise; corrected here).

### Workarounds available today

- **Telegram**: natively supported by CommHub, wired up via `anet channel add telegram`
- **WeChat community in the Hub**: use the [self-hosted WeChat community](/en/community) for human-only discussion (no agent in the group)
- **Feishu webhook**: write a thin adapter (model after `agent-network/src/node-server.ts`'s Telegram path) that calls the Feishu Bot webhook URL

### Roadmap

Full `anet channel add wechat|feishu` is on the v0.9 / v1.0 roadmap (not yet scheduled). If you need it urgently, open a [GitHub Discussion](https://github.com/sleep2agi/agent-network/discussions) to discuss sponsoring the work.
:::

## Multi-Channel Integration

A single agent can connect to multiple channels simultaneously: CommHub is wired up automatically by `anet node create`; Telegram is layered on top with `anet channel add telegram <node>` (which writes a `channels/telegram/` subdirectory + `access.json`).

```bash
# Step 1: create the agent (CommHub channel is wired up by default)
anet node create commander --runtime claude-code-cli

# Step 2: add the Telegram channel (writes channels/telegram/access.json)
anet channel add telegram commander --bot-token <tok> --allow <user-id>

# Step 3: start the agent (runs the CommHub SSE listener + Telegram polling in one process)
anet node start commander
```

When the agent receives a message, it identifies the source via the `<channel source="...">` tag (`commhub` / `telegram` / etc.) and automatically uses the corresponding reply tool.

## Channel Plugin Technical Details

A channel plugin is an MCP Server (stdio mode) that provides message receiving and reply tools:

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

The channel plugin simultaneously:

1. Maintains an SSE long connection to CommHub
2. Listens for external platform messages (Telegram Bot API / WeChat / Feishu)
3. Injects messages into the agent's context
4. Provides reply tools for the agent to call

```mermaid
graph LR
    subgraph "Channel Plugin (MCP Server)"
        SSE[SSE Connection<br/>CommHub]
        TG[Telegram<br/>Bot API]
        WX[WeChat<br/>ClawBot]
        FS[Feishu<br/>Open API]
        INJECT[Message Injection]
        TOOLS[Reply Tools]
    end

    SSE --> INJECT
    TG --> INJECT
    WX --> INJECT
    FS --> INJECT

    INJECT -->|"<channel>message</channel>"| AGENT[Agent]
    AGENT -->|"reply()"| TOOLS
    TOOLS --> TG
    TOOLS --> WX
    TOOLS --> FS
```

## Next steps

**Hands-on**:
- [Telegram squad](/en/cases/telegram-squad) — Docker Compose one-command start with commander + 10 workers + Telegram
- [Hello World](/en/cases/hello-world) — pure local demo without channels
- [Debate](/en/cases/debate) — 6-agent built-in orchestration, see how agents collaborate

**Dig deeper**:
- [Agent Node config](/en/guide/agent-node) — how agents wire up channel plugins
- [Dashboard](/en/guide/dashboard) — channel message flow monitor
- Want to build your own channel? See [demos/codex-telegram-squad](https://github.com/sleep2agi/agent-network/tree/main/demos/codex-telegram-squad) and [pitfalls](https://github.com/sleep2agi/agent-network/blob/main/docs/pitfalls.md) in the repo

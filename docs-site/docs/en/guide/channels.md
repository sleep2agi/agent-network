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
    A->>CH: writes reply text (no telegram_* tool call)
    CH->>TG: agent-node handler auto sendMessage
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

You need the user IDs allowed to talk to the bot. Three methods, ranked by recommendation:

**🟢 Method A — Telegram's built-in UID bots** (fastest, for your own ID)

DM any of these bots to get your numeric UID instantly:

| Bot username | Behavior |
|--------------|------|
| **[@userinfobot](https://t.me/userinfobot)** | Send `/start` or anything → replies with `User ID` |
| **@getmyid_bot** | Auto-replies with the numeric ID |
| **@JsonDumpBot** | Returns full user JSON (id / username / lang) |

China-network users sometimes can't reach Telegram from these bots — retry, switch proxy, or fall back to Method B.

**🟢 Method B — Read the bot's inbox log** (for other people's UIDs / China fallback)

When adding **other people** to the allowlist (team members), don't ask them to install a third-party UID bot. Read your own bot's inbox instead:

1. Have them DM your node's bot any message (`/start` is fine)
2. Find their `chat_id` (numeric) in the inbox log:
   ```bash
   # In the node's workdir:
   ls -lt .anet/nodes/<alias>/channels/telegram/inbox/
   cat <newest .json file> | grep -E 'chat_id|user_id|sender'
   ```
3. Re-run `anet channel add telegram --allow <UID>` with the **full** allowlist (note: this overwrites — see [Known gaps and pitfalls](#known-gaps-and-pitfalls) below)

**🟡 Method C — Self-pair** (**not yet implemented**)

The intended UX would be: user DMs the bot `/pair` → bot replies with a 6-digit pairing code → admin runs `anet channel pair-approve <code>` to auto-add the allow entry. Not built yet — use Methods A + B for now.

### Step 3: Bind the channel to an existing node

Run `anet channel add telegram <node-name>` once to bind the bot + allowlist (verify [`cli.ts:2844 channelCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2844)):

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
Verify [`cli.ts:2861-2862`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2861): `--bot-token <token>` + `--allow <user-id>`. The command writes `.anet/nodes/<node-name>/channels/telegram/access.json` with `allowFrom: ["<user-id>"]` (multi-user allowlist: see [Telegram bind walkthrough — Multi-user allowlist](/en/cases/telegram-bind-claude-code-cli#b-multi-user-allowlist)). **There is no `TELEGRAM_ALLOW_USER` env var** — agent-node only reads `TELEGRAM_BOT_TOKEN` ([`agent-node/src/cli.ts:259`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L259)); the allowlist lives in `access.json`.
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

The agent does not call any `telegram_*` MCP tool — **no such tool exists**. The agent-node telegram handler automatically forwards the LLM's output back to the Telegram chat:

1. Telegram user sends a message → telegram bot API → agent-node receives (webhook / long-polling)
2. agent-node invokes `processTask(content)` → the LLM generates a reply text
3. agent-node's internal [`telegramSend(tg, chatId, text)`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L925) helper sends the reply back via `sendMessage` (auto-splits at 4096 chars and sets `reply_to_message_id` on the first chunk)

The agent (LLM running in the claude-agent-sdk / codex-sdk runtime) just needs to **produce reply text**; it doesn't need to know the Telegram API.

::: warning fictional `telegram_*` tool list removed
Older docs listed `telegram_reply` / `telegram_edit_message` / `telegram_react` as MCP tools — **a full source grep returns 0 hits** (no `telegram_*` `server.tool` registrations in cli.ts / commhub-channel.ts / node-server.ts). The agent simply writes a reply text and the agent-node handler does the `sendMessage` automatically.
:::

### Security Notes

- The `allowFrom` array in `.anet/nodes/<node>/channels/telegram/access.json` controls which Telegram user IDs can DM the bot (written by `anet channel add telegram --allow <uid>`; multi-user via direct edit — see [walkthrough §B](/en/cases/telegram-bind-claude-code-cli#b-multi-user-allowlist))
- Messages from users not on the allowlist are ignored
- **Never** modify access permissions based on requests from Telegram messages
- Keep your Bot Token secure and never commit it to Git
- For envRef-mode handling of vendor secrets (including Bot Token): see [Security → Vendor Credential Storage](/en/concepts/security#vendor-credential-storage-envref-mode-v0-9-0)

### Known gaps and pitfalls

| Pitfall | Symptom | Workaround |
|---|---|---|
| `--allow` is **not incremental** | Re-running `anet channel add telegram --allow <new-uid>` overwrites the entire `allowFrom` array — previously-added users are lost | Pass **all** UIDs in one shot, or edit `.anet/nodes/<alias>/channels/telegram/access.json` directly ([walkthrough §B](/en/cases/telegram-bind-claude-code-cli#b-multi-user-allowlist)) |
| Channel changes **do not hot-reload** | Editing `access.json` / `--bot-token` does not affect a running process | Always `tmux kill-session -t <alias>` + `anet node start <alias>` (channels are read at process start; still the case in v0.10.x including the current v0.10.8 stable; hot-reload design tracked in [RFC-013](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-013-rename-hot-reload.md) v5 — third-pass review complete; candidate for v0.12.0) |
| Multiple nodes **cannot share** one bot token | BotFather tokens are 1-to-1 with a bot; sharing causes message races | Run BotFather `/newbot` per node, one bot each |
| `anet channel rm telegram` **not implemented** | No CLI to remove the telegram channel from a node | Edit `.anet/nodes/<alias>/config.json` `channels` array to remove the `telegram` entry, `rm -rf .anet/nodes/<alias>/channels/telegram`, then restart the node |
| Is the flag `--allow <UID>` or `--allow-user`? | Easy to mis-remember | It's `--allow <user-id>` (verify [`cli.ts:2861-2862`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2861)). `--allow-user` does **not** exist |
| Node restarts and Telegram goes silent | Bot doesn't receive / agent doesn't reply | Three-step check: ① bot token fully pasted with the `:`; ② `anet channel ls <alias>` shows telegram in the list; ③ `tmux capture-pane -t <alias> -p \| tail` shows a `[telegram] listening` line at startup |

### Troubleshooting

**Bot doesn't receive messages**
- Check the `--bot-token` was pasted in full (with the `:` and the trailing string)
- BotFather → `/mybots` — is the bot enabled?
- Did you restart the node? (Channels do not hot-reload — see above)

**Agent doesn't reply to Telegram messages**
- `anet status` — is the node `idle / ●`? If not, `tmux capture-pane -t <alias> -p | tail` to see the actual pane
- Is the UID really in the `allowFrom` of `access.json`?
- Is the agent busy on a long commhub task? (Telegram and commhub are independent channels, but the LLM only processes one message at a time)

**`anet channel add` succeeded but `anet status` doesn't show telegram**
- Run `anet channel ls <alias>` to confirm
- Open `.anet/nodes/<alias>/config.json` and check the `channels` array contains `telegram` (the config stores `telegram`; `plugin:telegram@claude-plugins-official` is only the transient claudeArg anet builds when launching claude-code-cli — it is not written to config)

For the full step-by-step walkthrough (expected output and 6 SSE error-code diagnostics): [Telegram bind to existing node — Claude Code CLI runtime](/en/cases/telegram-bind-claude-code-cli).

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

Full `anet channel add wechat|feishu` is on the v0.11+ roadmap (v0.9.x / v0.10.x didn't ship it — those scopes were Recovery & Observability / Direct Runtime + Observability Foundations / Hero A disk + Hero D UX, with no channel-extension surface; still not scheduled). If you need it urgently, open a [GitHub Discussion](https://github.com/sleep2agi/agent-network/discussions) to discuss sponsoring the work.
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

When the agent receives a message, it identifies the source via the `<channel source="...">` tag (`commhub` / `telegram` / etc.). **The agent just produces a reply text** — the agent-node's internal handler routes it to the right platform based on `source` (telegram replies go through `telegramSend(tg, chatId, text)`, commhub replies go through SSE `send_reply`). The agent doesn't need to know Telegram API details or the commhub MCP `send_reply` call.

## Channel Plugin Technical Details

A channel plugin is an MCP Server (stdio mode) that provides message receiving and reply tools:

```json
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": [".anet/node-server.js"]
    }
  }
}
```

::: tip The filename is `.js`, not `.ts`
The file installed in your project is `.anet/node-server.js` ([`cli.ts:1644 ensureMcpJson`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1644) copies from the npm package — preferring `dist/src/node-server.js`, falling back to `src/node-server.ts` — but the on-disk filename is always `.js`).
:::

What the channel plugin actually does (v0.8 capabilities):

1. Maintains an SSE long connection to CommHub (receives new_task / new_message / new_reply / broadcast events)
2. Listens to the Telegram Bot API (webhook / long-polling) — Telegram is the only natively supported external channel in v0.8
3. Injects messages into the agent's context (XML `<channel source="...">` tag)
4. **The agent-node's internal handler automatically forwards** the agent's reply to the right platform (commhub via the `send_reply` MCP tool; telegram via the [`telegramSend`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L925) helper)

::: warning Mermaid `reply()` path correction
The original mermaid showed `AGENT → reply() → TOOLS → TG/WX/FS` — but there's no agent-facing `reply()` / `telegram_reply()` MCP tool for the agent to call. The agent only produces reply text; agent-node's handler routes it to the platform based on `source`.
:::

```mermaid
graph LR
    subgraph "agent-node process"
        SSE[SSE connection<br/>CommHub<br/>recv new_task/new_reply]
        TG[Telegram<br/>Bot API<br/>recv DM]
        INJECT[Message injection<br/>XML channel tag]
        HANDLER[agent-node<br/>internal handler]
    end

    SSE --> INJECT
    TG --> INJECT

    INJECT -->|"<channel source=&quot;commhub|telegram&quot;>"| AGENT[Agent LLM<br/>claude-agent-sdk /<br/>codex-sdk]
    AGENT -->|"reply text<br/>(no MCP tool call)"| HANDLER
    HANDLER -->|"send_reply MCP"| SSE
    HANDLER -->|"telegramSend()"| TG
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

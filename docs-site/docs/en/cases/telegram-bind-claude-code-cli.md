# Bind Telegram to an Existing Node (claude-code-cli runtime) — Detailed Walkthrough

Wire a running `claude-code-cli` node to Telegram — you DM the bot, the bot forwards messages to Claude Code, Claude Code replies (with its full toolset: bash / file ops / MCP). This walkthrough gives **expected output + on-disk files + error diagnosis for every step**.

> [!IMPORTANT]
> **Scope today**: `claude-code-cli` runtime only. `claude-agent-sdk` / `codex-sdk` Telegram bridge is scheduled in [RFC-002 Channel-Bind CLI](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-002-channel-bind-cli.md) Phase 1, targeting v0.9+.

| Info | Value |
|---|---|
| Estimated time | 5-10 minutes (includes first-time plugin install) |
| Prerequisite | A node running with `claude-code-cli` runtime (hello-world demo uses `claude-agent-sdk` — different runtime; if no node yet, see [Getting started](/en/guide/getting-started)) |
| anet version | ≥ 2.1.5 (latest) or ≥ 2.1.7-preview.0 (preview) |
| Claude Code CLI version | ≥ 2.x (needs `--channels plugin:xxx@yyy` syntax support) |

---

## Big picture

```
You →─→  @BotFather (Telegram)  →─→  bot token
        @userinfobot (Telegram)  →─→  your user id
                                       ↓
        claude plugin install telegram@claude-plugins-official
        anet channel add telegram <node> --bot-token <tok> --allow <user-id>
        anet node stop <node> && anet node start <node>
                                       ↓
        Telegram DM ─→ bot polling ─→ Claude Code ─→ bot reply
```

---

## Step 0 — Make sure the Claude Code Telegram plugin is installed

anet wires Telegram to a claude-code-cli node by spawning `claude` with `--channels plugin:telegram@claude-plugins-official`, letting Claude Code's own channel plugin system take over. **The plugin must be installed in your `claude` CLI once** (user scope, shared across all projects).

### 0.1 Check if it's installed

```bash
claude plugin list | grep telegram
```

**Installed**:

```
telegram@claude-plugins-official  user   /home/<user>/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6  installed: 2026-03-22
```

Skip to [Step 1](#step-1-—-get-bot-token--telegram-user-id).

**Not installed** (empty output / `plugin not found`): continue with 0.2.

### 0.2 Install the plugin

```bash
claude plugin install telegram@claude-plugins-official
```

Expected output:

```
Fetching from marketplace claude-plugins-official...
Resolving telegram@latest → 0.0.6
Downloading ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/...
Verifying...
✓ installed: telegram@claude-plugins-official (0.0.6, user scope)
```

On-disk layout:

```
~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/
├── plugin.json       # metadata
├── server.ts         # MCP server (Telegram bot polling main loop)
├── ACCESS.md         # permission model docs
├── README.md
├── package.json
├── bun.lock
├── node_modules/
└── skills/           # MCP skills definitions
```

### 0.3 Verify install success

```bash
claude plugin details telegram@claude-plugins-official
```

Output includes:

```
Plugin: telegram@claude-plugins-official
Version: 0.0.6
Scope: user
Install path: ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6
Components: 1 MCP server (channel), N skills
```

**Plugin is installed.** This is a one-time setup — one machine, one install, shared by every anet node.

> [!TIP]
> Plugin update: `claude plugin update telegram@claude-plugins-official`. anet doesn't pin a specific version — it follows the claude CLI's own update cadence.

---

## Step 1 — Get Bot Token + Telegram User ID

You need two things:

### 1.1 Create the bot (`@BotFather`)

Open Telegram, search [@BotFather](https://t.me/BotFather) (blue checkmark, official Telegram bot):

```
You:        /newbot
BotFather:  Alright, a new bot. How are we going to call it?
            Please choose a name for your bot.
You:        anet-test-bot          ← display name
BotFather:  Good. Now let's choose a username for your bot.
            It must end in `bot`.
You:        anet_test_bot          ← unique username
BotFather:  Done! Congratulations on your new bot.
            ...
            Use this token to access the HTTP API:
            123456789:AAEhBP_XYZxyz...   ← ★ this is your bot token
            ...
```

Copy the token (format `<bot-id>:<secret>`).

> [!WARNING]
> **Token is a secret**: it's effectively the bot's password. Do not:
> - Paste into GitHub issues / PRs
> - Screenshot to group chats
> - Write to git-tracked files
> - Upload to any public service
>
> If the token leaks, go back to BotFather → `/token` → pick your bot → `Revoke current token`.

### 1.2 Get your numeric Telegram User ID (`@userinfobot`)

Open [@userinfobot](https://t.me/userinfobot):

```
You:           /start
userinfobot:   👋 Hi User Name!
               🆔 Id: 7612221352          ← ★ this is your numeric user ID
               👤 Username: @your_handle
               🌐 Language: en
```

Copy the number (**do not copy `@username`** — anet's allowlist uses numeric IDs).

> [!NOTE]
> Your numeric Telegram user ID is globally unique and immutable. Changing your username or display name does not change it.

---

## Step 2 — Confirm target node runtime

```bash
anet node ls
```

Expected output (excerpt):

```
Node Status:

  ALIAS         RUNTIME              MODEL                  STATUS   SSE   LAST SEEN
  my-bot        claude-code-cli      claude-sonnet-4-6      idle     ✓     2s ago
  translator    claude-agent-sdk     MiniMax-M2.7           idle     ✓     5s ago
  coder         codex-sdk            gpt-5-codex            offline  ✗     2h ago
```

Find the node you want to bind Telegram to, confirm its `RUNTIME` column **is `claude-code-cli`**.

| Node runtime | Applicable to this case? |
|---|---|
| `claude-code-cli` | ✅ Yes |
| `claude-agent-sdk` | ❌ Wait for v0.9+ (RFC-002 P1) |
| `codex-sdk` | ❌ Wait for v0.9+ (RFC-002 P2) |

If your node uses an SDK runtime and you want Telegram, use [`demos/codex-telegram-squad`](https://github.com/sleep2agi/agent-network/tree/main/demos/codex-telegram-squad) (Docker Compose full-stack) or wait for v0.9.

No node yet? See [Hello World](/en/cases/hello-world), pick `claude-code-cli` runtime:

```bash
anet node create my-bot --runtime claude-code-cli
```

---

## Step 3 — Bind the Telegram channel

```bash
anet channel add telegram my-bot \
  --bot-token 123456789:AAEhBP_XYZxyz... \
  --allow 7612221352
```

Full argument reference:

| Argument | Required | Description | Example |
|---|---|---|---|
| `<type>` | ✓ | First positional. Today only `telegram`. | `telegram` |
| `<node-id>` | ✓ | Second positional. Accepts `node_name` (human-readable) or `node_id` (`n_a1b2c3d4`). | `my-bot` |
| `--bot-token <tok>` | ✓ | Telegram bot token (from @BotFather). | `123456789:AAEhBP...` |
| `--allow <user-id>` | ✓ | Your numeric Telegram user ID (first entry of the access.json allowlist). | `7612221352` |

> [!TIP]
> **Fully interactive**: omit all flags and the command prompts for each value — better for keeping sensitive tokens out of shell history:
>
> ```bash
> anet channel add telegram my-bot
> # → Telegram Bot Token: <hidden input>
> # → Allow User ID (run @userinfobot for the numeric ID): <input>
> ```

### 3.1 Expected output

```
Telegram Bot Token: 123456789:AAEhBP_XYZxyz...
Allow User ID (run @userinfobot for the numeric ID): 7612221352

✅ telegram channel added to "my-bot"
   /home/<user>/.anet/nodes/n_abc12345/channels/telegram/
   config.json updated
```

### 3.2 Errors

| Error | Cause | Fix |
|---|---|---|
| `Node "my-bot" not found. Create it first: anet node create my-bot ...` | Wrong node id/name or node doesn't exist | `anet node ls` to find the correct name |
| `P0 only supports telegram channels. Unsupported type: <X>` | First positional is not `telegram` | Use `telegram` |
| `Error: bot-token and allow required` | Empty interactive input | Re-run, fill in properly |
| `EACCES: permission denied, mkdir ...` | `.anet/nodes/` directory ownership | `chown -R $USER .anet` |

---

## Step 4 — Verify on-disk configuration

### 4.1 List channels via `anet channel ls`

```bash
anet channel ls my-bot
```

Expected output:

```
Node Channels:

  n_abc12345 (my-bot)   telegram     allow: 7612221352
```

### 4.2 Inspect on-disk files directly

```bash
ls -la ~/.anet/nodes/n_abc12345/channels/telegram/
```

```
total 16
drwxr-xr-x 3 user user 4096 May 12 10:00 .
drwxr-xr-x 3 user user 4096 May 12 10:00 ..
-rw-------  1 user user   52 May 12 10:00 .env             ← chmod 600 ✓
-rw-r--r--  1 user user  142 May 12 10:00 access.json
drwxr-xr-x 2 user user 4096 May 12 10:00 inbox            ← plugin message queue dir
```

File contents:

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
    "7612221352"
  ],
  "groups": {},
  "pending": {}
}
```

**access.json field semantics**:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `dmPolicy` | `"allowlist"` / `"deny-all"` / `"allow-all"` | `"allowlist"` | DM admission policy. `allowlist` = only `allowFrom` listed IDs |
| `allowFrom` | `string[]` (numeric user IDs) | `[<--allow arg>]` | Private chat allowlist |
| `groups` | `{ <chat_id>: "active" \| "passive" \| "deny" }` | `{}` | Group chat rules. Empty object = deny all groups by default |
| `pending` | `object` | `{}` | Internal plugin state — don't touch |

### 4.3 Check `channels` array in node `config.json`

```bash
cat ~/.anet/nodes/n_abc12345/config.json | python3 -m json.tool | grep -A 5 channels
```

Should contain:

```json
    "channels": [
        "server:commhub",
        "telegram"
    ],
```

> [!NOTE]
> `"server:commhub"` is the commhub channel (agent ↔ hub bond, included by default); telegram is parallel to it. Both channels run concurrently inside the same `claude` process.

---

## Step 5 — Restart the node so Telegram channel takes effect

> [!WARNING]
> The current implementation does **not hot-inject** channels. The node must stop + start to apply telegram. This is an RFC-002 edge case to be improved in v0.9+.

### 5.1 Stop the old process

```bash
anet node stop my-bot
```

Expected output:

```
[anet] Stopping my-bot...
[anet] Sent SIGTERM to PID 12345
[anet] my-bot stopped
```

### 5.2 Start the new process (with telegram channel)

```bash
anet node start my-bot
```

Expected output (key lines):

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
[my-bot]  Telegram plugin: polling started (bot @anet_test_bot, allow 7612221352)
```

**Key verify items**:

1. ✅ The claude command line includes `--channels plugin:telegram@claude-plugins-official`
2. ✅ Env var `TELEGRAM_STATE_DIR` points at the channels/telegram dir
3. ✅ Telegram plugin starts polling (exact log line format may vary by plugin version)

### 5.3 Error diagnosis

| Error | Cause | Fix |
|---|---|---|
| `claude: command not found` | Claude Code CLI not on PATH | `npm i -g @anthropic-ai/claude-code` |
| `plugin telegram@claude-plugins-official not found` | Skipped Step 0 | Go back, run `claude plugin install telegram@claude-plugins-official` |
| `TELEGRAM_BOT_TOKEN env var missing` | `.env` not generated / not read | `ls -la ~/.anet/nodes/<node>/channels/telegram/.env`; re-run `anet channel add telegram` if missing |
| `Telegram getUpdates: 401 Unauthorized` | Bot token wrong / revoked | Go to BotFather `/token`, re-issue, re-run `anet channel add telegram` to overwrite |
| `Telegram getUpdates: 409 Conflict` | Same bot token also polling in another process | Stop the other process; one bot token = one polling process |

---

## Step 6 — DM the bot from Telegram

In Telegram, search the bot username (`@anet_test_bot`), tap `Start`, then send a message:

```
You:    Count from 1 to 10
Bot:    1, 2, 3, 4, 5, 6, 7, 8, 9, 10
        (actual reply content depends on what Claude Code produces)
```

Behind the scenes:

1. Telegram plugin receives the update.message
2. Verifies `from.id == 7612221352` (allowlist) — passes
3. Feeds the message content into claude's main loop
4. Claude Code processes (may call tools, write files, run bash)
5. After processing, plugin calls Telegram `sendMessage` to reply

### 6.1 No reply, what to check

In rough probability order:

**1. You're not in the allowlist**

If you DM from a different Telegram account it's silently dropped. Re-confirm your current user ID with `@userinfobot`, compare to access.json:

```bash
cat ~/.anet/nodes/<node-id>/channels/telegram/access.json | python3 -m json.tool
```

```json
{
  "allowFrom": ["7612221352"]   ← must include the ID you're DM-ing from
}
```

If mismatched:

```bash
anet channel add telegram <node-id> \
  --bot-token <same-token> \
  --allow <your-correct-id>
# Restart
anet node stop <node-id> && anet node start <node-id>
```

**2. Node is offline**

```bash
anet node ls | grep <node-id>
```

`STATUS` not `idle` / `working` → offline. Tail logs:

```bash
anet logs <node-id> | tail -30
```

**3. Plugin polling stuck**

```bash
anet logs <node-id> | grep -i "telegram\|polling\|getUpdates"
```

Normally a polling log line every few seconds. If silent, plugin may have a bug — `claude plugin update telegram@claude-plugins-official` and retry.

**4. Bot token revoked by you/someone**

```bash
curl "https://api.telegram.org/bot<your-token>/getMe"
```

Healthy returns bot info JSON; `{"ok": false, "error_code": 401}` means the token is dead. Go to BotFather, revoke + reissue.

**5. Bot is polling in another process too**

Telegram allows only one polling process per bot, otherwise the two processes **fight** for messages (each message lands in one). Check:

```bash
ps aux | grep "telegram" | grep -v grep
```

Should be exactly one claude process anet started using this bot. Stop the others.

---

## Advanced

### A. Accept group chats (deny by default)

`access.json`'s `groups: {}` denies all group chats by default. To accept a group:

```bash
# Get the group chat_id (forward any group message to @userinfobot to get the chat id)
# Suppose chat_id = -1001234567890

# Manually edit access.json
python3 -c "
import json
p = '/home/<user>/.anet/nodes/<node-id>/channels/telegram/access.json'
d = json.load(open(p))
d['groups']['-1001234567890'] = 'active'
json.dump(d, open(p, 'w'), indent=2)
print('done')
"

# Restart
anet node stop <node-id> && anet node start <node-id>
```

`groups` field values:

| Value | Behavior |
|---|---|
| `"active"` | Bot responds to all @mentions in the group |
| `"passive"` | Bot only responds to `/command` |
| `"deny"` | Reject (default behavior, but explicit also works) |

### B. Multi-user allowlist

Team sharing a single bot:

```bash
# Add the first person via the CLI
anet channel add telegram <node-id> --bot-token <tok> --allow 7612221352

# Add a second person — edit access.json directly (CLI doesn't take multiple --allow)
python3 -c "
import json
p = '/home/<user>/.anet/nodes/<node-id>/channels/telegram/access.json'
d = json.load(open(p))
if '9988776655' not in d['allowFrom']:
    d['allowFrom'].append('9988776655')
json.dump(d, open(p, 'w'), indent=2)
"

anet node stop <node-id> && anet node start <node-id>
```

### C. Rotate the bot token

```bash
# Just re-run the add command to overwrite
anet channel add telegram <node-id> \
  --bot-token <new-token> \
  --allow <user-id>
# Restart
anet node stop <node-id> && anet node start <node-id>
```

Don't forget to revoke the old token in BotFather (so a leak of the old one is useless).

### D. Unbind Telegram

```bash
# 1. Remove "telegram" from the channels array in config.json
python3 -c "
import json
p = '/home/<user>/.anet/nodes/<node-id>/config.json'
d = json.load(open(p))
d['channels'] = [c for c in d['channels'] if c != 'telegram']
json.dump(d, open(p, 'w'), indent=2)
"

# 2. Delete the channels/telegram directory
rm -rf /home/<user>/.anet/nodes/<node-id>/channels/telegram

# 3. Restart
anet node stop <node-id> && anet node start <node-id>
```

### E. Multiple nodes sharing one bot (**not recommended**)

Telegram allows only one polling process per bot. Multiple anet nodes using the same bot token will **fight for messages** — unpredictable.

**Correct approach**: one bot per node (BotFather lets you create multiple bots).

### F. Does changing my password affect the telegram channel?

**No.** See [issue #17 detailed answer](https://github.com/sleep2agi/agent-network/issues/17#issuecomment-4428789875). Changing the user password only revokes `utok_`; the node uses `ntok_`, which is unaffected; the SSE long-connection stays up; the Telegram plugin keeps polling.

---

## Security considerations

### Token storage

- `.env` file is `chmod 600` (only the owning user can read)
- `.anet/` is in `.gitignore` (won't enter git)
- Bot token is **not uploaded to the hub** (purely agent-local)

### Allowlist enforcement

- A Telegram user not in `allowFrom` DM-ing the bot → **silently dropped** (no error reply, no audit log entry)
- This is a deliberate trade-off: not replying with an error avoids leaking that anet runs the bot (to defeat reconnaissance)

### Scope of bot's authority

- Claude Code is launched with `--dangerously-skip-permissions` — tool calls won't ask for confirmation
- Any user in `allowFrom` can make the bot run **arbitrary bash commands / modify any files** (Claude has Bash / Write / Edit tools)
- **Production deployments**:
  - Run this node in a disposable / dedicated working directory (NOT `$HOME`)
  - Keep `allowFrom` strictly limited to trusted users
  - Consider `--tools` to restrict Claude Code's tool surface (drop Bash / Write)

```bash
# Restrict tools at node-create time
anet node create my-bot --runtime claude-code-cli \
  --tools "Read,Glob,Grep,WebFetch"   # read + network only, no Bash/Write/Edit
```

---

## Differences from `demos/codex-telegram-squad/`

| | `codex-telegram-squad` demo | This case |
|---|---|---|
| Deployment | Docker Compose: hub + multiple workers + telegram bot in one stack | Add Telegram to an existing anet-installed node |
| Runtime | Multiple `codex-sdk` workers + 1 `claude-agent-sdk` commander | Single `claude-code-cli` node |
| Telegram bridge layer | Demo-internal code (agent-node:codex commander implements bot bridge) | Claude Code's official plugin (`telegram@claude-plugins-official`) |
| Scenario | Multi-agent collaboration + Telegram command center (product showcase) | Single agent + Telegram channel (everyday use) |

---

## Other runtimes

| Runtime | Today | Status |
|---|---|---|
| `claude-code-cli` | ✅ this case | Works |
| `claude-agent-sdk` | ❌ | [RFC-002](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-002-channel-bind-cli.md) Phase 1 — agent-node gets a `telegram-bridge` worker, targeting v0.9+ |
| `codex-sdk` | ❌ | RFC-002 Phase 2 — reuses the Phase 1 bridge |

Why the SDK runtimes can't reuse the claude-code-cli path: claude-code-cli spawns the Claude Code CLI subprocess, and that CLI has the plugin protocol built in. The SDK runtimes are direct calls into `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk` — no plugin hooks. To get Telegram into those runtimes we need a bridge worker in anet itself. RFC-002 has the full design.

---

## Troubleshooting cheat sheet

| Symptom | Check | Fix |
|---|---|---|
| `anet channel add` says `Node not found` | `anet node ls` | Use the correct node id/name |
| `anet node start` says `plugin not found` | `claude plugin list` | Run 0.2 to install the plugin |
| `anet node start` says `claude: command not found` | `which claude` | `npm i -g @anthropic-ai/claude-code` |
| Telegram DM gets no reply | `anet node ls` to check STATUS | If offline, check logs |
| `409 Conflict` from Telegram | `ps aux \| grep claude` | Stop the other process polling this bot |
| `401 Unauthorized` from Telegram | `curl api.telegram.org/bot<tok>/getMe` | Token dead — re-issue via BotFather |
| Others ignored as expected, but **my own** DMs also ignored | Compare `access.json.allowFrom` vs ID from `@userinfobot` | Edit access.json with the right ID, restart |

---

## Next steps

- [Channels concept](/en/guide/channels) — overall channel design
- [Agent Node](/en/guide/agent-node) — full node config fields
- [Debate Demo](/en/cases/debate) — built-in 6-agent orchestration (no Telegram)
- [Telegram Squad](/en/cases/telegram-squad) — full Docker Compose Telegram squad
- [RFC-002 Channel-Bind CLI](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-002-channel-bind-cli.md) — Telegram bridge design for SDK runtimes (v0.9+)
- [issue #14](https://github.com/sleep2agi/agent-network/issues/14) — tracking issue

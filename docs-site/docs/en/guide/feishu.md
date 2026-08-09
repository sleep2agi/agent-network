# Feishu Channel Integration Guide

Connect an anet node to Feishu so Feishu users can talk to the agent directly. `claude-agent-sdk` runtime + built into anet (no longer routed through an external plugin).

> **Status (preview, tracking [#179](https://github.com/sleep2agi/agent-network/issues/179))**: shipped from anet `2.2.22-preview.2` / agent-node `2.4.15-preview.2` — DMs + group `@bot` + text + images are all **working**; full commhub-gateway / Dashboard pass-through is a follow-up PR. Design doc: [RFC-020](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-020-im-platform-integration.md).

## 1. Status + scope

| Dimension | Current capability |
|---|---|
| Runtime | `claude-agent-sdk` only (claude-code-cli / codex-sdk / grok-build-acp later) |
| Reach | ✅ DM (sender `open_id` on the allowlist) / ✅ Groups via `@bot` |
| Media | ✅ Text / ✅ Images (requires a vision-capable model — see §4) |
| Dashboard topology | ❌ Not yet (commhub-gateway lands later) |
| Active push | ❌ Agent only responds to inbound messages (`anet im send` queued under RFC-020 §12.9) |

## 2. Prerequisites: Feishu self-built app

In the [Feishu Open Platform](https://open.feishu.cn), create an **enterprise self-built app** and configure it in this order:

1. Enable **Bot** under App Capabilities → Add App Capability.
2. Request these permissions under Permissions (Feishu's official [Receive message event documentation](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=en-US) covers the two readonly receive scopes; the send / resource scopes support the bridge capabilities below):
   - `im:message.p2p_msg:readonly` — receive DMs that users send to the bot
   - `im:message.group_at_msg:readonly` — receive group messages that @mention the bot
   - `im:message` — read message content and call message APIs
   - `im:message:send_as_bot` — send messages as the bot
   - `im:resource` — upload images and other resources that the bot sends
3. Copy the **App ID** + **App Secret** from Credentials & Basic Info.
4. **Do not save the event-subscription settings yet.** Use these credentials to start a test long-lived connection through §3 (Docker) or §8 (manual), and keep that process running.
5. With the test connection running, return to Event Subscription → Delivery Mode, select **"Long-lived connection / 使用长连接"** (**NOT** "Webhook URL"), save it, and subscribe only to **"Receive message — `im.message.receive_v1`"**.
   - Feishu's official [long-lived connection setup guide](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case) requires this order: **start the client before saving the delivery mode**.
   - No public IP, webhook URL, or Encrypt Key is needed.
6. **Create and publish a version**, then wait for admin approval.

::: warning ⚠️ Real-world gotchas (users have hit all four)
1. **Start the test connection before saving the delivery mode** — if the order is reversed, the Feishu console cannot detect a long-lived connection client.
2. **Delivery mode MUST be "Long-lived connection / 使用长连接"** — not "Webhook URL". The Feishu console calls it "长连接", not "WebSocket".
3. **Don't subscribe `bot_p2p_chat_entered` ("User entered chat") by mistake** — tick only "Receive message `im.message.receive_v1`". Extra subscriptions trigger unintended paths.
4. **Network reachability**: the official SDK first authenticates through `https://open.feishu.cn/callback/ws/endpoint` and receives a dynamically assigned `wss://...` URL, then connects that WebSocket. Corporate firewalls and proxies must allow HTTPS to `open.feishu.cn` plus the dynamic WSS destination returned in the response; do not hard-code an old domain or a single WSS hostname / IP.
5. **Add the bot to the group first** — if the bot isn't a group member, no one can `@` it. A group admin needs to go to Group Settings → Group Bots → Add Bot → pick the self-built app you just published. §6 below also requires the group's `chat_id` to be on the allowlist.
:::

## 3. 🚀 Docker one-command (recommended)

::: tip Recommended path
Docker one-command = fill in `.env` + `docker compose up -d`. **The container's entrypoint runs `anet login` + node create + channel-bind + start automatically** — the Feishu bridge comes up right away. Vincent's preferred path.
:::

The template files live in [`docker/feishu/`](https://github.com/sleep2agi/agent-network/tree/main/docker/feishu) in the repo:

```
docker/feishu/
├── docker-compose.yml      # BYOH default + optional local-hub profile
├── Dockerfile              # node:22-bookworm-slim + bun + pinned versions
├── .env.example            # field template, annotated with verified vendor+model combos
├── entrypoint.sh           # login → node create → channel add feishu → start; reruns bootstrap on restart
└── README.md               # 3-step quickstart + .env essentials + troubleshooting table
```

### 3-step quickstart

```bash
git clone https://github.com/sleep2agi/agent-network.git
cd agent-network/docker/feishu/

cp .env.example .env
$EDITOR .env                                # fill in account / app / model — see table below

docker compose up -d                        # ~2 min on the first build
docker compose logs -f feishu-agent         # tail bring-up + runtime logs
```

For a new app, leave the container running and return to §2 step 5 to save "Long-lived connection" and add the event subscription. In the current release, `bridge online` means only that the worker started; it **does not by itself prove Feishu authentication or WebSocket readiness**. Also confirm that the log has no `failed to obtain token` / `[ws] ws connect failed` and that the Feishu console recognizes the test connection.

The container entrypoint runs the full bring-up chain: `hub init` → `anet login` → `anet node create` → `anet channel add feishu` → `anet node start`. Node state persists under `./data/.anet/`; each restart rewrites the Docker bootstrap allowlist from the current `.env`.

### `.env` essentials (canonical source: [`docker/feishu/.env.example`](https://github.com/sleep2agi/agent-network/blob/main/docker/feishu/.env.example))

| Field | Purpose | Required |
|---|---|---|
| `HUB_URL` | Your own commhub-server URL | ✅ |
| `HUB_USER` / `HUB_PASSWORD` | Account on that hub (**non-interactive `anet login --username/--password` runs on every container start, so there is no pre-issued ntok_ to manage**) | ✅ |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | The credentials from §2 | ✅ |
| `ANET_MODEL` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | LLM-backend triple (see §4) | ✅ |
| `FEISHU_ALLOW_FROM` | DM sender `open_id` values scoped to the current app (comma-separated) | ✅ At least one of these two |
| `FEISHU_ALLOW_CHATS` | Group `chat_id` values scoped to the current app (comma-separated) | ✅ At least one of these two |
| `NODE_ALIAS` | Node alias (default `feishu-agent`) | Optional |
| `ACK_PLACEHOLDER` | "⏳ 处理中…" placeholder switch (default `true`, see §7) | Optional |

The `.env.example` file ships annotated comments with verified vendor + model combos: DeepSeek / MiniMax (M2.7 text / M3 vision) / Claude Sonnet / InternLM intern-s2-preview, etc.

### BYOH (Bring Your Own Hub)

**The default `docker compose up` starts only the agent service and connects to your own hub** (`HUB_URL=https://your-hub...`). It does **not** spin up a hub for you. This is the production path.

> 🧪 **`--profile local-hub` is self-test only.** It runs a throwaway local hub container alongside the agent for an isolated smoke test. **Off by default** — you have to explicitly `docker compose --profile local-hub up -d` and set `HUB_URL=http://hub:9200` in `.env`. Ignore it for daily use.

### Volume mapping + safety boundary (two subdirectories)

`docker-compose.yml` mounts **only two subdirectories** of cwd (not the entire cwd), so the blast radius stays strictly bounded — the agent's Bash / full tools cannot reach the compose file, the `.env`, or any other host directory:

| Host (cwd subdir) | Container | What's stored |
|---|---|---|
| `./data` | `/work` | Node config, channels (`.env` + `access.json`), logs, SQLite — all under `./data/.anet/` |
| `./claude` | `/root/.claude` | claude-agent-sdk **conversation history** `projects/-work/<session>.jsonl` |

Both matter: the `session` field in `config.json` is only the **resume id** (under `./data`); the actual **conversation transcript** lives under `/root/.claude` (not `/work`). **Without the `./claude` mount, recreating the container loses the transcript → the SDK can't resume → "No conversation found" and the bot forgets prior context.** With it, the bot keeps its memory across container recreate / upgrade. Both dirs are auto-created on first `up`.

### Pinned versions + upgrades

The image pins exact preview versions via Docker `ARG` (currently `agent-network 2.2.22-preview.2` + `agent-node 2.4.15-preview.2`) — no floating `@preview` tag, so builds are reproducible. To rebuild against a newer preview:

```bash
ANET_VERSION=2.2.23-preview.0 \
ANET_NODE_VERSION=2.4.16-preview.0 \
  docker compose build
docker compose up -d
```

Once a `latest` release ships, this guide will switch over in lockstep.

### Startup verification / troubleshooting (5 lines)

| Log line | What to do |
|---|---|
| `HUB_URL: missing — set HUB_URL=...` | A required `.env` var is empty; fix `.env` and `docker compose up -d` again |
| `❌ Cannot reach hub: Cannot connect to CommHub server` | `HUB_URL` is wrong / the hub is down — verify with `curl $HUB_URL/health` from the host |
| `❌ Login failed: invalid username or password` | `HUB_USER` / `HUB_PASSWORD` don't match the hub's account — try `anet login` on the host first to verify credentials |
| `[claude] image attachments (N) received but ... text-only` | The `ANET_MODEL` you picked isn't vision-capable — switch to MiniMax-M3, Claude Sonnet, or another vision model |
| Container restart-loops without reaching `[start] exec agent-node` | A bring-up step fail-fasts — `docker compose logs feishu-agent` shows which step |

More troubleshooting in [`docker/feishu/README.md`](https://github.com/sleep2agi/agent-network/blob/main/docker/feishu/README.md) and §9 below.

## 4. LLM backend (`claude-agent-sdk` runtime)

The Feishu bridge hands inbound messages to the `claude-agent-sdk` runtime, so the LLM backend is configured via three env vars:

| env | Purpose |
|---|---|
| `ANTHROPIC_BASE_URL` | The vendor's Anthropic-compatible endpoint |
| `ANTHROPIC_AUTH_TOKEN` | That vendor's API key |
| `ANET_MODEL` | The specific model id the vendor accepts |

**Text-only scenarios** work with any compatible vendor (DeepSeek / Anthropic Sonnet / MiniMax / Zhipu GLM / Moonshot Kimi / InternLM / Xiaomi MiMo / OpenRouter, etc. — see [Multi-Model Config](/en/guide/multi-model)).

**Image scenarios** require a **vision-capable** backend. Common choices:

| Backend | Example model | Notes |
|---|---|---|
| Anthropic native | `claude-sonnet-4-6` | Mainline vision |
| MiniMax | `MiniMax-M3` | China-domestic reachable |
| Xiaomi MiMo (vision) | `mimo-v2.5-pro` etc. | China-domestic reachable |

When the picked backend doesn't support images and Feishu delivers an image message, the bridge **warns-and-degrades** to text-only processing (M5b behavior). It does not crash.

📖 Full multi-model / multi-vendor reference: [Multi-Model Config](/en/guide/multi-model)

## 5. Access whitelist

The bridge does **not** accept messages from the entire network — you must explicitly list allowed **users** (`open_id`) and **groups** (`chat_id`) in `access.json`.

**Docker path** (recommended): before the first startup, set at least one of `.env` `FEISHU_ALLOW_FROM` (real `open_id` values scoped to the current app) or `FEISHU_ALLOW_CHATS` (`chat_id` values). Empty or comma/whitespace-only input does not mean "allow everyone"; the container refuses to start. Separate multiple IDs with commas. The entrypoint trims, removes empty/duplicate entries, and merges the bootstrap IDs into `access.json`. IDs added with `anet channel allow` survive restarts; use the matching `--rm-*` command to remove one.

**Manual `anet` path**: use the CLI to add / remove entries:

```bash
# Allow a user to DM the bot
anet channel allow feishu <node> --add-from ou_<your-open-id>

# Allow the bot in a group
anet channel allow feishu <node> --add-chat oc_<group-chat-id>

# Remove
anet channel allow feishu <node> --rm-from ou_<your-open-id>
anet channel allow feishu <node> --rm-chat oc_<group-chat-id>
```

The flags are **repeatable** (one invocation can carry multiple `--add-from a --add-from b`). **Comma-separated lists are NOT supported** — `--add-from a,b,c` is stored verbatim as a single open_id.

Inspect the current whitelist:

```bash
anet channel ls
# Lists every node's channels + allowFrom + allowChats
```

::: warning Restart the node after every change
`access.json` is **not hot-reloaded** — after every edit you must `anet node stop <node>` + `anet node start <node>` (for the Docker path, `docker compose restart <node-service>`). The bridge reads `access.json` into memory once at startup.
:::

::: danger Switching Feishu apps — a guaranteed trap: open_id / chat_id are per-app
Feishu's `open_id` (user identity) and `chat_id` (conversation) are **scoped per app** — **the same person has a completely different `open_id` under a different app.** So after switching apps, the old IDs in `access.json` **all become invalid**, and every message hits "sender not in allowlist" and is silently denied.

When switching apps, update **all three** places: ① `FEISHU_APP_ID` / `FEISHU_APP_SECRET` in the node env / deployment ② the channel `.env` ③ **`allowFrom` / `allowChats` in `access.json`** (most often missed).

Classic symptom of missing the third: **`client ready` is fine, events arrive, yet the user's messages get "no reaction."** Full post-mortem → [Case Study: Feishu Silent Deny](/en/troubleshooting/case-feishu-silent-deny).
:::

## 6. Group `@bot` mechanics

Two steps for the bot to work in a group:

1. **A group admin adds the bot** (via Feishu's "Bot Management" panel or `@`-invite in the chat)
2. **That group's `chat_id` is added to `allowChats`** (see §5)

After joining, the **default group policy is `mention`** — only group messages that actually `@` the bot trigger the agent; regular chatter is silently ignored (anti-noise).

How the bridge decides whether you `@`'d the bot: it compares each `mentions[].id.open_id` in the message to the bot's own `open_id` (the bridge pulls its own `open_id` at startup via `/open-apis/bot/v3/info`).

DMs **do not** require `@` — anything a whitelisted user sends triggers the bot directly.

::: tip Threading
The bot's reply follows the original message's `root_id` into the **same thread**, so it does not pollute the main channel.
:::

## 7. ⏳ Processing… (`ackPlaceholder`)

On every inbound message, the bridge **immediately sends a "⏳ 处理中…" placeholder** so the user knows the bot received their message; once the agent is done thinking, **the reply is delivered as a fresh new message** (the placeholder is **never** edited in place). This is the Option A behavior decided by Vincent on 2026-06-26.

**Why not edit the placeholder in place — why send a new message?**

- IM clients **do not push a notification when a message is edited** — unless the user actively re-opens the chat, they have no signal that the bot has finished
- A new message delivers a **second push** — "⏳ 处理中…" (bot received you) + the actual reply (bot is done). Both signals reach the user

The timeout notice (`TIMEOUT_NOTICE_TEXT`) follows the same path — also a fresh message, never an edit.

**Default `true`**. To turn it off:

> Enable it by setting `ACK_PLACEHOLDER=true` in `.env` (see `docker/feishu/.env.example`).

## 8. Advanced: manual `anet node` setup (non-Docker)

If you'd rather not use Docker, or want to install directly on the host:

### 8.1 Install preview

```bash
npm install -g \
  @sleep2agi/agent-network@2.2.22-preview.2 \
  @sleep2agi/agent-node@2.4.15-preview.2
# Or pull the current preview tag:
# npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
```

> The Feishu channel is still on the preview track; this page will be updated in lockstep once it promotes to `latest`.

### 8.2 Create a node + bind Feishu

You need an existing node. To create one:

```bash
anet node create <node-name> --runtime claude-agent-sdk
```

Bind the Feishu channel:

```bash
anet channel add feishu <node-name> \
  --app-id     cli_xxxxxxxxxxxxxx \
  --app-secret yyyyyyyyyyyyyyyyy \
  --allow      ou_<your-open-id>          # open_id of someone allowed to DM
  --allow-chat oc_<group-chat-id>         # optional: chat_id of an allowed group
```

Without flags it falls into interactive mode:

```bash
anet channel add feishu <node-name>
```

Writes under `.anet/nodes/<node-name>/channels/feishu/`:

| File | Contents | Mode |
|---|---|---|
| `.env` | `FEISHU_APP_ID` + `FEISHU_APP_SECRET` | `chmod 600` |
| `access.json` | `{allowFrom: [open_id...], allowChats: [chat_id...]}` | `chmod 644` |

### 8.3 Start the node

```bash
anet node start <node-name>
```

For a new app, keep the node running and return to §2 step 5 to save the long-lived connection subscription and publish the version.

Startup logs first include these **worker-process markers**:

```
[agent-node] channels: feishu(/path/.anet/nodes/<node-name>/channels/feishu)
[agent-node] [feishu] forked worker (pid 12345) for ... via ...
[feishu:worker] bridge online — node=<node-name> dir=... ipc=yes
```

In the current release, `bridge online` is not connection-success evidence: this line can appear even when the app credentials fail authentication. A connection-layer check must also confirm there is no `failed to obtain token` / `[ws] ws connect failed` and that the Feishu console recognizes the running test client when saving "Long-lived connection"; do not substitute a live message for a connection-only check.

The worker path defaults to `dist/src/im/feishu/worker.js` (shipped with `@sleep2agi/agent-network`). To override:

```bash
export ANET_FEISHU_WORKER_PATH=/path/to/your/worker.js
```

### 8.4 Trigger policy sanity-check

- **DM**: triggers only when `sender.open_id ∈ allowFrom`; off-whitelist senders log `[feishu:audit] deny from=...` on stderr and the IPC envelope is not dispatched
- **Group**: requires both `chat_id ∈ allowChats` **and** an actual `@bot` mention; without the mention, silently ignored
- **Threading**: replies follow `root_id` into the original thread

## 9. Troubleshooting

| Symptom | What to check |
|---|---|
| Node startup logs `unsupported channel: feishu` | agent-node is too old — upgrade to `agent-node@2.4.15-preview.2` or newer |
| `[feishu] worker path not found` warn | Set `ANET_FEISHU_WORKER_PATH`, or verify `@sleep2agi/agent-network` is installed and compiled |
| `failed to obtain token` | Wrong App ID / Secret, unusable app state, or authentication failure; `bridge online` does not override this error |
| `[ws] ws connect failed` | Check HTTPS access to `open.feishu.cn` and whether the corporate network / proxy blocks the dynamically returned WSS destination |
| Only `bridge online` / `client ready` appears | These are local-initialization clues, not proof of authentication or WebSocket readiness; rule out the two errors above and check whether the Feishu console recognizes the test client |
| Bot doesn't reply in a group | 1) Bot is added to the group with send permissions 2) `access.json` `allowChats` includes the target `chat_id` 3) `/open-apis/bot/v3/info` is returning a valid `open_id` 4) After editing `access.json`, did you restart the node? (Not hot-reloaded — see §5) |
| Bot doesn't reply in a DM | Verify the sender's `open_id` is in `allowFrom` (run `anet channel ls`) |
| **Connected, events arrive, but messages get "no reaction"** | **grep the bridge stderr for `deny` / `allowFrom`**: message received but sender not in allowlist. **Most common after switching apps** (`open_id` changed per app — see the §5 danger note) |
| Bot replies seem wrong / errors out on an image | The backend isn't vision-capable (§4) — switch to a vision-capable model |
| **Sending an image gets "received the event but no processable text/image content"** | The image wasn't extracted. Check in order: ① the node has image capability off (`flags.modelImageCapable` is unset by default — see §4) ② **download failed** — look for `[feishu:image] … download FAILED` in the log; most often the **old `downloadImage` SDK-misuse bug** ([#324](https://github.com/sleep2agi/agent-network/pull/324), present in old builds like `2.2.22-preview.2`) — upgrade to a preview that includes the fix. See [Case Study · companion](/en/troubleshooting/case-feishu-silent-deny#companion-case-the-bot-can-t-see-images) |

Diagnostic mnemonic (narrow by layer): ① look first for `failed to obtain token` / `[ws] ws connect failed`; `bridge online` or `client ready` alone does not mean the connection succeeded; ② the Feishu console recognizes the test connection but no events arrive = check for missing `im.message.receive_v1`, the wrong delivery mode, or an unpublished version; ③ events arrive but there is no reply = denied at the application layer, grep `deny` / `allowFrom`; ④ an image gets no reaction = check the `modelImageCapable` flag and whether the download failed (old-version bug, upgrade). Full post-mortem → [Case Study: Feishu Silent Deny](/en/troubleshooting/case-feishu-silent-deny).

## 10. Known limitations (preview scope)

- **Not yet in Dashboard topology** — Feishu messages don't go through the commhub task path, so Dashboard doesn't see them. Full commhub-gateway (RFC-020 §2.9 schema delta) is a follow-up PR
- **The agent cannot actively push Feishu messages** — only responds to inbound. Active push (`anet im send`) is queued for P1.5 (RFC-020 §12.9)
- **`claude-agent-sdk` runtime only** — `claude-code-cli` still uses the [community plugin](https://github.com/vansin/claude-code-feishu-channel); `codex-sdk` / `grok-build-acp` come later

## References

- [RFC-020 IM Integration Layer](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-020-im-platform-integration.md) — full design
- [RFC-002 channel-bind-cli](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-002-channel-bind-cli.md) — telegram-bridge pattern precursor
- [issue #179](https://github.com/sleep2agi/agent-network/issues/179) — parent RFC tracker
- [Channel Integration overview](/en/guide/channels) — Telegram / WeChat / Feishu positioning
- [Multi-Model Config](/en/guide/multi-model) — backend selection
- [Community SDK-layer prior art](https://github.com/vansin/claude-code-feishu-channel) — `claude-code-cli` path

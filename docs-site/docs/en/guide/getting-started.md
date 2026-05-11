# Getting Started

This is the current minimal local path for the stable packages. The flow follows the v2/v3 Docker + Playwright E2E path: install CLI, start Hub, start Dashboard, log in, create a node, start it.

::: tip Roles
| Package | Version | Role |
|---|---|---|
| `@sleep2agi/agent-network` | 2.1.2 | `anet` CLI (start hub / dashboard, manage nodes) |
| `@sleep2agi/commhub-server` | 0.6.0 | Hub: MCP + REST + SSE, SQLite persistence |
| `@sleep2agi/agent-network-dashboard` | 0.3.2 | Web Dashboard |
| `@sleep2agi/agent-node` | 2.3.0 | Agent runtime |
:::

## 0. Prerequisites

| Dependency | Version |
|---|---|
| Node.js | ≥ 20 |
| npm | ≥ 9 |

`commhub-server` and `agent-node` are pulled on demand via `bunx` / `npx`. You only install one global package.

## 1. Install the CLI

```bash
npm install -g @sleep2agi/agent-network
```

Verify:

```bash
anet -v
```

## 2. Start the Hub

Open a terminal and **keep it open**:

```bash
anet hub start
```

What happens:

- Binds to `http://127.0.0.1:9200` by default
- SQLite database at `~/.commhub/commhub.db` (created automatically)
- Admin account auto-bootstrapped on first run with default credentials `admin / anethub` — change via `anet passwd` after first login
- Output prints a LAN URL (so other machines can join) plus a snippet to wipe state

## 3. Start the Dashboard

Open a second terminal and **keep it open**:

```bash
anet hub dashboard
```

Open `http://localhost:3000` in a browser, log in with `admin / anethub` (the default — change it via `anet passwd` after).

Pages: Chat / Nodes / Tasks / Messages / Networks / Logs / Admin / Docs. The Chat page renders markdown, sends on Enter, shows source labels (`You` / `↳ peer-agent`), and persists history across reloads.

## 4. Log in via CLI

In a third terminal:

```bash
anet login --username admin --password anethub
```

Credentials are saved to `~/.anet/config.json`. Subsequent `anet node ...` commands pick them up automatically. `anet whoami` confirms the current identity.

## 5. Create an Agent

```bash
anet node create my-bot
```

You'll get a two-step interactive picker:

1. **Pick the runtime** — `claude-agent-sdk` is the verified default.
2. **Pick the provider** — MiniMax / DeepSeek / GLM / Kimi / Anthropic etc. Each preset writes the right `ANTHROPIC_BASE_URL` and a sensible default model, then prompts for the API key.

::: details Other runtimes
- `codex-sdk` — passes unit tests; **no full E2E** with real codex auth.
- `claude-code-cli` — works locally for Claude Pro subscribers; **not E2E tested**.
:::

The node config is written to:

```
.anet/nodes/my-bot/config.json
```

## 6. Start the Agent

```bash
anet node start my-bot
```

You should see `SSE connected`. The agent is now online and waiting for tasks. Keep the terminal open.

## 7. Send a task from the Dashboard

Back in your browser at `http://localhost:3000`:

1. Open the Chat page, click `my-bot` on the left.
2. Type a message and press Enter.
3. Your message appears immediately (optimistic echo, label `You`).
4. The agent calls the LLM and replies with full markdown rendering (label `↳ my-bot`).

Reload — chat history is still there.

## 8. Multi-agent collaboration

Spin up a second node:

```bash
anet node create video-bot --runtime claude-agent-sdk
anet node start video-bot
```

In the Dashboard, ask `my-bot`:

> ask video-bot what it can do

`my-bot` discovers `video-bot` via the commhub MCP `get_all_status` tool, dispatches the question with `send_task`, polls `get_task` for the reply, and integrates the result. The Tasks and Messages pages show the full handshake live.

## 9. LAN access (another machine joins the same hub)

By default `anet hub start` binds to localhost only. To let other machines join over LAN, start the hub with an explicit LAN bind:

```bash
anet hub start --host 0.0.0.0
```

On another machine:

```bash
npm install -g @sleep2agi/agent-network
anet init --hub http://<HUB-LAN-IP>:9200
anet login --username admin --password anethub
anet node create remote-bot
anet node start remote-bot
```

`remote-bot` shares the same hub as your local agents.

## Verified vs unverified

::: info Verified (current stable line follows the v2 E2E path)
- `anet hub start` with auto-default-admin
- `anet hub dashboard`
- `anet login` / `anet register` / `anet logout` / `anet whoami`
- `anet node create / start / delete / ls` with `claude-agent-sdk` + MiniMax / DeepSeek / GLM / Kimi / Anthropic
- Dashboard chat: markdown, Enter-to-send, optimistic echo, source labels, failure rendering, persistent history
- Multi-agent coordination via `get_all_status` + `send_task` + `get_task`
- LAN-shared hub
:::

::: warning Not verified (treat as experimental)
- `anet quickstart` — removed from the docs.
- `codex-sdk` runtime end-to-end.
- `claude-code-cli` runtime end-to-end.
- `anet license` / `anet activate` — placeholder commands for a future paid tier.
- `anet network create` and cross-user network sharing — V3 multi-network code is in but not E2E regressed.
- The hosted `agent-net.vansin.me` demo — local / LAN is the supported path today.
:::

## Next

- [Dashboard guide](/en/guide/dashboard)
- [CLI reference](/en/guide/cli)
- [Agent Node](/en/guide/agent-node)
- [Architecture](/en/guide/architecture)

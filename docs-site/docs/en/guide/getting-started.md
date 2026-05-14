# Getting Started

This is the current minimal local path for the stable packages. The flow follows the v2/v3 Docker + Playwright E2E path: install CLI, start Hub, start Dashboard, log in, create a node, start it.

::: tip Component versions (v0.8.2 stable, npm `latest` tag)
This page touches four npm packages. Their responsibilities:

| Package | Version | Purpose |
|---|---|---|
| `@sleep2agi/agent-network` | 2.1.7 | `anet` CLI (start hub / dashboard, manage nodes) |
| `@sleep2agi/commhub-server` | 0.8.0 | Hub: MCP + REST + SSE, SQLite persistence |
| `@sleep2agi/agent-network-dashboard` | 0.4.2 | Web Dashboard |
| `@sleep2agi/agent-node` | 2.3.0 | Agent runtime |

> "Purpose" is what each package does in the stack. For user **RBAC roles** (owner/admin/member/viewer), see [Roles & Permissions](/en/concepts/roles).
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

::: warning Change the default password before exposing publicly
The default `admin / anethub` is fine only for local quick-start. **For any `--host 0.0.0.0` / public deployment, run `anet passwd` immediately** to set a strong password (≥ 8 chars + not in the weak-password dictionary). You can also set your own credentials at bootstrap via `anet hub start --username alice --password 'your-strong-pass!'`.
:::

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
2. **`Select model:`** — choose from the verified model ids: `MiniMax-M2.7` / `intern-s1-pro` / `claude-sonnet-4-6` / `claude-opus-4-6` / `claude-haiku-4-5`, or `custom` to enter your own base URL + model. The CLI auto-injects the matching `ANTHROPIC_BASE_URL` (except `custom`, which you fill in), then prompts for the API key. Other providers (DeepSeek / GLM / Kimi / Xiaomi MiMo / OpenRouter, etc.) go through `custom` — see [Multi-model](/en/guide/multi-model) for the full endpoint table.

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

`my-bot` discovers `video-bot` via the commhub MCP `get_all_status` tool, dispatches the question with `send_task`, and polls the sub-task result with `get_task`. When `parent_task_id` is set, the Agent Node wrapper also chains the child result back to the upstream task. The Tasks and Messages pages show the full handshake live.

## 9. LAN access (another machine joins the same hub)

By default `anet hub start` binds to localhost only. To let other machines join over LAN, start the hub with an explicit LAN bind:

```bash
anet hub start --host 0.0.0.0
```

On another machine:

```bash
npm install -g @sleep2agi/agent-network

# One step — sets hub URL and logs in at the same time (recommended; matches setup-anet.sh / hub-only.sh)
anet login --hub http://<HUB-LAN-IP>:9200 --username admin --password anethub

anet node create remote-bot
anet node start remote-bot
```

::: tip Two-step equivalent
You can also do this in two commands: `anet init --hub http://<HUB-LAN-IP>:9200` to save the hub URL, then `anet login --username admin --password anethub` to authenticate. `init` saves config without logging in — useful for scripted setups or when you want to keep an existing credential.
:::

`remote-bot` shares the same hub as your local agents.

## Verified vs unverified

::: info Verified (v0.8.2 stable — inherits the v2 E2E coverage plus new v0.8 regressions)
- `anet hub start` with auto-default-admin
- `anet hub dashboard`
- `anet login` / `anet register` / `anet logout` / `anet whoami`
- `anet node create / start / delete / ls` — the `claude-agent-sdk` runtime + CLI flow itself is verified; at the vendor level only **Anthropic / MiniMax / InternLM / OpenRouter** are verified, while **DeepSeek / GLM / Kimi / Xiaomi MiMo** are presets tagged `[UNVERIFIED]` in cli.ts `MODEL_PRESETS` — endpoint URLs filled in but no real-API regression run yet (see [runtimes — Verified vs not](/en/guide/runtimes#verified-vs-not) + [full provider table](/en/guide/multi-model))
- Dashboard chat: markdown, Enter-to-send, optimistic echo, source labels, failure rendering, persistent history
- Multi-agent coordination via `get_all_status` + `send_task` + `get_task`, with `parent_task_id` chaining handled by the Agent Node wrapper
- LAN-shared hub
:::

::: warning Not verified (treat as experimental)
- `codex-sdk` runtime end-to-end.
- `claude-code-cli` runtime end-to-end.
- `anet license` / `anet activate` — v0.6 legacy trial commands, **no longer needed after Apache 2.0 OSS**. The current Hub still keeps a SQLite licenses table + creates a 14-day trial (checked on `send_task`); on `license_expired` see [troubleshooting](/en/troubleshooting).
- `anet network create` and cross-user network sharing — V3 multi-network code is in but not E2E regressed.
:::

::: tip No hosted service
The project direction is **Apache 2.0 open source + self-hosted + courses / consulting** — **there is no SaaS-hosted offering**. For production go through [Docker](/en/deploy/docker) or [Production deployment](/en/deploy/production).
:::

## Next

**Hands-on demos**:
- [Hello World](/en/cases/hello-world) — 6 steps to your first agent cluster
- [Debate](/en/cases/debate) — 6 agents in one command
- [Telegram squad](/en/cases/telegram-squad) — full Docker Compose stack

**Dig into commands**:
- [CLI reference](/en/guide/cli) — every anet command
- [Agent Node](/en/guide/agent-node) — config.json fields
- [Multi-model](/en/guide/multi-model) — DeepSeek / Kimi / Claude

**Production + security**:
- [Dashboard guide](/en/guide/dashboard) — Web UI monitoring
- [Architecture](/en/guide/architecture) — system design
- [Production deployment](/en/deploy/production) — TLS / firewall / backups
- [v0.7 → v0.8 upgrade](/en/guide/upgrade#v0-7-v0-8-upgrade-notes-latest) — behavior changes and migration

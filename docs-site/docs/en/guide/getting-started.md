# Getting Started (first-time install)

This page is the **first-time install** path for current stable (v0.10.13) — every step is Playwright + Docker E2E verified. The flow follows the v2/v3 Docker + Playwright E2E path: install CLI, start Hub, start Dashboard, log in, create a node, start it.

::: tip Which path should you follow?
- **First-time install**: continue with this page from step 0 to step 10.
- **Already have anet installed**: use the [Upgrade Guide](/en/guide/upgrade). In most cases, run `anet upgrade`, then `anet project restart`.
- **Very old versions (2.2.4 or earlier)**: run `npm install -g @sleep2agi/agent-network@latest` once, then use `anet upgrade` going forward.
:::

::: details Component responsibilities
This page touches four npm packages. Exact patch versions follow the npm `latest` tag, so this page avoids hardcoding them.

| Package | Purpose |
|---|---|
| `@sleep2agi/agent-network` | `anet` CLI (start hub / dashboard, manage nodes) |
| `@sleep2agi/commhub-server` | Hub: MCP + REST + SSE, SQLite persistence |
| `@sleep2agi/agent-network-dashboard` | Web Dashboard |
| `@sleep2agi/agent-node` | Agent runtime |

> "Purpose" is what each package does in the stack. For user **RBAC roles** (owner/admin/member/viewer), see [Roles & Permissions](/en/concepts/roles).
:::

## 0. Prerequisites

| Dependency | Version |
|---|---|
| Node.js | ≥ 22.13.0 (`@sleep2agi/agent-network` `engines.node`) |
| Bun | ≥ 1.2.0 (required by `commhub-server`) |

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

::: tip Stop / check status (v0.10.11+)
```bash
anet hub status                # Show PID / port / commhub-server version (via /health)
anet hub stop                  # Graceful shutdown: SIGTERM → 3s grace → SIGKILL fallback
anet hub stop --port 9201      # Specify a non-default port
```
No more manual `lsof -i :9200` + `kill <PID>` (the workaround users needed before v0.10.11 [#200](https://github.com/sleep2agi/agent-network/issues/200)).
:::

## 3. Start the Dashboard

Open a second terminal and **keep it open**:

```bash
anet hub dashboard
```

Open `http://localhost:3000` in a browser, log in with `admin / anethub` (the default — change it via `anet passwd` after).

Pages: Overview / Nodes / Tasks / Messages / Chat / Admin / Settings. The Chat page renders markdown, sends on Enter, shows source labels (`You` / `↳ peer-agent`), and persists history across reloads.

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

You'll get an interactive picker — **vendor first, then model**:

1. **Pick the vendor** — choose from the built-in `VENDORS` list: InternLM / MiniMax / Xiaomi MiMo / Anthropic Claude / Codex / Claude Code CLI / custom. **The runtime is derived from the vendor** (InternLM / MiniMax / Xiaomi / Anthropic → `claude-agent-sdk`; Codex → `codex-sdk`; Claude Code → `claude-code-cli`).
2. **Pick the model** — once a vendor is chosen, the CLI lists that vendor's available models (vendors with a single model are auto-selected; Claude Code CLI uses the subscription's model, so no model picker). The CLI then auto-injects the matching `ANTHROPIC_BASE_URL` and prompts for the API key. The `custom` vendor asks you for the base URL + model id — DeepSeek / GLM / Kimi / OpenRouter and other providers not in the built-in list go through `custom`; see [Multi-model](/en/guide/multi-model) for the full endpoint table.

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

## 9. Manage every node under cwd at once (v0.9.0+)

Once you have multiple nodes, running `anet node start/stop` for each name gets tedious. Since v0.9.0 you can manage everything under cwd's `.anet/nodes/` in one shot via `anet project` (from [#117](https://github.com/sleep2agi/agent-network/issues/117)):

```bash
# Start everything (already-running gets skipped — ▶ started / ⏭ already-running)
anet project up

# Kill every tmux + start fresh (use this after a reboot)
anet project restart

# Stop everything + notify the hub (the down path caps offline-notify at 2s so a crashed-hub teardown doesn't deadlock)
anet project down
```

Two coupled features make 22-node reboot recovery **zero-keystroke**:

- `anet project up` spawns each node in a detached tmux session; running `anet node start <alias>` directly defaults to foreground (add `--tmux` for attached mode)
- Startup auto-skips Claude Code's "Resume from summary / full" prompt — no per-node keystroke

::: details Why / historical detail
- `anet project up` calls `startNodeTmuxSession()` internally to spawn each node detached ([#117](https://github.com/sleep2agi/agent-network/issues/117))
- Direct `anet node start <alias>` foregrounds since v0.9.2 ([#136](https://github.com/sleep2agi/agent-network/issues/136) reverted the brief v0.9.0 #122 default-detached behavior because macOS bun triggered `setRawMode errno 5`)
- Startup injects `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999` ([#115](https://github.com/sleep2agi/agent-network/issues/115)) so Claude Code skips the resume prompt
:::

Common options:

| Option | Default | Description |
|------|------|------|
| `--stagger <seconds>` | `3` | Delay between nodes (gives the hub room to breathe during a startup burst) |
| `--only a,b,c` | — | Operate only on the listed aliases / node IDs |
| `--exclude x,y` | — | Skip the listed aliases / node IDs |

Full reference: [CLI Reference — Project-wide](/en/guide/cli#project-wide-cwd).

## 10. LAN access (another machine joins the same hub)

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

::: info Verified (current stable)
The following paths are covered by the stable release gate. For details, see the [Changelog](/en/changelog) and [test reports](https://github.com/sleep2agi/agent-network/tree/main/docs/tests).
- `anet hub start` with auto-default-admin
- `anet hub dashboard`
- `anet login` / `anet register` / `anet logout` / `anet whoami`
- `anet node create / start / delete / ls` — the `claude-agent-sdk` runtime + CLI flow itself is verified; at the vendor level the `anet node create` `VENDORS` list — **Anthropic / MiniMax / InternLM / Xiaomi MiMo** — each entry is verified-with-real-call before it lands; **DeepSeek / GLM / Kimi / OpenRouter** are NOT in the `VENDORS` list, reach them via the `custom` vendor and verify yourself (see [runtimes — Verified vs not](/en/guide/runtimes#verified-vs-not) + [full provider table](/en/guide/multi-model))
- Dashboard chat: markdown, Enter-to-send, optimistic echo, source labels, failure rendering, persistent history
- Multi-agent coordination via `get_all_status` + `send_task` + `get_task`, with `parent_task_id` chaining handled by the Agent Node wrapper
- LAN-shared hub
:::

::: warning Not verified (treat as experimental)
- `codex-sdk` runtime end-to-end.
- `claude-code-cli` runtime end-to-end.
- `anet license` / `anet activate` — v0.6 legacy trial commands. **Apache 2.0 OSS users don't need to touch these**; `anet license` still exists and prints something like `License: PRO / Expires <date>` — that's just the Hub-side v0.6 trial-table rolling 14-day renewal echoing back for backward-compat, **unrelated to your OSS usage**, ignore it (full cleanup queued for v0.11+). On `license_expired` see [troubleshooting](/en/troubleshooting).
- `anet network create` and cross-user network sharing — V3 multi-network code is in but not E2E regressed.
:::

::: tip No hosted service
The project direction is **Apache 2.0 open source + self-hosted + courses / consulting** — **there is no SaaS-hosted offering**. For production go through [Docker](/en/deploy/docker) or [Production deployment](/en/deploy/production).
:::

## Next

**Hands-on demos** (one command spins up a ready-made agent team):

```bash
anet demo                  # list available demos
anet demo sci-team         # 4-role research team (PI / engineer / reviewer / doc-writer)
anet demo pr-review        # 3-role PR review squad
```

**Dig into commands**:
- [CLI reference](/en/guide/cli) — every anet command
- [Agent Node](/en/guide/agent-node) — config.json fields
- [Multi-model](/en/guide/multi-model) — DeepSeek / Kimi / Claude

**Production + security**:
- [Dashboard guide](/en/guide/dashboard) — Web UI monitoring
- [Architecture](/en/guide/architecture) — system design
- [Production deployment](/en/deploy/production) — TLS / firewall / backups
- [Upgrade guide](/en/guide/upgrade) — any older release → latest via one `anet upgrade`

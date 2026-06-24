# Agent Network (`anet`)

[![npm version](https://img.shields.io/npm/v/@sleep2agi/agent-network.svg)](https://www.npmjs.com/package/@sleep2agi/agent-network)
[![npm downloads](https://img.shields.io/npm/dm/@sleep2agi/agent-network.svg)](https://www.npmjs.com/package/@sleep2agi/agent-network)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/sleep2agi/agent-network/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-anet.sh-009e7e.svg)](https://anet.sh)

Run a local network of AI agents from one CLI.

`anet` starts a CommHub, launches the web dashboard, creates agent nodes, and lets those nodes talk to each other through MCP tools such as `send_task`, `get_task`, and `get_all_status`.

## What It Is

Agent Network is a local-first multi-agent runtime:

- **CommHub**: MCP + REST + SSE hub for task routing, auth, networks, and status.
- **Agent nodes**: long-running AI workers backed by Claude Code, Claude Agent SDK, Codex SDK, or Grok Build ACP.
- **Dashboard**: browser UI for topology, chat, tasks, node health, and server telemetry.
- **CLI**: `anet`, the single entry point for setup, auth, node lifecycle, and demos.

The default path runs entirely on your machine. LAN sharing is opt-in.

## Requirements

- Node.js **>= 22.13.0**
- npm **>= 10**
- Bun **>= 1.2.0** (`anet hub start` lazy-runs the Bun-based CommHub server)
- macOS or Linux

Install Bun if needed:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Install

Stable:

```bash
npm install -g @sleep2agi/agent-network
anet -v
```

Preview channel:

```bash
npm install -g @sleep2agi/agent-network@preview
anet -v
```

Current npm dist-tags verified on 2026-05-28 (v0.10.11 stable):

| Package | latest | preview |
|---|---:|---:|
| `@sleep2agi/agent-network` | `2.2.10` | `2.2.10-preview.3` |
| `@sleep2agi/commhub-server` | `0.8.4` | `0.8.4-preview.1` |
| `@sleep2agi/agent-network-dashboard` | `0.5.6` | `0.5.7-preview.2` |
| `@sleep2agi/agent-node` | `2.4.7` | `2.4.8-preview.0` |

## 5-Minute Quick Start

Open three terminals.

### 1. Start CommHub

```bash
anet hub start
```

Default local URL:

```text
http://127.0.0.1:9200
```

By default the hub binds to localhost. Use `--host 0.0.0.0` only when you intentionally want LAN clients to connect.

### 2. Start Dashboard

```bash
anet hub dashboard
```

Open:

```text
http://localhost:3000
```

### 3. Log In, Create A Node, Start It

```bash
anet login --username admin --password anethub
anet node create my-bot
anet node start my-bot
```

`anet node create` walks you through:

1. Runtime: `claude-code-cli`, `claude-agent-sdk`, `codex-sdk`, or `grok-build-acp`.
2. Provider preset: Anthropic, MiniMax, InternLM, Xiaomi MiMo, or `custom` (any Anthropic-compatible endpoint — used for DeepSeek / GLM / Kimi / OpenRouter etc.; codex-sdk for OpenAI Codex; grok-build-acp for xAI Grok).
3. API key and model settings.

When the node starts successfully, look for:

```text
SSE connected
```

Then use the Dashboard chat panel to send `my-bot` a message.

## Multi-Agent Collaboration

Create a second node:

```bash
anet node create reviewer
anet node start reviewer
```

Ask `my-bot`:

```text
Ask reviewer to review this plan and summarize the risks.
```

The first agent can discover peers with `get_all_status`, delegate work with `send_task`, poll with `get_task`, and integrate the reply. The dashboard Tasks and Messages views show the chain.

## LAN Hub

On the hub machine:

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

Do not expose the hub directly to the public internet without a reverse proxy, HTTPS, firewall rules, and reviewed auth settings.

## Runtimes

| Runtime | Use When | Notes |
|---|---|---|
| `claude-code-cli` | You want Claude Code CLI sessions and channel support | Uses Claude Code process; supports stable `COMMHUB_RESUME_ID` in recent previews |
| `claude-agent-sdk` | You want Anthropic-compatible API providers | Good default for provider presets |
| `codex-sdk` | You want Codex-backed nodes | Useful as a backup runtime when Claude quota is constrained |
| `grok-build-acp` | You want Grok Build through `grok agent stdio` | Requires Grok Build CLI auth; stable for receive/reply, session persistence, and explicit `send_task` delegation |

### Grok Build ACP

`grok-build-acp` uses the local Grok Build CLI via Agent Client Protocol (ACP). Install and authenticate Grok first:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok
```

Create and start a node:

```bash
anet node create grok-demo --runtime grok-build-acp
anet node start grok-demo
```

Look for:

```text
runtime: grok-build-acp
SSE connected
```

Stable support:

- Receive CommHub tasks through SSE.
- Run one Grok Build ACP turn per task.
- Persist `grokSession` into `.anet/nodes/<name>/config.json`.
- Resume the saved Grok session on the next task.
- Reply to the original sender through CommHub.
- Explicit delegation such as `给 A站助手 发任务: ...` is intercepted by `agent-node`, sent through CommHub with `parent_task_id`, and polled until the child task reaches `replied` or `failed`.

Current boundary:

- Grok native MCP tool injection is not the stable path yet.
- For cross-agent delegation, use explicit delegation wording so `agent-node` handles the CommHub call deterministically.
- If Grok returns `grok ACP error -32603`, upgrade to the latest `@sleep2agi/agent-node` and restart the node; recent builds narrow ACP capabilities and include `error.data` diagnostics.

Details: `docs/grok-build-runtime.md`.

## Provider Presets

`anet node create` writes the correct provider environment into `.anet/nodes/<name>/config.json`.

| Provider | Status | Notes |
|---|---|---|
| Anthropic | verified path | Native Anthropic Messages API |
| MiniMax | verified path | Anthropic-compatible endpoint |
| DeepSeek | verified path | Anthropic-compatible endpoint |
| GLM / Zhipu | verified path | Anthropic-compatible endpoint |
| Kimi / Moonshot | verified path | Anthropic-compatible endpoint |
| OpenRouter | available | Anthropic-compatible routing |
| Custom | available | Provide base URL, model, and token |

## Common Commands

```bash
# Hub and dashboard
anet hub start
anet hub dashboard

# Auth
anet register
anet login --username <user> --password <password>
anet logout
anet whoami
anet passwd

# Nodes
anet node create <name>
anet node start <name>
anet node start --all
anet node stop <name>
anet node resume <name>
anet node rename <old> <new> --force
anet node delete <name>
anet node ls
anet info <name>
anet logs <name>

# Network status and repair
anet status
anet tasks [status]
anet doctor
anet doctor --fix

# Project and session helpers
anet init --hub <url>
anet init project
anet project up
anet project restart
anet project down
anet session ls

# Channels and upgrades
anet channel add telegram <name> --bot-token <tok> --allow <uid>
anet channel add feishu   <name> --app-id <id> --app-secret <secret> --allow <open-id>   # see docs/feishu-quickstart.md
anet channel ls
anet upgrade
anet upgrade --channel preview --dry-run

# Batch / demos
anet create --batch
anet batch list
anet batch stop <prefix>
anet demo sci-team
```

## Configuration Files

```text
~/.anet/config.json
  Global CLI profile: hub URL, user token, default network.

~/.anet/server/admin-utok.json
  Local bootstrap admin token for the hub.

{project}/.anet/nodes/<name>/config.json
  Per-node runtime, model, provider env, node token, channels, and session IDs.
```

Example node config:

```json
{
  "node_id": "n_a1b2c3d4",
  "node_name": "my-bot",
  "alias": "my-bot",
  "hub": "http://127.0.0.1:9200",
  "network_id": "default",
  "token": "ntok_...",
  "runtime": "claude-agent-sdk",
  "model": "your-model",
  "channels": ["server:commhub"],
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  "env": {
    "ANTHROPIC_BASE_URL": "https://example.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-..."
  },
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process",
    "maxTurns": 50
  }
}
```

Do not commit `.anet/` or provider API keys.

## Security Notes

- The hub binds to `127.0.0.1` by default.
- LAN mode is explicit: `anet hub start --host 0.0.0.0`.
- Node tokens are network-scoped `ntok_` tokens; user tokens are `utok_`.
- Keep API keys in local node config or env refs; never paste real keys into issues or docs.
- Treat tmux / terminal streaming features as local-admin tools.

## What Is Stable vs Experimental

Stable day-to-day path:

- `anet hub start` / `anet hub stop` / `anet hub status` (v0.10.11+: SIGTERM → 3s grace → SIGKILL stop; status shows PID + port + `/health` version — no more manual `lsof+kill`)
- `anet hub dashboard`
- `anet login`
- `anet node create/start/stop/delete/rename`
- `anet node start --all`
- `anet project up/restart/down`
- Dashboard chat, task list, topology, and status views

Actively evolving:

- IM platform integration (Feishu / Slack / WhatsApp / WeCom)
- Telegram channel binding
- Advanced dashboard topology edges
- Batch orchestration and science-team demos
- Codex runtime expansion
- Grok Build ACP runtime
- Cross-version rename hot-reload

## Documentation

- Docs site: https://anet.sh
- Getting started: https://anet.sh/guide/getting-started
- Preview guide: https://anet.sh/guide/preview/getting-started
- Issues: https://github.com/sleep2agi/agent-network/issues

## Repository Layout

This package lives in the `agent-network/` subdirectory of the monorepo:

```text
agent-network/
  bin/cli.ts           anet CLI
  src/client.ts        SDK client
  src/node-server.ts   CommHub MCP server bridge used by claude-code-cli
  src/im/              IM integration contracts and future adapters
```

Related packages live next to it:

```text
server/                @sleep2agi/commhub-server
agent-node/            @sleep2agi/agent-node
docs-site/             anet.sh documentation site
```

## License

Apache-2.0

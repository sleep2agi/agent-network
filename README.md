# Agent Network

Local-first multi-agent collaboration. One npm package, one local hub, a Web Dashboard, and as many agents as you want — all on your own machine, optionally shared across a LAN.

**v2.0.0 stable** — verified end-to-end via Playwright + Docker E2E. The CLI, hub, dashboard, and agent runtime are published on npm and the local flow is supported. Production hosting and a paid tier are explicitly not in scope right now.

## 30-second tour (verified)

```bash
# 1. Install the CLI (one global package)
npm install -g @sleep2agi/agent-network

# 2. Start the hub (terminal 1, keep open)
anet hub start
# - listens on http://127.0.0.1:9200
# - SQLite at ~/.commhub/commhub.db
# - default account auto-created: admin / anethub

# 3. Start the dashboard (terminal 2, keep open)
anet hub dashboard
# - browser at http://localhost:3000

# 4. CLI login + create + start an agent (terminal 3)
anet login --username admin --password anethub
anet node create my-bot          # two-step picker: runtime, then provider
anet node start my-bot           # SSE connected → ready

# 5. Send a task from the Dashboard's Chat panel
```

Spin up a second node and ask the first one to delegate — agents discover each other through the commhub MCP toolset and coordinate over `send_task` / `get_task`.

Full walkthrough: [docs-site/docs/guide/getting-started.md](docs-site/docs/guide/getting-started.md) (live at https://anet.vansin.me/guide/getting-started).

## Packages

| Package | Version | Role |
|---|---|---|
| [`@sleep2agi/agent-network`](https://www.npmjs.com/package/@sleep2agi/agent-network) | 2.0.0 | `anet` CLI — hub / dashboard launchers, node management |
| [`@sleep2agi/commhub-server`](https://www.npmjs.com/package/@sleep2agi/commhub-server) | 0.5.0 | MCP + REST + SSE hub, SQLite-backed |
| [`@sleep2agi/agent-network-dashboard`](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard) | 0.1.0 | Web UI: Chat / Nodes / Tasks / Messages / Networks / Logs / Admin |
| [`@sleep2agi/agent-node`](https://www.npmjs.com/package/@sleep2agi/agent-node) | 2.1.1 | Agent runtime — `claude-agent-sdk` (verified), `codex-sdk`, `claude-code-cli` |

## Architecture

```
┌──────────┐   send_task   ┌────────────────┐   SSE push   ┌──────────┐
│ Agent A  │ ────────────→ │ CommHub        │ ───────────→ │ Agent B  │
│          │ ←──────────── │ Server (:9200) │ ←─────────── │          │
└──────────┘     reply     └───────┬────────┘    report    └──────────┘
                                   │
                          ┌────────┴────────┐
                          │ Dashboard       │
                          │ (:3000)         │
                          └─────────────────┘
```

- **MCP Streamable HTTP** (`/mcp`) — agent and Claude Code / Codex entry point
- **SSE Push** (`/events/:alias`) — push tasks to agents in real time
- **REST** (`/api/*`) — Dashboard, admin, monitoring

## Verified runtimes / providers

| Runtime | Status | Providers in the picker |
|---|---|---|
| `claude-agent-sdk` | verified | Anthropic, MiniMax, DeepSeek, GLM, Kimi, OpenRouter, custom Anthropic-compatible |
| `codex-sdk` | unverified (no full E2E) | OpenAI GPT-5 / o3 via `codex auth login` |
| `claude-code-cli` | unverified (no full E2E) | Claude Pro subscription |

## Repo layout

```
agent-network/   anet CLI (npm: @sleep2agi/agent-network)
agent-node/      agent runtime (npm: @sleep2agi/agent-node)
server/          CommHub server (npm: @sleep2agi/commhub-server)
channel/         Claude Code channel plugin
docs-site/       VitePress docs (https://anet.vansin.me)
docs/            design notes, RFCs
tests/           Docker test matrix
```

The Dashboard repo is separate: [sleep2agi/agent-network-dashboard](https://github.com/sleep2agi/agent-network-dashboard).

## Not verified yet

These commands or paths exist in the codebase but are explicitly **not** part of the v2.0.0 supported flow:

- `anet quickstart` — removed from the docs; use the explicit `anet hub start` + `anet node create` steps above.
- `anet license` / `anet activate` — placeholders for a future paid tier.
- `anet network create` and cross-user network sharing — V3 multi-network code is in but not E2E regressed.
- Cloud-hosted hub at `agent-net.vansin.me` — planned demo, local / LAN is the supported deployment today.

## Docs

- [docs-site](docs-site/) — VitePress source for https://anet.vansin.me
- [agent-network/README.md](agent-network/README.md) — CLI reference
- [server/README.md](server/README.md) — hub MCP tools + REST endpoints
- [agent-node/README.md](agent-node/README.md) — runtime + provider configuration

## License

MIT

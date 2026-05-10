# Agent Network

<img width="1774" height="887" alt="image" src="https://github.com/user-attachments/assets/6bdaaa9e-969d-410c-8b48-57355e16454f" />


Local-first multi-agent collaboration. One npm package, one local hub, a Web Dashboard, and as many agents as you want — all on your own machine, optionally shared across a LAN.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/@sleep2agi/agent-network.svg)](https://www.npmjs.com/package/@sleep2agi/agent-network)
[![Docs](https://img.shields.io/badge/docs-anet.sh-009e7e.svg)](https://anet.sh)

📖 **完整文档：[anet.sh](https://anet.sh)** · 📦 **npm 包：[@sleep2agi](https://www.npmjs.com/org/sleep2agi)**

## 30-second tour

```bash
# 1. Install the CLI (one global package)
npm install -g @sleep2agi/agent-network

# 2. Start the hub (terminal 1, keep open)
anet hub start
# - listens on http://127.0.0.1:9200 by default
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

📖 Full walkthrough: <https://anet.sh/guide/getting-started>

## One-line demos

```bash
export MINIMAX_KEY=sk-cp-xxx

# 6 agents debate — about 10 minutes
anet demo debate --topic "AI 创造的岗位是否比消灭的多"

# 4 agents content factory — about 3 minutes
anet demo socialmedia --topic "AI 时代如何提升专注力" --platform xiaohongshu
```

Each demo runs in an isolated network and cleans up afterward, so it does **not** pollute your `default` network.

## Packages (v2.1 stable)

| Package | Version | Role |
|---|---|---|
| [`@sleep2agi/agent-network`](https://www.npmjs.com/package/@sleep2agi/agent-network) | 2.1.0 | `anet` CLI — hub / dashboard / agent / demo launcher |
| [`@sleep2agi/commhub-server`](https://www.npmjs.com/package/@sleep2agi/commhub-server) | 0.6.0 | MCP + REST + SSE hub (SQLite / optional PostgreSQL) |
| [`@sleep2agi/agent-network-dashboard`](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard) | 0.3.0 | Web UI (Next.js, 4 themes) — Chat / Nodes / Tasks / Networks / Logs / Admin |
| [`@sleep2agi/agent-node`](https://www.npmjs.com/package/@sleep2agi/agent-node) | 2.3.0 | Agent runtime — Claude Code CLI / Claude Agent SDK / Codex SDK |

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

📖 Architecture deep dive: <https://anet.sh/guide/architecture>

## Runtimes & providers

| Runtime | Status | Providers in the picker |
|---|---|---|
| `claude-agent-sdk` | verified | Anthropic / MiniMax / DeepSeek / GLM / Kimi / 书生 InternLM / OpenRouter / custom Anthropic-compatible |
| `codex-sdk` | unit-tested (no full E2E) | OpenAI Codex via `codex auth login` |
| `claude-code-cli` | unverified (no full E2E) | Local Claude Pro subscription |

📖 Runtime deep dive: <https://anet.sh/guide/runtimes>

## Repo layout

```
agent-network/   anet CLI       (npm: @sleep2agi/agent-network)
agent-node/      agent runtime  (npm: @sleep2agi/agent-node)
server/          CommHub server (npm: @sleep2agi/commhub-server)
channel/         Claude Code channel plugin
docs-site/       VitePress source for https://anet.sh
docs/            design notes, RFCs
tests/           Docker test matrix
```

The Dashboard lives in a separate repo: [sleep2agi/agent-network-dashboard](https://github.com/sleep2agi/agent-network-dashboard).

## Docs

- 📖 [anet.sh](https://anet.sh) — main documentation site
- 📦 [@sleep2agi on npm](https://www.npmjs.com/org/sleep2agi) — package index
- 💬 [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) — questions, ideas
- 🐛 [GitHub Issues](https://github.com/sleep2agi/agent-network/issues) — bug reports
- 🔒 [Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new) — vulnerabilities

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, branching, and PR conventions. By contributing you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[Apache-2.0](./LICENSE) © 2025-2026 sleep2agi

<p align="center">
  <img width="1774" height="887" alt="Agent Network" src="https://github.com/user-attachments/assets/6bdaaa9e-969d-410c-8b48-57355e16454f" />
</p>

<h1 align="center">Agent Network</h1>

<p align="center">
  Local-first multi-agent collaboration. One npm package — one local hub, a Web Dashboard, and as many agents as you want, all on your own machine and optionally shared across a LAN.
</p>

<p align="center">
  <strong>多 Agent，一行命令。让 Claude / GPT / MiniMax / DeepSeek / GLM / Kimi / 书生 在你电脑上一起干活。</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License"></a>
  <a href="https://www.npmjs.com/package/@sleep2agi/agent-network"><img src="https://img.shields.io/npm/v/@sleep2agi/agent-network.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@sleep2agi/agent-network"><img src="https://img.shields.io/npm/dm/@sleep2agi/agent-network.svg" alt="npm downloads"></a>
  <a href="https://anet.sh"><img src="https://img.shields.io/badge/docs-anet.sh-009e7e.svg" alt="Docs"></a>
  <a href="https://github.com/sleep2agi/agent-network"><img src="https://img.shields.io/github/stars/sleep2agi/agent-network?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <strong><a href="https://anet.sh">📖 文档 / Docs</a></strong> ·
  <strong><a href="https://www.npmjs.com/org/sleep2agi">📦 NPM</a></strong> ·
  <strong><a href="https://github.com/sleep2agi/agent-network">⭐ GitHub</a></strong> ·
  <strong><a href="https://github.com/sleep2agi/agent-network/discussions">💬 Discussions</a></strong>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">中文</a>
</p>

---

## Why Agent Network

- **One CLI, three runtimes.** Run Claude Code CLI, the Claude Agent SDK, and OpenAI's Codex SDK side-by-side on the same hub. Mix-and-match per role.
- **Seven LLM providers, one config switch.** Anthropic, OpenAI, MiniMax, DeepSeek, GLM (智谱), Kimi (Moonshot), and 书生 InternLM — all routed through `ANTHROPIC_BASE_URL`.
- **Local-first.** Hub binds to `127.0.0.1` by default. SQLite at `~/.commhub/commhub.db`. No cloud account, no telemetry, no signup.
- **Mesh dispatch out of the box.** Agents discover each other via 18 MCP tools (`get_all_status`, `send_task`, `get_task`, …) and coordinate without you scripting the choreography.
- **Web Dashboard included.** Chat, Nodes, Tasks, Messages, Networks, Logs, Admin — Next.js app, 4 themes, runs at `localhost:3000`.
- **LAN-shareable.** `anet hub start --host 0.0.0.0` lets a teammate's agent join your hub from across the room.

> [!IMPORTANT]
> **Public beta.** Self-used daily for two months by the maintainer; v2.1 is the first stable open-source line. APIs may still shift between minor versions — pin your dependencies.
>
> **Safety disclaimer.** Each agent node runs with `dangerouslySkipPermissions: true` by default so it can call tools without prompting. Treat agents as untrusted code — run them in disposable working directories, not your `$HOME`. See [SECURITY.md](./SECURITY.md).

---

## 30-second quickstart

```bash
# Install one global package
npm install -g @sleep2agi/agent-network

# Terminal 1 — start the hub (keep open)
anet hub start
#   listens on http://127.0.0.1:9200
#   SQLite at ~/.commhub/commhub.db
#   default account auto-created: admin / anethub

# Terminal 2 — start the dashboard (keep open)
anet hub dashboard
#   open http://localhost:3000

# Terminal 3 — log in, create + start an agent
anet login --username admin --password anethub
anet node create my-bot          # two-step picker: runtime → provider → API key
anet node start my-bot           # waits for "SSE connected"
```

Send a task from the Dashboard's Chat panel. Spin up a second node and ask the first to delegate — the agents will discover each other and coordinate via MCP. That's it.

📖 Full walkthrough → <https://anet.sh/guide/getting-started>

---

## One-line demos

```bash
export MINIMAX_KEY=sk-cp-xxx

# 6 agents, 9-step debate, ~10 minutes
anet demo debate --topic "Will AI create more jobs than it destroys?"

# 4 agents, content factory, ~3 minutes
anet demo socialmedia --topic "Focus in the AI era" --platform xiaohongshu
```

Each demo runs in an isolated network and cleans up afterwards — your `default` network stays untouched.

---

## Packages

Stable, Apache-2.0, published to npm.

| Package | Version | Role |
|---|---|---|
| [`@sleep2agi/agent-network`](https://www.npmjs.com/package/@sleep2agi/agent-network) | `2.1.0` | `anet` CLI — hub / dashboard / agent / demo launcher |
| [`@sleep2agi/commhub-server`](https://www.npmjs.com/package/@sleep2agi/commhub-server) | `0.6.0` | MCP + REST + SSE hub (SQLite default, optional PostgreSQL) |
| [`@sleep2agi/agent-network-dashboard`](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard) | `0.3.0` | Web UI — Next.js, 4 themes, Chat / Nodes / Tasks / Networks / Logs / Admin |
| [`@sleep2agi/agent-node`](https://www.npmjs.com/package/@sleep2agi/agent-node) | `2.3.0` | Agent runtime — Claude Code CLI / Claude Agent SDK / Codex SDK |

The CLI auto-fetches the hub and node packages on first use via `bunx` / `npx`. You only ever globally install one package.

---

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

- **MCP Streamable HTTP** at `/mcp` — agents and Claude Code / Codex connect here
- **SSE Push** at `/events/:alias` — server pushes tasks to agents in real time
- **REST** at `/api/*` — Dashboard, admin, monitoring, audit log
- **18 MCP tools** — `send_task`, `get_task`, `send_reply`, `report_status`, `get_all_status`, …

📖 Architecture deep dive → <https://anet.sh/guide/architecture>

---

## Runtimes

Pick one per node. Mix freely on the same hub.

| Runtime | What it does | Best for | Auth |
|---|---|---|---|
| `claude-code-cli` | Spawns your local `claude` CLI as a subprocess | Reusing a Claude Pro subscription, full Claude Code tool suite | `claude` already logged in |
| `claude-agent-sdk` | Programmatic Anthropic-compatible client | Anthropic, MiniMax, DeepSeek, GLM, Kimi, InternLM via `ANTHROPIC_BASE_URL` | API key |
| `codex-sdk` | OpenAI's `@openai/codex-sdk` | Code generation, shell-heavy work | `codex auth login` or `OPENAI_API_KEY` |

📖 Runtime deep dive → <https://anet.sh/guide/runtimes>

---

## Verified providers

`claude-agent-sdk` is just an Anthropic Messages client — any compatible endpoint works.

| Provider | Status | `ANTHROPIC_BASE_URL` |
|---|---|---|
| Anthropic | verified | `https://api.anthropic.com` |
| MiniMax | verified | `https://api.minimaxi.com/anthropic` |
| DeepSeek | verified | (official Anthropic-compatible endpoint) |
| GLM 智谱 | verified | (open.bigmodel.cn Anthropic adapter) |
| Kimi (Moonshot) | verified | (platform.moonshot.cn Anthropic-compatible) |
| 书生 InternLM | verified | `https://chat.intern-ai.org.cn/anthropic` |
| OpenAI (via `codex-sdk`) | verified | n/a — OpenAI native |
| OpenRouter / custom Anthropic-compatible | works in dev, no E2E | provide base URL + token |

📖 Per-provider keys, models, and presets → <https://anet.sh/guide/multi-model>

---

## Repo layout

```
agent-network/   anet CLI         (npm: @sleep2agi/agent-network)
agent-node/      agent runtime    (npm: @sleep2agi/agent-node)
server/          CommHub server   (npm: @sleep2agi/commhub-server)
channel/         Claude Code channel plugin
docs-site/       VitePress source for https://anet.sh
docs/            design notes, RFCs, evolution log
tests/           Docker test matrix
```

The Dashboard lives in a separate repo: [sleep2agi/agent-network-dashboard](https://github.com/sleep2agi/agent-network-dashboard).

---

## Status & known limitations

What's solid, and what to watch out for.

**Stable and E2E-tested**

- `anet hub start` / `hub dashboard` / `login` / `register` / `whoami` / `logout`
- `anet node create / start / stop / delete / ls / logs`
- `claude-agent-sdk` with all six providers above (Docker E2E)
- Dashboard Chat — markdown, optimistic echo, source labels, error fallback, history persistence
- Multi-agent peer dispatch via `get_all_status` + `send_task` + `get_task`
- LAN-shared hub with `--host 0.0.0.0`

**Works, but not yet covered by full E2E**

- `claude-code-cli` runtime — runs locally; no automated regression yet
- `codex-sdk` runtime — unit-tested; live OAuth path not in CI
- `anet network create` and cross-user network sharing — code merged, no E2E
- `anet channel add telegram | wechat | feishu` — Telegram path is exercised, others are not

**Not yet implemented**

- `anet license` / `anet activate` — placeholders for a future paid tier
- Hosted hub / public demo site — local + LAN only for now

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, branch naming, and the test matrix layout. By contributing you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

The fastest way to help right now: try the [30-second quickstart](#30-second-quickstart) and file anything that surprised you in [Discussions](https://github.com/sleep2agi/agent-network/discussions) or [Issues](https://github.com/sleep2agi/agent-network/issues).

---

## Security

Found a vulnerability? Please **don't** open a public issue. Use [GitHub Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new) instead. See [SECURITY.md](./SECURITY.md) for the disclosure policy and threat model notes (especially around `dangerouslySkipPermissions` and LAN-exposed hubs).

---

## Resources

- [anet.sh](https://anet.sh) — full documentation site
- [Getting started](https://anet.sh/guide/getting-started) — verified end-to-end path
- [Runtimes](https://anet.sh/guide/runtimes) — Claude Code CLI vs Agent SDK vs Codex
- [Architecture](https://anet.sh/guide/architecture) — MCP, SSE, REST, SQLite schema
- [@sleep2agi on npm](https://www.npmjs.com/org/sleep2agi) — package index
- [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) — questions, ideas
- [GitHub Issues](https://github.com/sleep2agi/agent-network/issues) — bug reports

---

## Join us / 加入社群

Scan the QR code to join the **Agent Network 社区交流群** on WeChat — design discussions, troubleshooting, weekly updates.

<p align="center">
  <img src="https://anet.sh/community/wechat-group.jpg" alt="Agent Network WeChat group" width="320">
</p>

> The QR rotates every 7 days. If it's expired, the freshest one is always at <https://anet.sh/community/wechat-group.jpg>.

Prefer English / async? Use [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions).

---

## Credits

Built and maintained by [@sleep2agi](https://github.com/sleep2agi). If your team relies on this and wants to support development or sponsor a feature, open an issue tagged `sponsor` — happy to talk.

## License

[Apache-2.0](./LICENSE) © 2025–2026 sleep2agi contributors

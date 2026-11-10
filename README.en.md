<div align="center">

<a href="https://anet.sh/en/"><img src="docs/assets/readme/hero-en.jpg" alt="Agent Network: one person, a whole agent team. Chat with Claude, Codex, Grok and OpenCode nodes like teammates" width="100%"></a>

<p>
<a href="https://www.anet.sh/en/download"><img alt="Desktop" src="https://img.shields.io/github/v/release/sleep2agi/agent-network-app?display_name=release&label=download&color=1b65db&style=for-the-badge&labelColor=0b1220"></a>
<a href="https://www.npmjs.com/package/@sleep2agi/agent-network"><img alt="npm" src="https://img.shields.io/npm/v/@sleep2agi/agent-network/preview?label=npm&color=1b65db&style=for-the-badge&labelColor=0b1220"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache_2.0-38c8e0?style=for-the-badge&labelColor=0b1220"></a>
<a href="https://github.com/sleep2agi/agent-network/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/sleep2agi/agent-network?color=38c8e0&style=for-the-badge&labelColor=0b1220"></a>
<a href="https://anet.sh/en/"><img alt="Docs" src="https://img.shields.io/badge/docs-anet.sh-38c8e0?style=for-the-badge&labelColor=0b1220"></a>
</p>

**[🌐 Website](https://anet.sh/en/) · [⬇️ Download the desktop app](https://www.anet.sh/en/download) · [🚀 Get started](https://anet.sh/en/guide/getting-started) · [▶️ 48-second intro video](https://anet.sh/en/) · [中文](./README.md) · English**

**An enterprise-grade, open-source alternative to Grok Bot, built for private self-hosted deployment.**

Turn Claude Code, Codex, Grok and OpenCode on many machines into one legion of agents — and run it from a single desktop app.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/chat-dark.webp">
  <img src="docs/assets/readme/chat-light.webp" width="880" alt="Agent Network desktop app: online agents on the left, a conversation with one node on the right">
</picture>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/tasks-dark.webp"><img src="docs/assets/readme/tasks-light.webp" width="880" alt="Desktop Tasks page: project filters on the left, and columns for Backlog, In progress and Done"></picture>

</div>

## Why Agent Network

- 🤖 **A legion of agents across machines** — Claude Code, the Claude Agent SDK, Codex, Grok Build and OpenCode all join one network as nodes; nodes discover each other and hand off work through MCP.
- 🛰️ **One hub for every machine** — CommHub exposes its tools over MCP and delivers tasks in real time over SSE. Run `anet daemon` on a machine and you can create, start and stop nodes there remotely from the client.
- 💬 **One client for all of it** — desktop (macOS / Windows) and Android: dispatch work like chat and exchange files; the Tasks page covers projects, subtasks, GitHub Issues and times to the second; the UI switches between Chinese and English; node and Hub logs are available; rules files, skills, project folders, remote model switches and restarts remain. iOS is TestFlight only, and the public link is not open yet.
- 🔐 **Self-hosted, local-first, open source** — the Hub and its SQLite data run on hardware you control (the desktop app even bundles a local Hub). No hosted SaaS. Apache 2.0.

<table><tr>
<td width="50%"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/rules-dark.webp"><img src="docs/assets/readme/rules-light.webp" alt="Reading a node's CLAUDE.md rules file in the desktop app"></picture></td>
<td width="50%"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/files-dark.webp"><img src="docs/assets/readme/files-light.webp" alt="Browsing a node's project folder in the desktop app"></picture></td>
</tr></table>

## Quick start in 30 seconds

**Option 1: the desktop app (recommended)** — download macOS, Windows or Android from [anet.sh](https://anet.sh/en/) (route one is the China ModelScope mirror, route two is GitHub). Pick the Local workspace to use the built-in Hub, install and start the local daemon in one click on the Servers page, then create nodes right there.

**Option 2: the `anet` CLI** (requires Node.js ≥ 22.13)

```bash
curl -fsSL https://anet.sh/install.sh | sh    # install the anet CLI
npm i -g bun                                   # the Hub runs on Bun
anet hub start           # terminal 1: keep it running; note the one-time admin password
anet login --hub http://127.0.0.1:9200 --username admin     # terminal 2
anet node create my-bot  # pick a runtime; claude-code-cli if you ran claude auth login
anet node start my-bot
```

`SSE connected` means the node is online. Then chat with it from the desktop app at `http://127.0.0.1:9200`, or run `anet hub dashboard` for the web version (`http://localhost:3000`). On any public deployment run `anet passwd` right away — full walkthrough in the [getting-started guide](https://anet.sh/en/guide/getting-started).

## How it works

```mermaid
flowchart LR
  subgraph A["Machine A"]
    DA["anet daemon"] -.manages.-> N1["Claude Code node"] & N2["Codex node"]
  end
  subgraph B["Machine B"]
    DB["anet daemon"] -.manages.-> N3["Grok node"] & N4["OpenCode node"]
  end
  N1 & N2 & N3 & N4 <-->|"MCP tools + SSE tasks"| H[("CommHub<br/>SQLite")]
  DA & DB <-->|"MCP + SSE"| H
  H <-->|"HTTP + SSE"| C["Desktop · Mobile · Web Dashboard"]
```

Each node is an `agent-node` process wrapping one agent runtime. It calls the Hub's tools over MCP (find teammates, send tasks, reply) and receives tasks in real time over SSE. The daemon is a special node (`host_supervisor`) that creates, starts and stops other nodes on its machine on the Hub's behalf; model switches and restarts are applied by the node itself when the Hub pushes it a config update. See [Architecture](https://anet.sh/en/guide/architecture).

## Supported runtimes

| Runtime | Agent | Sign-in | Human + agent share one TUI session |
|---|---|---|---|
| `claude-code-cli` | Claude Code | Reuses `claude auth login` (subscription) | — |
| `claude-agent-sdk` | Claude Agent SDK (Anthropic and compatible APIs: MiniMax, DeepSeek, GLM, Kimi…) | API key | — |
| `codex-sdk` | OpenAI Codex | Reuses `codex login` | — |
| `codex-app-server` | Codex TUI co-presence (shown as `codex-cli` in the wizard) | Reuses `codex login` | ✅ |
| `grok-build-acp` | xAI Grok Build | Reuses `grok login` | — |
| `grok-build-cli` | Grok Build TUI co-presence (experimental preview, trusted tasks only) | Reuses `grok login` | ✅ |
| `opencode-cli` | OpenCode. Default is V1 (`opencode-ai`, Anthropic / OpenAI presets, preview). V2 is co-presence on the same runtime: `@opencode/cli@2.0.22`, `anet node create --runtime opencode-cli --opencode-generation v2 --opencode-unsafe-tools`, every local tool enabled, trusted tasks only. npm `latest` does not have this flag yet. See [OpenCode V2](https://anet.sh/en/guide/opencode) | V1: provider API key. V2: copies the `provider/model` already in OpenCode on this machine | V1 ✅ (Linux / macOS). V2 co-presence evidence that exists today is Linux |
Per-runtime capabilities and platforms: [Runtimes](https://anet.sh/en/guide/runtimes) and the [support matrix](https://anet.sh/en/guide/support-matrix).

## Documentation

[Getting started](https://anet.sh/en/guide/getting-started) · [OpenCode V2](https://anet.sh/en/guide/opencode) · [Desktop app](https://anet.sh/en/guide/desktop-app) · [Task API](https://anet.sh/en/api/mcp-tools) · [Architecture](https://anet.sh/en/guide/architecture) · [CLI](https://anet.sh/en/guide/cli) · [Production](https://anet.sh/en/deploy/production) · [Upgrade channel](https://anet.sh/en/guide/upgrade) · [Changelog](https://anet.sh/en/changelog)

## Contributing and community

Contributions are welcome! Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md) first; report security issues privately as described in [SECURITY.md](./SECURITY.md). Questions and feedback: [Issues](https://github.com/sleep2agi/agent-network/issues) · [Discussions](https://github.com/sleep2agi/agent-network/discussions) · [Community](https://anet.sh/en/community).

<a href="https://star-history.com/#sleep2agi/agent-network&Date"><img src="https://api.star-history.com/svg?repos=sleep2agi/agent-network&type=Date" width="600" alt="Star History Chart"></a>
## License
[Apache License 2.0](./LICENSE). The desktop and mobile clients live in [sleep2agi/agent-network-app](https://github.com/sleep2agi/agent-network-app) (MIT).

Grok and Grok Bot are trademarks of xAI. Agent Network is an independent open-source project, not affiliated with xAI.

<h1 align="center">Agent Network</h1>

<p align="center">
  <strong>Turn Claude, Codex, and Grok into an AI team that can delegate work.</strong>
</p>

<p align="center">
  Local-first · Multi-model · MCP + SSE · Apache 2.0
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sleep2agi/agent-network"><img src="https://img.shields.io/npm/v/@sleep2agi/agent-network.svg" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License"></a>
  <a href="https://anet.sh/en/"><img src="https://img.shields.io/badge/docs-anet.sh-009e7e.svg" alt="Docs"></a>
  <a href="https://github.com/sleep2agi/agent-network"><img src="https://img.shields.io/github/stars/sleep2agi/agent-network?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="https://anet.sh/en/guide/getting-started">Get started</a> ·
  <a href="https://anet.sh/en/guide/runtimes">Runtimes</a> ·
  <a href="https://anet.sh/en/deploy/production">Production</a> ·
  <a href="./README.md">中文</a>
</p>

## Quick start

Requires Node.js ≥ 22.13.

```bash
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node

# Terminal 1
anet hub start

# Terminal 2
anet hub dashboard

# Terminal 3
anet login --hub http://127.0.0.1:9200 --username admin
anet node create my-bot
anet node start my-bot
```

Verify the Hub is up: `curl http://127.0.0.1:9200/health` should return JSON containing `"ok":true`.

> **⚠️ Check that the node really started — don't rely on `anet node start`'s stdout `✅`**: `exit 0` plus a printed `✅ node "…" started detached (tmux session live)` does **not** mean the node came up. On **versions predating [#895](https://github.com/sleep2agi/agent-network/pull/895)** (including today's npm `@preview` = `2.3.0-preview.39`; **#895 has landed on `main` but is not yet released to npm**) the detached path can lie. Real check: `tmux has-session -t "=<alias>"` returns 0 (**the `=` is required** — a bare alias is a prefix match and can go green on the wrong session). For bulk launches use `anet project up`; its exit code is trustworthy since [#896](https://github.com/sleep2agi/agent-network/pull/896) (also awaiting an npm release).

Open `http://localhost:3000` and dispatch work from the Dashboard.

The default administrator account is `admin` / `anethub`. **Any public deployment must run `anet passwd` immediately after login** — otherwise anyone who scans the port can walk in.

> **Since `@sleep2agi/agent-network@2.2.22-preview.4`** (2026-06-28, PR [#264](https://github.com/sleep2agi/agent-network/pull/264) fixing [#261](https://github.com/sleep2agi/agent-network/issues/261) P0-2), preview builds print a **one-time random password** on the first `anet hub start` — shown once (save it right then); the first login forces a password change.
>
> **The stable `@latest` (currently `2.2.21`) and older `preview ≤ 2.2.22-preview.3` still ship with the fixed default `admin` / `anethub`** — run `anet passwd` right after logging in.

## What it does

- **Connect different agents:** Claude Code, Claude Agent SDK, Codex, and Grok Build can share one network.
- **Discover and delegate:** agents find teammates through MCP; the Hub delivers tasks over SSE.
- **Keep control of your data:** the Hub, Dashboard, and SQLite data run on hardware you control.
- **Preview channel adds more:** `@preview` also exposes **Codex TUI co-presence** and **OpenCode** (`codex-app-server` / `opencode-cli` runtimes) — see the [Runtime page](https://anet.sh/en/guide/runtimes).

```text
Agent A  ──task──▶  CommHub  ──SSE──▶  Agent B
                       │
                   Dashboard
```

## Documentation

- [Full setup guide](https://anet.sh/en/guide/getting-started)
- [Choose a runtime](https://anet.sh/en/guide/runtimes)
- [Connect model providers](https://anet.sh/en/guide/multi-model)
- [Architecture](https://anet.sh/en/guide/architecture)
- [Production and security](https://anet.sh/en/deploy/production)
- [Changelog](https://anet.sh/en/changelog)

Stable features follow npm `latest`. See [version channels](https://anet.sh/en/guide/versioning) for preview installation.

## Open source

Apache 2.0. Open an [Issue](https://github.com/sleep2agi/agent-network/issues), join [Discussions](https://github.com/sleep2agi/agent-network/discussions), or visit the [community](https://anet.sh/en/community).

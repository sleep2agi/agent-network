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

Requires Node.js ≥ 22.13.0. `anet -v` does not need Bun; starting the Hub (`anet hub start`) requires Bun ≥ 1.2.0.

```bash
npm install -g bun @sleep2agi/agent-network@latest
anet -v

# Terminal 1
anet hub start

# Terminal 2
anet hub dashboard

# Terminal 3
anet login --hub http://127.0.0.1:9200 --username admin
anet node create my-bot
anet node start my-bot
```

Verify: `curl http://127.0.0.1:9200/health` should return JSON containing `"ok":true`.

Open `http://localhost:3000` and dispatch work from the Dashboard.

The default administrator account is `admin` / `anethub`. **Any public deployment must run `anet passwd` immediately after login** — otherwise anyone who scans the port can walk in.

> Preview builds (`@preview`) behave differently: the first `anet hub start` prints a one-time random password. It is shown once, so save it right then.

## What it does

- **Connect different agents:** Claude Code, Claude Agent SDK, Codex, and Grok Build can share one network.
- **Discover and delegate:** agents find teammates through MCP; the Hub delivers tasks over SSE.
- **Keep control of your data:** the Hub, Dashboard, and SQLite data run on hardware you control.

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

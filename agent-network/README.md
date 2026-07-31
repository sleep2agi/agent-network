# Agent Network (`anet`)

[![npm version](https://img.shields.io/npm/v/@sleep2agi/agent-network.svg)](https://www.npmjs.com/package/@sleep2agi/agent-network)
[![npm downloads](https://img.shields.io/npm/dm/@sleep2agi/agent-network.svg)](https://www.npmjs.com/package/@sleep2agi/agent-network)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/sleep2agi/agent-network/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-anet.sh-009e7e.svg)](https://anet.sh)

`anet` connects local AI agents through one self-hosted Hub. It starts CommHub and the Dashboard, creates node identities, and manages node lifecycle, networks, tokens, tasks, and channels.

## Install

Requires Node.js ≥ 22.13 and Bun ≥ 1.2.

```bash
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

Stable releases use npm's `latest` tag. Features that are still being validated use `preview`:

```bash
anet upgrade --channel preview
```

Do not copy fixed package or preview numbers from old issues. Check the [versioning guide](https://anet.sh/guide/versioning) and npm dist-tags for the current release.

## Quick start

Open three terminals:

```bash
# Terminal 1 — Hub
anet hub start

# Terminal 2 — Dashboard
anet hub dashboard

# Terminal 3 — login, create, start
anet login --hub http://127.0.0.1:9200 --username admin
anet node create my-bot
anet node start my-bot
```

The node is ready after its log reports `SSE connected`. Open `http://localhost:3000` and send it a task from Dashboard.

## Runtime selection

`anet node create` shows only runtimes available in the installed release channel. Installation, authentication, permissions, and current availability are maintained in the [runtime guide](https://anet.sh/guide/runtimes).

- Claude Code, Claude Agent SDK, Codex SDK, and Grok Build ACP are the published task-runtime paths.
- Codex TUI co-presence is preview-only and must be started and recovered with `--copresence`; see the [co-presence guide](https://anet.sh/guide/codex-copresence).
- OpenCode support is preview-only. Its automatic `npx` fallback is intentionally disabled, so install the documented CLI explicitly.
- Neither npm `latest` nor `preview` includes a shared Grok TUI. Use `grok-build-acp` for published Grok nodes and follow the [Grok TUI status page](https://anet.sh/guide/grok-copresence).

Development branches may contain source-only runtime experiments. They are not supported installation paths until they appear in an npm dist-tag and the runtime guide.

## What it provides

- **CommHub** — MCP, REST, SSE task delivery, authentication, networks, and audit state.
- **Agent Node** — long-running workers backed by the selected runtime.
- **Dashboard** — topology, chat, tasks, messages, and node health.
- **CLI** — setup, login, node/project lifecycle, channels, tokens, and diagnostics.

Runtimes with CommHub tool integration can discover peers and delegate work with tools such as `get_all_status`, `send_task`, and `get_task`. Replies and ordinary messages do not recursively invoke another model; see the [task lifecycle](https://anet.sh/concepts/task-lifecycle).

## Security

The default Hub is local-only. Before exposing it beyond localhost, change the initial password and follow the [production deployment guide](https://anet.sh/deploy/production). Do not copy `.anet` node configs between machines: they contain network-bound identity and token material.

## Documentation

- [Getting started](https://anet.sh/guide/getting-started)
- [CLI reference](https://anet.sh/guide/cli)
- [Runtime guide](https://anet.sh/guide/runtimes)
- [Tokens and permissions](https://anet.sh/concepts/tokens)
- [Troubleshooting](https://anet.sh/troubleshooting)
- [GitHub repository](https://github.com/sleep2agi/agent-network)

Apache-2.0.

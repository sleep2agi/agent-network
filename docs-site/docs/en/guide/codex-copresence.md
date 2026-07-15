# Codex TUI Co-presence (`codex-app-server`, preview)

The `codex-app-server` runtime lets a **human and an Agent share one Codex session**: the human types / reads output / handles approvals in the native Codex TUI, while Agent Network tasks are injected into the **same Codex thread** via CommHub. Both see the same history and the same live events. ([RFC-030](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md), Phase 0A.)

> Unlike the headless `codex-sdk`: `codex-sdk` is a background worker with no shareable live TUI; `codex-app-server` is the one that gives you co-presence.

::: warning Preview
This is a **preview** (not on `latest`), and currently a **single-machine** form. Only connect to trusted Hubs.
:::

## Prerequisites

- Install and authenticate the Codex CLI (verified baseline `codex-cli 0.144`): `npm install -g @openai/codex`, then `codex login`
- Install the preview anet packages:

```bash
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
```

## Two topologies (understand this first)

The `codex-app-server` runtime has two modes:

- **Self-hosted (default, no URL)**: the node **spawns its own** `codex app-server` (ephemeral port, fresh thread) — you start nothing, but that server is private to the node on an ephemeral port, so your TUI can't attach to it. **This is not co-presence** — just a codex-powered agent. For this: `anet node create codex-node --runtime codex-app-server` + `anet node start`, done.
- **Shared (URL passed) → co-presence**: **you** start a fixed-address app-server that both your `codex --remote` TUI and the anet node connect to. This is co-presence — the rest of this page. Co-presence **requires** starting the shared server manually, because the human and the agent must attach to the same fixed address (the node's private ephemeral one won't do).

## Start a co-presence session (shared mode)

**1. Start the shared codex app-server** (WebSocket transport — cross-platform, incl. Windows):

```bash
codex app-server --listen ws://127.0.0.1:4500
```

> Bind `127.0.0.1` only; never expose it publicly. For a long-running local setup, prefer `codex remote-control start` + `codex --remote unix://` (the unix-socket transport is Linux/macOS only; on Windows use the WS form above).

**2. Attach the human TUI** (another terminal):

```bash
codex --remote ws://127.0.0.1:4500
```

**3. Start the anet bridge node** (a second client on the same app-server):

One command — `--codex-app-server-url` writes the address straight into the node config (no env var, no manual editing); the runtime **auto-captures and writes back** `codexThreadId`:

```bash
anet node create codex-human --runtime codex-app-server --codex-app-server-url ws://127.0.0.1:4500
anet node start codex-human   # on connect, auto-captures the thread and writes codexThreadId to config.json
```

> Optional: add `--codex-thread-id <id>` to adopt a **specific** existing session (omit it to auto-capture). The address can also come from the env var `ANET_CODEX_APP_SERVER_URL`, or directly from `config.json`'s `codexAppServerUrl` (all three are equivalent; precedence: config > env).

Now when another Agent Network node dispatches a `send_task` to `codex-human`, the task appears in the human-visible Codex TUI; the human can also type directly, or add requirements inside an agent-initiated turn.

## Notes

- **Preview + single-machine**: Phase 0A form, single-machine trusted profile only.
- **One active turn per thread at a time**; "simultaneous communication" means multiple producers (the human + multiple agents) can post into the same thread.
- **All Codex commands / file changes / permission approvals are decided by the human TUI**; the agent side goes through a restricted MCP proxy.
- The app-server listens on `127.0.0.1` only; tokens / secrets never go into git or chat.
- On Windows use the **WS transport** (not the unix socket); native deps like node-pty are not required.

## References

- [RFC-030 Codex TUI Bridge](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md)
- [Node Runtime](/en/guide/runtimes) · [Grok Co-presence TUI](/en/guide/grok-copresence) (the other co-presence)

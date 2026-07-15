# Grok Co-presence TUI (`grok-build-cli`, preview)

The `grok-build-cli` runtime lets you **attach to the real Grok TUI held by the agent-node**. You and CommHub network tasks share one Grok session: network tasks enter the same session, render live in the terminal, and reply back to the task originator — while you can watch and type alongside. Human and agent share one session context.

> `grok-build-acp` is a separate ACP (`grok agent stdio`) path and **does not support attach**. For co-presence, use `grok-build-cli`.

::: warning Preview
This is a **preview**, not latest/production. Only connect to trusted Hubs and trusted tasks.
:::

## Prerequisites

- **Linux** (needs `/proc` and `/proc/self/fd`)
- **Node.js ≥ 22.13**
- The **exact** Grok CLI version installed and logged in: `grok 0.2.93 (f00f96316d)` (a trailing `[stable]` is fine), with `grok login` run as the **same OS user** that runs anet.

```bash
grok login
grok --version   # must be grok 0.2.93 (f00f96316d)
```

## Install

```bash
npm install -g @sleep2agi/agent-network@preview
```

Install only `agent-network`; the first `node start` auto-fetches and verifies `agent-node@preview` (so the first start needs the npm registry or a warm cache).

To pin the exact verified combination:

```bash
npm install -g \
  @sleep2agi/agent-network@2.3.0-preview.23 \
  @sleep2agi/agent-node@2.5.0-preview.21
```

## Minimal flow

If CommHub isn't configured yet, follow [Getting Started](./getting-started.md) to start and log into the Hub. Then, in your **target project directory**:

```bash
# Terminal 1: create and start the co-presence node
anet node create grok-shared --runtime grok-build-cli
anet node start grok-shared
```

Wait for the startup log hint:

```text
attach with anet grok attach grok-shared
```

Then, from a real interactive terminal on the **same machine, same OS user, same project directory**:

```bash
# Terminal 2
anet grok attach grok-shared
```

- No other flags are required to attach.
- `Ctrl-]` only **detaches**; it does not stop the node.
- To start receiving network tasks, wait for `SSE connected` in the log.

## The three Grok paths

| Configuration | Execution | Attachable |
|---|---|---|
| `--runtime grok-build-cli` | Co-presence TUI | ✅ Yes |
| `--runtime grok-build-cli --grok-headless` | One CLI turn per task | ❌ No |
| `--runtime grok-build-acp` | `grok agent stdio` ACP | ❌ No |

For co-presence attach, do **not** add `--grok-headless`.

## Caveats

- **Linux only**; needs `/proc` and `/proc/self/fd`.
- Grok must be exactly `0.2.93 (f00f96316d)`, with `grok login` by the same OS user.
- Attach must be a **real TTY**, run from the same machine, user, and project directory.
- The co-presence session is a fixed **text-only `[todo_write]` profile**: no filesystem, shell, network, media, MCP, or subagent tools.
- This path has **no Grok MCP tool handshake** — ignore any older "wait a few seconds for the MCP handshake" note. Attach follows the startup log hint; task reception follows `SSE connected`.
- Executable project-directory config (MCP / LSP / hooks / plugins / permission / sandbox / `.envrc`) triggers **fail-closed** (start/resume refused).
- The Feishu channel is currently **rejected**.
- Trusted Hubs and tasks only; this is a preview, not latest/production.

## References

- [Node Runtimes](./runtimes.md)
- [Grok Build runtime notes](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md)

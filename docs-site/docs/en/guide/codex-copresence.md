# Codex TUI Co-presence (`codex-app-server`, preview)

The `codex-app-server` runtime lets a **human and an Agent share one Codex session**: the human types, reads output, and handles approvals in the native Codex TUI while Agent Network tasks arrive through CommHub in the **same Codex thread**. Both sides see the same history and live events. ([RFC-030](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md), Phase 0A.)

> Unlike the headless `codex-sdk`, which is a background worker without a shareable live TUI, `codex-app-server` provides Codex TUI co-presence.

::: warning Preview
This is **preview-only**. npm `latest` currently contains none of `codex-app-server`, `--copresence`, or `codexAppServerUrl`; commands on this page will not work with a `latest` installation. The current implementation is still a trusted single-machine shape, not the production Policy Gateway. Connect only to a trusted Hub and accept only trusted tasks.
:::

## Prerequisites

- Install and authenticate the Codex CLI (protocol verification baseline: `codex-cli 0.144.x`):

```bash
npm install -g @openai/codex
codex login
```

- Install or switch to the preview channel:

```bash
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
# If anet is already installed, switch the whole component set:
anet upgrade --channel preview

# Verify: versions must say preview and help must include Co-presence / --copresence
anet -v
anet --help
```

- The recommended one-command path also needs `bash` and **tmux 3.2+**. It currently targets POSIX environments such as Linux/WSL; for native Windows, use the [manual shared-WebSocket path](#native-windows-or-advanced-adoption-manual-shared-websocket).
- The node must have a network-scoped `ntok_`. Run `anet doctor --fix` for an old node with no token, or recreate it.

## Recommended: first-class `--copresence`

```bash
# 0. From an external clean shell, enter the project the node should operate on
cd /path/to/project

# Remove every inherited COMMHUB_* identity; do not enumerate only known names
for v in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

# 1. Create a preview-runtime node
anet node create codex-human --runtime codex-app-server

# 2. Start the app-server, bridge, and attachable Codex TUI
anet node start codex-human --copresence

# 3. Enter the shared human/agent TUI
tmux attach -t =codex-human
```

A Codex thread inherits its working directory from the **app-server process cwd**, not the bridge cwd. `cd` into the target project **before** `--copresence`. On Linux, verify with `readlink /proc/<app-server-pid>/cwd`; checking only the bridge is insufficient.

`--copresence` creates three tmux sessions carrying one shared identity marker:

| Session | Role |
|---|---|
| `codex-human-appsrv` | loopback-only `codex app-server` with CommHub MCP injected |
| `codex-human-桥` | the `agent-node` bridge that receives network tasks and submits them to the thread |
| `codex-human` | the native Codex TUI that a human can attach to |

`codex-human` is also a prefix of the other two session names. A normal
`-t codex-human` selector can silently match `codex-human-appsrv` or the bridge after
the TUI session exits. Use `-t =codex-human` for exact matching—or a pane ID—with
`attach`, `capture-pane`, `send-keys`, and similar commands, and verify the target
session first. Prefix matching is especially risky after one of the three sessions dies.

Pressing `Ctrl-B D` in the TUI only detaches; it does not stop the node. Detach first, then stop it from a terminal **outside the co-presence process tree**:

```bash
anet node stop codex-human
```

The stop path uses a persistent identity marker to reap all three sessions and their children. Calling `stop` from inside the co-presence session fails closed so it cannot kill the caller's own shell.

::: danger Recovery must return through the co-presence command
If a bridge has been disconnected for a long time and prints “run `anet node start codex-human` to recover,” **do not copy that generic hint**. A plain `start` launches a separate non-co-presence node that competes with the surviving bridge for the same alias. From an external shell, stop the old tree, clear every `COMMHUB_*` variable again, and restart with:

```bash
anet node stop codex-human
cd /path/to/project
for v in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
anet node start codex-human --copresence
```

This is not theoretical: at least two production nodes are known to have run silent
duplicates for about two and nine days after operators followed the generic hint.
:::

## Permissions: read-only by default, explicit double opt-in for full access

Co-presence defaults to `sandbox_mode=read-only` with on-request approvals. If Codex must write files or use unrestricted command/network tools, opt in explicitly:

```bash
anet node start codex-human --copresence --dangerously-allow-full-access
```

- An interactive terminal requires you to type `yes`.
- A non-TTY script, CI job, or Docker caller must also pass `--yes-danger-full-access`:

```bash
anet node start codex-human --copresence \
  --dangerously-allow-full-access \
  --yes-danger-full-access
```

The second flag is only for non-interactive callers and cannot be omitted; it prevents piped input from bypassing confirmation. Full access disables the filesystem/network sandbox, so use it only in a trusted workspace with trusted tasks.

## A normal `codex-app-server` node is not co-presence

Without `--copresence`:

```bash
anet node create codex-worker --runtime codex-app-server
anet node start codex-worker
```

The node spawns a private app-server and a fresh thread. This is useful as a codex-backed background Agent, but there is no human-attachable TUI, so this path **is not co-presence**.

## Native Windows or advanced adoption: manual shared WebSocket

Native Windows does not have the tmux orchestration above. You can manually connect both the TUI and bridge to one loopback WebSocket. Give **each node its own app-server and port; never share one across nodes**: the CommHub bearer token is app-server process state, so sharing mixes thread identities and creates a single point of failure.

```powershell
# Check that the chosen port is free; this is a placeholder
# Windows PowerShell:
Get-NetTCPConnection -LocalPort <free-port> -ErrorAction SilentlyContinue

# Terminal 1: enter the target project before starting the dedicated app-server
cd C:\path\to\project
codex app-server --listen ws://127.0.0.1:<free-port>

# Terminal 2: start the bridge first so it creates/captures a thread
# and writes codexThreadId to the node config
Get-ChildItem Env:COMMHUB_* | ForEach-Object { Remove-Item "Env:$($_.Name)" }
anet node create codex-human --runtime codex-app-server --codex-app-server-url ws://127.0.0.1:<free-port>
anet node start codex-human

# Read codexThreadId from config.json, then attach Terminal 3 to that exact thread
codex resume --remote ws://127.0.0.1:<free-port> <codexThreadId>
```

`codex resume --remote` must include the session/thread id. Omitting it opens a historical-session picker and makes attaching to the wrong thread easy. You may also pass `--codex-thread-id <id>` when creating the node to adopt a specific thread; otherwise the runtime captures one and writes `codexThreadId` back to config.

Advanced Linux/macOS users can also use this topology with an existing app-server, but prefer `--copresence` for everyday use because it manages loopback binding, isolated `CODEX_HOME`, MCP injection, tmux lifecycle, and stop identity together. If common ports such as 24700–24720 are occupied by other co-presence nodes, choose another free loopback port and check it before starting.

A manually started app-server does not automatically get the CommHub MCP injection supplied by `--copresence`. If the human TUI needs direct `commhub_*` tools, configure the RFC-030 MCP URL and bearer-token environment variable **before the app-server creates the thread**. Existing threads snapshot their tool set, so adding MCP later does not work. Never put the token in argv or chat.

::: warning Codex CLI update prompt
The TUI may show `Update available` with upgrade-now selected by default. On a shared host, choose skip/later and schedule Codex CLI upgrades for a maintenance window; replacing the global binary may affect every co-presence node on that machine.
:::

## Long tasks and the 600-second message

Only one turn can be active in a thread; later network tasks queue FIFO. The current network-task wait for a final answer **defaults** to 600 seconds (runtime options can override it; it is not an immutable hard cap):

- “No final reply within 600s” **does not prove the node is dead** and does not cancel the Codex turn already running.
- Do not immediately dispatch the same task again. First inspect `tmux capture-pane -t codex-human -p | tail -30` and whether the workspace is still changing.
- Break code-heavy or tool-heavy work into steps that can report within ten minutes. If the turn is genuinely stuck, follow the [codex-app-server jam diagnosis and restart SOP](https://github.com/sleep2agi/agent-network/blob/main/docs/sop/codex-app-server-jam-restart.md): preserve work before restarting.

## Security and known limits

- The app-server binds to `127.0.0.1`; tokens and secrets must not enter argv, git, or chat.
- A thread has one active turn at a time. “Concurrent communication” means multiple producers can enqueue work, not that turns execute in parallel.
- In the default mode the bridge never answers approvals; approval-requiring turns wait for the human TUI. Full access is the explicit high-risk exception.
- Phase 0A still connects the TUI and bridge as direct clients. The production single-upstream Policy Gateway, mandatory arbitration, and minimal control plane are not implemented yet.

## References

- [RFC-030 Codex TUI Bridge](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md)
- [Node runtimes](/en/guide/runtimes)
- [CLI: `anet node start`](/en/guide/cli#anet-node-start)
- [Grok Co-presence TUI](/en/guide/grok-copresence)

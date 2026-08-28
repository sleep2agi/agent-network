# Grok Co-presence TUI

`grok-build-cli` gives one Agent Network node ownership of the only real Grok TUI. You enter that same interface from another terminal with `anet grok attach`, while CommHub tasks queue into the same session. Human input has priority and network tasks run FIFO.

::: warning Experimental (available on the preview channel)
Co-presence now ships on the npm preview channel (verified with `@sleep2agi/agent-network@2.3.0-preview.59` + `@sleep2agi/agent-node@2.5.0-preview.43`). It does not replace `grok-build-acp`. Co-presence only accepts **verified grok builds**: `0.2.93 (f00f96316d)` and `1.0.5 (5115b46bc909)`; anything else is rejected.
:::

## Prerequisites

- Linux, macOS, or WSL with Node.js, Bun, and the native `node-pty` dependency
- Grok Build CLI installed and logged in
- A clone of the Agent Network repository

```bash
grok --version
# Must be: grok 0.2.93 (f00f96316d)

grok
# Complete login in the UI on first use, then exit
```

## Build from source

Run from the repository root:

```bash
cd agent-node
bun install
npm run build
cd ../agent-network
bun install
npm run build
cd ..
```

The remaining commands on this page must use the CLI you just built, not npm stable's global `anet`. In bash/zsh, define a function scoped to the current shell and point it at the matching agent-node:

```bash
export ANET_SOURCE=/absolute/path/to/agent-orchestra
export ANET_AGENT_NODE_BIN="$ANET_SOURCE/agent-node/dist/cli.js"
anet() { bun "$ANET_SOURCE/agent-network/dist/bin/cli.js" "$@"; }

anet --help | grep grok-build-cli
# Output should include grok-build-cli and `anet grok attach` help
```

## Start and attach

Start the Hub and log in as described in [Getting Started](/en/guide/getting-started), then use two terminals:

```bash
# Terminal 1: create and keep the node running
anet node create grok-demo --runtime grok-build-cli
anet node start grok-demo
```

The TUI is ready when this marker appears:

```text
[grok-copresence] ...; attach with anet grok attach grok-demo
```

```bash
# Terminal 2: enter the same live TUI
anet grok attach grok-demo
```

Press `Ctrl-]` in the attached terminal to detach that terminal only; the node and Grok session keep running. Only one human terminal may be attached at a time.

Network work is visibly injected as:

```text
[Agent Network/from=<sender>/task=<task-id>] <message>
```

Ordinary human conversation stays local. Only an explicit delegation such as `send_task reviewer inspect the current changes` dispatches work to Agent Network.

## Stop and resume

Stop the node normally:

```bash
anet node stop grok-demo
```

The next `anet node start grok-demo` resumes the same `grokCliSession`. The runtime never silently falls back to headless mode or guesses another session. If the process crashes during a network turn, that task fails instead of being replayed across a possible side-effect boundary.

## Legacy headless mode

To launch a separate non-interactive Grok process for each network task:

```bash
anet node create grok-headless --runtime grok-build-cli --grok-headless
```

Headless nodes cannot use `anet grok attach`. Existing profiles without `grokCopresence: true` retain their old behavior and are not migrated automatically.

## Troubleshooting

### Version mismatch

Run `grok --version`. Co-presence only accepts the exact builds on the verified list (currently `0.2.93 (f00f96316d)` and `1.0.5 (5115b46bc909)`). Install a listed build before starting; do not bypass the gate. On 1.0.5, sandbox and leader mode are mutually exclusive — the runtime adjusts its launch flags per version automatically.

### An existing bare grok session cannot join co-presence

Sessions created in plain `grok` (sandbox=off) **cannot** be resumed into a co-presence node: the runtime enforces a sandbox profile and grok refuses cross-profile resume (`cannot resume this session under sandbox profile … it was created with 'off'`), with no supported way to disable the sandbox. Pinning such a session into `grokCliSession` yields repeated `Grok recovery TUI exited before recovery drain` (diagnosability follow-up: [#1400](https://github.com/sleep2agi/agent-network/issues/1400)). Instead let the node create a fresh sandboxed session (drop the pinned id, or use `--new-session`); the old session stays intact and can still be viewed with `grok --resume <id>`.

### `Installed agent-node does not support grok-build-cli`

The command found npm stable agent-node, or `ANET_AGENT_NODE_BIN` points to the wrong file. Rebuild `agent-node` and set the variable to the absolute path of its `dist/cli.js`.

### attach says it requires a TTY

Run `anet grok attach` directly in an interactive terminal. Pipes, redirected input/output, and non-interactive CI are unsupported.

### attach says the node is legacy headless

That profile does not enable co-presence. Create a new `grok-build-cli` node; do not copy or guess private socket paths.

### Permission prompts

Only the attached human handles approval prompts. The runtime never selects permanent approval and blocks TUI commands that would change the shared approval policy. At an approval screen, use Enter for allow-once or `Ctrl-C` to reject/cancel.

For implementation details, security boundaries, and Docker verification, see the [complete Grok Build runtime guide](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md).

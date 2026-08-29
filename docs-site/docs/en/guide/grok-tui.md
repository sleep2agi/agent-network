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

## Switching models inside the co-presence TUI

The co-presence TUI is **one input box shared by a human and the agent**: every keystroke you type reaches the agent's session, so leading-slash commands are blocked as a class by default (palette completion could turn a short prefix + Enter into `/always-approve`, bypassing the approval gate). There are two safe ways to change the model:

- **Type `/model <model>` right in the TUI** (agent-node `2.5.0-preview.45`+): a pristine `/model <id>` line is **proxied out-of-band** — the keystrokes are still cancelled (the slash palette never sees an Enter), the switch runs through the guarded entry, and the result is printed straight into the TUI (`[anet] 已代为切换模型 → <model>`). Extra tokens, a bare `/model`, or a line touched by arrow-key edits are not proxied and stay blocked.
- **From another terminal: `anet grok model <node> <model>`** — works on any version, even while attached; the session restarts on the new model.

Run `anet grok attach` from the node's working directory (nodes resolve by cwd, see [#1402](https://github.com/sleep2agi/agent-network/issues/1402)).

## Legacy headless mode

To launch a separate non-interactive Grok process for each network task:

```bash
anet node create grok-headless --runtime grok-build-cli --grok-headless
```

Headless nodes cannot use `anet grok attach`. Existing profiles without `grokCopresence: true` retain their old behavior and are not migrated automatically.

## Troubleshooting

### Version mismatch

Run `grok --version`. Co-presence only accepts the exact builds on the verified list (currently `0.2.93 (f00f96316d)` and `1.0.5 (5115b46bc909)`). Install a listed build before starting; do not bypass the gate. On 1.0.5, sandbox and leader mode are mutually exclusive — the runtime adjusts its launch flags per version automatically.

### An existing bare grok session cannot join co-presence by default (but can be transplanted)

Sessions created in plain `grok` (sandbox=off) **cannot by default** be resumed into a co-presence node: the runtime enforces a sandbox profile and grok refuses cross-profile resume (`cannot resume this session under sandbox profile … it was created with 'off'`). Pinning such a session directly into `grokCliSession` yields repeated `Grok recovery TUI exited before recovery drain` (diagnosability follow-up: [#1400](https://github.com/sleep2agi/agent-network/issues/1400)).

**Verified transplant** (keeps all history, no need to disable the sandbox, see [#1409](https://github.com/sleep2agi/agent-network/issues/1409)): the refusal only keys off the session metadata recording `created with 'off'`, so **clone** the session and flip that one field —

1. Copy the old session directory (`sessions/<cwd-key>/<old-id>/`, whole tree: `chat_history.jsonl`/`events.jsonl`/`compaction/`) to a new UUID; delete the `*.lock` files.
2. In the clone's `summary.json`, change `sandbox_profile`: `"off"` → the node's current workspace profile (like `anet-<hash>-workspace`; it is the only occurrence of that field in the tree).
3. Point the node config's `grokCliSession` at the new id and restart the node.

grok then resumes the clone cleanly; recent technical context comes back intact (early/low-frequency content may fall outside the active window due to grok's session compaction). The original session is never touched and can still be viewed with `grok --resume <old-id>`. If you prefer not to transplant, let the node create a fresh sandboxed session (drop the pinned id, or `--new-session`).

> ⚠️ Don't let `auto_update` push grok off the verified list: an unverified build (e.g. `1.0.13`) makes co-presence fail with `requires a verified grok build`. Pin a verified build with `GROK_BINARY`, or disable `auto_update` in the node's private `GROK_HOME` ([#1409](https://github.com/sleep2agi/agent-network/issues/1409)).

### `Installed agent-node does not support grok-build-cli`

The command found npm stable agent-node, or `ANET_AGENT_NODE_BIN` points to the wrong file. Rebuild `agent-node` and set the variable to the absolute path of its `dist/cli.js`.

### attach says it requires a TTY

Run `anet grok attach` directly in an interactive terminal. Pipes, redirected input/output, and non-interactive CI are unsupported.

### attach says the node is legacy headless

That profile does not enable co-presence. Create a new `grok-build-cli` node; do not copy or guess private socket paths.

### Permission prompts

Only the attached human handles approval prompts. The runtime never selects permanent approval and blocks TUI commands that would change the shared approval policy. At an approval screen, use Enter for allow-once or `Ctrl-C` to reject/cancel.

For implementation details, security boundaries, and Docker verification, see the [complete Grok Build runtime guide](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md).

# agent-node 2.5.0-preview.95

Since `.94`, `agent-node/` has one change (`files: ["dist", "README.md"]`; the change is in `src/` and is bundled into `dist/cli.js`):

| Commit | PR | What |
|---|---|---|
| 174e4571 | #2243 | #461: App Server watchdog — a dead codex app-server is relaunched on the original session |

## Behaviour

- Every `app_server` health probe goes through a watchdog. Two failed probes in a row, or one right after a known process exit or WebSocket close, trigger a relaunch.
- While relaunching, health reports `restarting app-server (attempt k/N)`, so a Hub on `0.9.0-preview.86`+ treats the node as degraded and refuses dispatch. As soon as a probe answers again, health flips back to ok and is reported immediately; dispatch reopens with nobody intervening.
- Budget: 3 relaunches per 10 minutes by default (env-tunable). After that the node stays degraded with "auto-restart gave up … — restart the node by hand" until a probe sees the server answering again.
- An app-server that is alive but hung is never killed; it is only reported.
- Co-presence (Linux): while the app-server is alive the bridge snapshots its tmux pane process (argv from `/proc`, cwd), accepted only when the session name matches exactly, `--listen` is this node's URL and the marker is this node's. The relaunch reuses that session name, cwd, argv and marker with this node's own `CODEX_HOME` (token via the launcher's 0600 env file, never argv), waits for the port, checks the new process's `CODEX_HOME` via `/proc/<pid>/environ` and fails closed on mismatch. tmux sessions are targeted by session id (tmux 3.4 does not match CJK names with `-t =name`).
- The bridge re-attaches with the original thread id (`thread/resume`, never `thread/start`). For owned app-servers the same reopen respawns the child.
- No account switching, no auth sharing, no other node's processes touched.

## Compatibility

- Degraded-dispatch refusal needs `@sleep2agi/commhub-server@0.9.0-preview.86` or newer; older Hubs still receive `health` (≥ `.84`) but dispatch regardless.
- macOS / Windows co-presence (no `/proc`): no relaunch; the node reports why and stays degraded, as in `.94`. A TUI pane that exits is reported, not relaunched.
- No config changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.95
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.122 @sleep2agi/agent-node@2.5.0-preview.95
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.122 ↔ agent-node@2.5.0-preview.95`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- agent-node `bun test`: 2185 pass / 0 fail; typecheck ratchet unchanged (81).
- New Docker suite `tests/test-codex-appserver-watchdog` (registered in `qa.yml`): real Hub on throwaway ports, real `anet` co-presence node in tmux, built agent-node, fake codex. SIGKILL the app-server → Hub shows degraded and refuses with `node_degraded` → relaunched with identical argv / `--listen` / `CODEX_HOME`, same thread resumed → degraded clears and dispatch is accepted; second kill restarts (2/2); third gives up and is still degraded 5 s later; `node stop` leaves nothing behind. Witnessed red with the watchdog unhooked and with the budget ignored.
- Not done: a live end-to-end run with a real codex and a real Hub.

## promote 时的 must_contain

`"version": "2.5.0-preview.95"`

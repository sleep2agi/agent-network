# agent-node 2.5.0-preview.94

Since `.93`, `agent-node/` has one change (`files: ["dist", "README.md"]`; the change is in `src/` and is bundled into `dist/cli.js`):

| Commit | PR | What |
|---|---|---|
| 1f793075 | #2230 | #448: layered health for codex-app-server nodes, and the node's own `CODEX_HOME` forced on every spawn |

## Behaviour

**A. Layered health (codex-app-server runtime only).** The status report carries `health = {bridge, app_server: {ok, rtt_ms, last_error}, tui: {ok, reason}, model_auth}`.
- `app_server`: a WebSocket handshake to the configured app-server every 30 s (loopback only).
- `tui`: co-presence nodes only; the TUI tmux session (matched by exact name) is alive and its pane is not a `sleep` placeholder.
- `model_auth`: `ok` / `revoked` / `expired` / `unknown`, classified from the last model call.
- When any layer changes, the node re-reports immediately instead of waiting for the 3-minute heartbeat.
- On `revoked` / `expired`, an idle node reports `error` with "this node's CODEX_HOME (<path>) needs a fresh login — `CODEX_HOME=<path> codex login`". The block lifts when this node's own `auth.json` is rewritten after the failure, or on the next successful call. The node never switches accounts, never copies another node's `auth.json` and never re-stages tokens; there is no fixed re-login period.

**B. `CODEX_HOME` on every spawn.** `CODEX_HOME` comes only from the node's own config/dir (`config.codexHome` → `<nodeDir>/codex-home` → profile env), never from the inherited process environment. agent-node fixes its own environment at boot before anything reads it, forces `CODEX_HOME` on its app-server spawns, and after spawning reads `/proc/<pid>/environ` for the child and its descendants: on mismatch it refuses and kills the child. If `/proc` cannot be read (e.g. Windows), the check reports "skipped", never "verified".

Root cause behind cross-node `CODEX_HOME` leaks: `tmux new-session` gives a pane's first process the tmux **server's** environment, so if the server was first started from one node's pane, every later session inherited that node's `CODEX_HOME` (reproduced on a private tmux socket; covered by a test).

## Compatibility

- **`health` reaches the Hub only on `@sleep2agi/commhub-server@0.9.0-preview.84` or newer** (#2229). Older Hubs drop the field; nothing else changes.
- **No config changes** are required. `--codex-home` given to `anet` is now saved to `config.codexHome`, so restarts reuse it.
- Not changed: at node start anet still stages the host `~/.codex/auth.json` into each node's `CODEX_HOME` (existing behaviour, under review separately).

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.94
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.121 @sleep2agi/agent-node@2.5.0-preview.94
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.121 ↔ agent-node@2.5.0-preview.94`): the launcher-side `CODEX_HOME` enforcement is in anet.

## Evidence

- Real-process unit tests: a child spawned with a neighbour's `CODEX_HOME` ends up with the node's own, and the same spawn without the fix is refused; an owned app-server spawned through a fake codex passes when `CODEX_HOME` is right and is refused and killed when it is wrong. Mutation checks witnessed red.
- Docker test725 (agent-node aggregate): 2158 pass / 0 fail. test585 (codex runtime single-flight + mutations): PASS, all 5 mutations witnessed red.
- Not done: a live end-to-end run with a real codex and a real Hub.

## promote 时的 must_contain

`"version": "2.5.0-preview.94"`

# agent-node 2.5.0-preview.96

Since `.95`, `agent-node/` has one change (`files: ["dist", "README.md"]`; the change is in `src/` and is bundled into `dist/cli.js`):

| Commit | PR | What |
|---|---|---|
| bc7fc66a | #2249 | #465: recover a hung co-presence app-server (alive, port open, never answers / ws closes 1006) |

## Behaviour

- The `.95` watchdog now tells a hung-but-alive app-server apart from a dead one. While it is hung, health reports `alive but not answering (k/M)`, so a Hub on `0.9.0-preview.86`+ sees the node as degraded straight away and refuses dispatch.
- After M consecutive failed probes (default 4, about 2 minutes at the default 30 s probe interval) the node runs a strict ownership check. Every condition must hold:
  - the tmux session id matches the one recorded when the node first saw the app-server, and the pid is still that session's live pane;
  - the process argv is `app-server --listen` with this node's URL;
  - `ANET_NODE_MARKER` in the process environment is this node's (a process without a marker is refused);
  - `CODEX_HOME` in the process environment is this node's own.
- Any mismatch: report only, never signal.
- If the check passes: SIGTERM to the pane's process group, a grace period (default 10 s, so codex can flush the session history that `thread/resume` reads back), then SIGKILL only if the process is still alive and still carries this node's marker. It then relaunches through the `.95` path (same session, argv, `CODEX_HOME`, thread resume) under the same budget of 3 relaunches per 10 minutes.
- Tunable by env: `ANET_CODEX_APPSERVER_HUNG_PROBES`, `ANET_CODEX_APPSERVER_KILL_GRACE_MS`.
- No account switching, no auth sharing, no other node's processes touched.

## Compatibility

- Degraded-dispatch refusal needs `@sleep2agi/commhub-server@0.9.0-preview.86` or newer.
- macOS / Windows co-presence (no `/proc`) and non-co-presence setups: unchanged, report only.
- No config changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.96
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.123 @sleep2agi/agent-node@2.5.0-preview.96
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.123 ↔ agent-node@2.5.0-preview.96`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- Unit: 74 watchdog tests pass, covering each identity check on its own plus the SIGTERM-only, SIGKILL, process-group, identity-changes-during-grace, survives-SIGKILL and foreign-process-never-signalled paths. Full agent-node unit suite passes; typecheck ratchet unchanged (81).
- `tests/test-codex-appserver-watchdog` gains a hung scenario on a real Hub with co-presence: accept-then-close-1006 recovers via SIGTERM (healthy at ~9 s with a 1 s probe interval); accept-never-answer-ignore-SIGTERM recovers via SIGKILL (~29 s). Negative: a hung listener with a foreign marker is never killed and the node stays degraded. Witnessed red with the kill path disabled and with the marker check removed.
- Caveat: end to end, the negative case is stopped by the existing "session still has a live pane" guard; the new ownership check (original pid alive but reused) is covered by unit tests only.
- Not done: a live end-to-end run with a real codex and a real Hub.

## promote 时的 must_contain

`"version": "2.5.0-preview.96"`

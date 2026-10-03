# agent-node 2.5.0-preview.97

Since `.96`, `agent-node/` has three changes (all in `src/`, bundled into `dist/cli.js`):

| Commit | PR | What |
|---|---|---|
| b3151bb8 | #2300 | #507: send an instance id on SSE; back off when another copy of the same node supersedes this one |
| 2d554a5a | #2297 | #505: every tmux call goes through one socket-isolating helper; `kill-server` is refused |
| 66dcb2ac | #2060 | daemon refuses a node workdir under `$HOME` containing non-ASCII characters (`workdir_not_ascii`) |

## Behaviour

- Each agent-node process picks a random instance id (`an-<uuid>`) for its lifetime, prints it at startup and sends it as `X-Anet-Instance-Id` on every connect to `/events/<alias>`.
- On `node_connection_superseded` with reason `superseded_by_new_connection` (sent by Hub `0.9.0-preview.96`+ when another copy of the same node connects), the node logs an error naming the alias, where the other copy connected from and both instance ids (never a token), and waits 30 s → 60 s → … capped at 10 min before reconnecting, instead of the 1 s retry. The backoff resets after a connection holds for 10 min. While superseded it stops fetching inbox rows, so the copy holding the stream owns the inbox. `replaced_by_reconnect` reconnects as before. Older Hubs never send the event: unchanged.
- tmux: when `ANET_TMUX_SOCKET` or `TMUX_TMPDIR` is set, tmux is invoked with an explicit `-S <socket>` and an inherited `TMUX`/`TMUX_PANE` is dropped; with neither set, argv and environment are unchanged. `kill-server` throws `TmuxKillServerRefused`.
- daemon: a workdir below `$HOME` with non-ASCII characters is rejected before any directory is created (`workdir_not_ascii`); the home directory itself may be non-ASCII.

## Compatibility

- Supersede handling needs `@sleep2agi/commhub-server@0.9.0-preview.96` or newer; older Hubs behave as before.
- Not covered: the superseded copy still reports status, so two live copies keep overwriting each other's status row; an atomic inbox claim (lease) is not implemented (design in #2300).
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.97
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.126 @sleep2agi/agent-node@2.5.0-preview.97
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.126 ↔ agent-node@2.5.0-preview.97`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- #2300: 19 new unit tests (`util/sse-node-identity.test.ts`); 5 mutants (backoff floor ignored, 1 s reconnect restored, backoff collapsed, header dropped, inbox gate removed) all red. test725 agent-node unit in Docker 2224/0; typecheck ratchet 81 = baseline.
- #2297: Docker suite `test505` 15/15 per package, red with isolation disabled.
- #2060: unit +4, e2e +2.
- Not done: a two-process end-to-end run against a `.96` Hub.

## promote 时的 must_contain

`"version": "2.5.0-preview.97"`

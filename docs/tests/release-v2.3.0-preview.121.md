# agent-network 2.3.0-preview.121

Since `.120`, `agent-network/` has one change:

| Commit | PR | What |
|---|---|---|
| 1f793075 | #2230 | #448: every respawn path gives a codex node its own `CODEX_HOME`, verified after spawn |

## Behaviour

- `CODEX_HOME` for a codex node is computed from the node's own config/dir, never inherited from the calling shell.
- The co-presence tmux sessions (app-server, bridge, TUI) are created with `tmux new-session -e CODEX_HOME=…`, so they no longer inherit the tmux server's environment. The app-server is checked as soon as it is ready; all three before the node is reported ready.
- The launcher supervisor (first spawn and every exit-75 restart after `update_node_config`) sets the child's `CODEX_HOME` and checks `/proc/<pid>/environ`; on mismatch it refuses. Where `/proc` is unavailable the check reports "skipped".
- `anet node codex start/restart/resume` drops its own shell's `CODEX_HOME` before calling the launcher.
- `--codex-home` is saved to `config.codexHome`.
- Daemon `start_node` / `create_node`, `project up/restart`, the boot sweep and `node restart` all go through `anet node start`, so they are covered by the launcher change.
- Pairing pins bumped to `agent-node 2.5.0-preview.94` / `agent-network 2.3.0-preview.121`.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.121 @sleep2agi/agent-node@2.5.0-preview.94
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.121 @sleep2agi/agent-node@2.5.0-preview.94
```

Upgrade both packages together.

## Evidence

Docker test745 (agent-network aggregate): 1354 pass / 0 fail.

## promote 时的 must_contain

`"version": "2.3.0-preview.121"`

# agent-network 2.3.0-preview.125

anet-only release. agent-node stays at `2.5.0-preview.96`.

## Behaviour

- Every tmux call in `anet` now goes through one helper (#505 / #2297). When `ANET_TMUX_SOCKET` or `TMUX_TMPDIR` is set, the helper passes an explicit `-S <socket>` and drops an inherited `TMUX`/`TMUX_PANE` from the child environment, so an "isolated" call made from inside an existing tmux pane can no longer reach the default server. With neither variable set, argv and environment are unchanged, so normal nodes keep using the default tmux server.
- `anet` refuses `tmux kill-server` outright (including `a ; kill-server` chains and abbreviations such as `kill-ser`), throwing `TmuxKillServerRefused`.
- Codex co-presence: the human TUI no longer passes `--dangerously-bypass-approvals-and-sandbox` on `codex resume --remote <ws> <thread>`. codex 0.155.1 exits on that combination with "Permission overrides are not supported when resuming a remote task.", which made `anet node codex start` report "TUI tmux session exited during startup". The fresh path keeps the flag; the app-server is still started with the same `approval_policy` / `sandbox_mode` (#505 / #2298).
- Pairing pin `PAIRED_AGENT_NETWORK_VERSION` bumped to `2.3.0-preview.125`; `PAIRED_AGENT_NODE_VERSION` stays `2.5.0-preview.96`. The agent-node copy of the tmux helper from #2297 ships with the next agent-node release.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.125 @sleep2agi/agent-node@2.5.0-preview.96
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.125 @sleep2agi/agent-node@2.5.0-preview.96
```

Upgrade both packages together.

## Evidence

#2297: Docker suite `test505` reproduces the 10-03 incident (inherited `TMUX` pointing at a default server) and passes 15/15 per package; with isolation disabled it goes red (4 failures). test745 agent-network unit 1404/0, test725 agent-node unit 2205/0. #2298: unit tests for both launch paths; Docker probe against a real app-server + thread on codex 0.155.1 and 0.133.0.

## promote 时的 must_contain

`"version": "2.3.0-preview.125"`

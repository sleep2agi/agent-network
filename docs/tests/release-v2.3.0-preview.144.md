# agent-network 2.3.0-preview.144

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.144`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.111` (see [`release-v2.5.0-preview.111.md`](./release-v2.5.0-preview.111.md)).

Since `.143` (release merge `3c045290`, #2401), `agent-network/` has three changes:

| Commit | PR | What |
|---|---|---|
| 3481b19b | #2402 | #562 step 2: `anet node start\|stop\|restart <alias> --remote`, `anet node edit <alias> --model <id> --remote` — manage a node on another machine through the Hub |
| f90d199d | #2404 | #570 PR-A: remote restart / model change also for hand-started nodes (no daemon needed) |
| 5b379394 | #2403 | #571: `anet project up` no longer deletes a live `.pid` (no second copy of a running node) |

## Behaviour

- **Remote lifecycle (#2402).** `--remote` on start / stop / restart, and on `edit --model`, acts on a node on another machine. It resolves the node in the current network (or `--network`), prints where it lives (hostname, daemon online, state) and the exact equivalent `--yes` command, asks `y/N` (same confirm helper as the `anet node` menu), dispatches through the Hub's existing `start_node` / `stop_node` / `restart_node` / `update_node_config`, then waits up to 60 s (`--wait <s>`, `--wait 0` to skip) and reports the outcome; on timeout it says so and points to `anet node ls --all`. `stop --remote` takes `--force` for a node with tasks in flight. Remote delete is not offered. Auth: only the token saved by `anet login` (never `COMMHUB_TOKEN`; a saved node token is refused).
- **Who can be managed (#2402 + #2404).** `start` / `stop --remote` need a node created by a daemon whose daemon is online; otherwise they refuse before sending ("this machine can't be managed remotely …"). `restart` / `edit --model --remote` work for **any running node that reports `config_update_capable`** — every node started with `anet node start` does — with or without a daemon (the node itself restarts on exit 75). Nodes that can't take config updates (e.g. a bare pm2-run agent-node) are refused up front instead of being killed.
- **`project up` (#2403).** A node whose `.pid` points at a live process of that node is reported "already running (pid N)" and skipped; a dead pid's file is still cleared and the node started.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.144 @sleep2agi/agent-node@2.5.0-preview.111
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.144 @sleep2agi/agent-node@2.5.0-preview.111
```

Upgrade both packages together (`agent-network@2.3.0-preview.144 ↔ agent-node@2.5.0-preview.111`).

## Evidence

- #2402: 21 unit tests (`node-remote.test.ts`); Docker suite `tests/test562b-node-remote` (throwaway hub, real daemon on hostname `machine-b`) — remote stop (n / y), start, restart (new pid), model change, refusals (no daemon, restricted member even with an admin token in `COMMHUB_TOKEN`, viewer `permission_denied`, unknown alias, `--tmux`, node token) — 4 witnessed reds; 130/130 checks.
- #2404: decision-table tests (29) with 4 witnessed reds; test562b new cases J–M (hand-started restart pid 418→951, model change, not-capable refused, start/stop still refused) + 2 more witnessed reds; agent-network unit 1881 pass; 130/130 checks.
- #2403: see [`release-v2.5.0-preview.111.md`](./release-v2.5.0-preview.111.md); `project up` case S4 in `tests/test571-lifecycle-safety` (red on the previous main, green now); 131/131 checks.

## promote 时的 must_contain

`"version": "2.3.0-preview.144"`

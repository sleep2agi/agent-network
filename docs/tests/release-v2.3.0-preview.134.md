# agent-network 2.3.0-preview.134

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.134`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.101` (see [`release-v2.5.0-preview.101.md`](./release-v2.5.0-preview.101.md)), so codex co-presence and `opencode-cli` resolve agent-node `.101`, which carries the codex watchdog reporting fix (#2342).

Since `.133` (release merge `9d6e4f4b`), `agent-network/` has one change:

| Commit | PR | What |
|---|---|---|
| c29e8e2c | #2344 | #522: `anet node delete` finds `--workdir` copies and stops co-presence sessions |

## Behaviour

- **`anet node delete` finds nodes outside the current directory** (#522 / #2344). Besides `<cwd>/.anet/nodes/`, it checks `<cwd>/.anet/child-workdirs.json` (now written by `anet node clone … --workdir` and `anet node codex fork … --workdir`) and the `node_dir` of each `~/.anet/codex-auth-fingerprints/*.json` record.
  - A directory with that name in cwd still wins; otherwise a unique `node_id` match wins.
  - One match in another directory: delete prints the exact `cd '<dir>' && anet node delete '<name>' --force` and exits 1 without acting.
  - **Several matches for a name: delete refuses** (rc 1) and lists one command per candidate. A name alone never picks one.
- **Delete stops the node through the same path as `anet node stop`** (`stopResolvedNode`). Codex co-presence sessions are torn down by identity (`ANET_NODE_MARKER` plus the node's `CODEX_HOME` / pane anchors); marker-less nodes keep the legacy sweep on **exact** session names. Any stop that cannot be proven exits non-zero and nothing is removed.
- **The preview no longer stops the node.** `anet node delete` without `--force` now changes nothing, as documented; the stop runs only after the `--force` confirmation.
- Behaviour change: on a box without `procps`, `delete --force` on a node without a lifecycle receipt now fails with `NODE_PROCESS_TABLE_UNAVAILABLE`, the same way `anet node stop` already does.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.134 @sleep2agi/agent-node@2.5.0-preview.101
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.134 @sleep2agi/agent-node@2.5.0-preview.101
```

Upgrade both packages together (`agent-network@2.3.0-preview.134 ↔ agent-node@2.5.0-preview.101`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- #2344: `tests/test522-node-delete-locate-stop` (real CLI against a real Hub, private tmux socket) PASS with witnessed reds M1–M4; `src/node-locate.test.ts` 12 unit tests; test516-node-delete-hub-row PASS.

## promote 时的 must_contain

`"version": "2.3.0-preview.134"`

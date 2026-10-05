# agent-node 2.5.0-preview.112

Since `.111` (release merge `bf6e31fc`, #2405), `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| 5c11173a | #2407 | #579: after a daemon restart, `rebuildChildrenMapOnBoot` adopts a running process as its child only if both `--alias` and the `--config` path this daemon wrote match |

## Behaviour

- Follow-up to #2403 (`.111`), which made every stop sweep check `--alias` **and** `--config`. The boot rebuild still matched by alias alone: if the daemon restarted while its own child was dead and a same-alias node from another workdir/HOME was running on the machine, the daemon recorded that foreign process as its child, and a later `stop_node` killed it.
- Now a same-alias process with a different `--config` is ignored and logged once (`[rebuild] ignoring pid=… alias=…: --config is not the config this daemon wrote for the child …`), without the other node's arguments or path.
- **Daemons must be upgraded to this version and restarted to get the fix** (`anet daemon restart <name>`).

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.112
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.145 @sleep2agi/agent-node@2.5.0-preview.112
```

Nodes and daemons must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.145 ↔ agent-node@2.5.0-preview.112`).
- Publish order: agent-node `.112` first, then agent-network `.145`, both from the same merge commit.

## Evidence

- #2407: `stop-daemon.test.ts` 4 new tests (2 on real processes) — 29 pass / 4 fail on the previous main → all pass; Docker suite `tests/test571-lifecycle-safety` new scenario S5 (real hub + daemon; own child dead, same-alias foreign node in another HOME, daemon restart, `stop_node`): PASS=42 FAIL=3 on the previous main (log: foreign pid adopted and killed) → PASS=45 FAIL=0 (log: `ignoring pid=…`, foreign survives); test725 (full agent-node unit) 2377 pass / 0 fail; 129/129 checks.

## promote 时的 must_contain

`"version": "2.5.0-preview.112"`

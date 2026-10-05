# agent-node 2.5.0-preview.111

Since `.110` (release merge `3c045290`, #2401), `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| 5b379394 | #2403 | #571: the daemon (host_supervisor) never kills by alias; it refuses to stop a child it has no record of |

## Behaviour

- **Daemon stop is identity-checked.** When a stop arrives for a node the daemon has no record of (not in its in-memory map, no config it wrote on disk), it now reports `stop_failed` with `not_my_child: …` and signals nothing. Before, it SIGTERMed every agent-node on the machine whose `--alias` matched — regardless of workdir, HOME or network — so on a shared machine it could stop another user's / team's node with the same name.
- All three cleanup sweeps now kill a process only if **both** `--alias` and the `--config` path this daemon wrote match. A delete for a node whose config is already gone still completes as "stopped" (the #1286 retry path), but only kills by that identity.
- Known follow-up (not in this release): `rebuildChildrenMapOnBoot` (when the daemon itself restarts) still records a running process by alias alone; same `--config` check needed (board #579).
- Pair with Hub ≥ `0.9.0-preview.105` (#2403's Hub half: `stop_node` / `delete_node` refuse hand-started nodes with `not_daemon_managed`). The daemon fix is safe on older Hubs too.
- **Daemons must be upgraded to this version to get the fix** (`anet daemon restart <name>` after upgrading the package on that machine).

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.111
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.144 @sleep2agi/agent-node@2.5.0-preview.111
```

Nodes and daemons must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.144 ↔ agent-node@2.5.0-preview.111`).
- Publish order: agent-node `.111` first, then agent-network `.144`, both from the same merge commit.

## Evidence

- #2403: `agent-node/src/runtime/stop-daemon.test.ts` 25 pass / 4 fail on the previous main → 29/29 (one case runs two real same-alias processes); Docker suite `tests/test571-lifecycle-safety` (real hub + daemon + same-alias processes in different workdirs/HOMEs) PASS=20 FAIL=13 on the previous main → PASS=33 FAIL=0; existing daemon suites `qa-rfc027-stop-delete` 71/0, `qa-create-node-workdir` 52/0, `qa-daemon-lifecycle-e2e` 22/0; test725 (full agent-node unit) 2373 pass / 0 fail after adding procps to its image; 131/131 checks.

## promote 时的 must_contain

`"version": "2.5.0-preview.111"`

# @sleep2agi/agent-network 2.3.0-preview.173

Exact original-task activity leases for the Codex app-server runtime. The runtime forwards genuine owned-turn activity at most once per30seconds with one report in flight; Hub135 accepts only an already-consumed original task bound to the authenticated node/network/thread/turn. Duplicate consumption, submission, ACK, node heartbeat, foreign tasks and stale turns do not renew the lease. Expired tasks stay terminal. The existing idle budget and creation-based total cap remain bounded. NULL-node/legacy clients retain the execution-clock fallback; other runtimes receive no fabricated activity signals.

Pair inputs: Hub0.9.0-preview.135, agent-node2.5.0-preview.139 and CLI2.3.0-preview.173 share one exact main source. The CLI keeps its existing exact runtime-pair contract. Publication and live activation are recorded separately; a package release does not establish fleet-wide client adoption.

## Install

```sh
npm install -g @sleep2agi/agent-network@2.3.0-preview.173
```

## Upgrade

Use the same exact-version install in the managed prefix, retaining the prior prefix for rollback. Hub upgrades require a consistent private database backup and offline schema preflight, using `deploy/hub/README.md`. Node/CLI upgrades preserve the existing identity, working directory, model, login and original vendor thread, and take effect only on an authorized normal restart; active business turns are not reset. Original-value secrets and production data still require their private sources; complete key recovery remains NOT_COVERED.

Validation is recorded in `report-test1113-task-activity.txt`. The dedicated Docker suite rebuilds exact source and runs SQLite/PostgreSQL real HTTP, scheduler/consumption contracts, runtime event/reporter integration, atomic-write failure injection, release pairing and assertion witnesses. Source/main publication and actual live canary are separate gates.

The first formal run38346683979 failed Gate4 because the bilingual getting-started preview assertion still named172; publication was SKIPPED. Its install/TTY gate passed for the main-built173 candidate with an explicit password. The default bootstrap CLI source is byte-identical to the checked172 source; the documentation identifies that continuity as an inference and does not claim a fresh default-password run. The claim stamp is updated to173 with the random-password behavior preserved and the checked stable76 claim unchanged. CLI173 will be rebuilt and gated from the subsequent documentation main commit; Hub135/Node139 remain published from source47816a61. Package source trees are compared explicitly; separately record each actual release SHA rather than claiming one full repository commit for all three.

Main-only package provenance and selected Hub135 activation are recorded in `report-test1113-hub135-activation.txt`. Hub/Node source `47816a61095f196cf726f194f482739bc09f6a82`; CLI rebuild source `064ed34c9eba20f852a32dbe42b98389c3c2ce63`; per-package source trees unchanged. The CLI rebuild passed all four gates and its npm publish step, but run38347806170 failed the 900-second registry readback. CLI173 public availability remains unverified; preview still points to172 at the recorded observation. Do not republish the staged version. Original production Node139 activity canary remains OPEN; parent#1113/#1105 are not closed by publication.

Official alternate download: [main-gated CLI173](https://github.com/sleep2agi/agent-network/releases/download/cli-v2.3.0-preview.173/sleep2agi-agent-network-2.3.0-preview.173.tgz). Workflow38353145085 passed its Docker contract and publication guard; original source/main064ed34c9eba20f852a32dbe42b98389c3c2ce63/tag and anonymous full bytes match the original gated artifact, SHA2565e3a8464afbe06cada0039adce494e2564af73b266a0bfc555db30ce203b4029. Install that exact tarball into a chosen private prefix with exact paired agent-node139. Preserve the old pair and wait for a normal idle upgrade; no business node/thread is automatically switched. Npm propagation remains pending and the original formal timeout remains FAILURE.

Late npm distribution verification2026-10-13T06:03:47–48Z:exact-version npm installation is available again; preview tags and complete tarball bytes/SRI match the original main-built artifacts. Existing GitHub download/managed lock stays valid. Preserve the historical CLI timeout and keep the original Node139 activity canary separate.

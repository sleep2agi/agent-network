# @sleep2agi/commhub-server 0.9.0-preview.135

Exact original-task activity leases for the Codex app-server runtime. The runtime forwards genuine owned-turn activity at most once per30seconds with one report in flight; Hub135 accepts only an already-consumed original task bound to the authenticated node/network/thread/turn. Duplicate consumption, submission, ACK, node heartbeat, foreign tasks and stale turns do not renew the lease. Expired tasks stay terminal. The existing idle budget and creation-based total cap remain bounded. NULL-node/legacy clients retain the execution-clock fallback; other runtimes receive no fabricated activity signals.

Pair inputs: Hub0.9.0-preview.135, agent-node2.5.0-preview.139 and CLI2.3.0-preview.173 share one exact main source. The CLI keeps its existing exact runtime-pair contract. Publication and live activation are recorded separately; a package release does not establish fleet-wide client adoption.

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.135
```

## Upgrade

Use the same exact-version install in the managed prefix, retaining the prior prefix for rollback. Hub upgrades require a consistent private database backup and offline schema preflight, using `deploy/hub/README.md`. Node/CLI upgrades preserve the existing identity, working directory, model, login and original vendor thread, and take effect only on an authorized normal restart; active business turns are not reset. Original-value secrets and production data still require their private sources; complete key recovery remains NOT_COVERED.

Validation is recorded in `report-test1113-task-activity.txt`. The dedicated Docker suite rebuilds exact source and runs SQLite/PostgreSQL real HTTP, scheduler/consumption contracts, runtime event/reporter integration, atomic-write failure injection, release pairing and assertion witnesses. Source/main publication and actual live canary are separate gates.

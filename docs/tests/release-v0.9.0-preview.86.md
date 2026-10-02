# CommHub v0.9.0-preview.86

This release carries the Hub change merged since `0.9.0-preview.85`. Production is on `0.9.0-preview.85`.

- #2238 (a29434aec7744fc4a46f51f55a59b0a1063305b4) **Refuse dispatch to degraded nodes (#460, part of #448).**
  - A node is degraded when its own health report is fresh (observed < 10 min) and says `app_server.ok=false`, `tui.ok=false`, or `model_auth` is `revoked`/`expired`.
  - Dispatch to a degraded node returns `node_degraded` with each failing layer (label, reason, fix) and the report's age: REST `POST /api/task` → 409; MCP `send_task` / `retry_task` / `reassign_task` → error reply; scheduled runs → run marked `failed` with `error_code=node_degraded`, no task created.
  - No health, stale health, or a layer never reported → dispatch is allowed exactly as before (nodes not on agent-node ≥ 2.5.0-preview.94 are unaffected). Replies, `send_message` and broadcast are untouched.
  - Escape hatch `force=true`, honoured only for user tokens; a node token sending `force=true` is still refused.
  - `/api/status` rows (light and full) gain `degraded: [{layer,label,reason}]` only when a layer is down; light output is byte-identical when nothing is degraded.

No other server change is in this release. No schema change.

Checked in Docker with `tests/hub-release-compat`, candidate a29434aec7744fc4a46f51f55a59b0a1063305b4 (clean tree), baseline `0.9.0-preview.85` from npm, apps 0.2.166 / 0.2.181 / 0.2.191, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.86`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.86
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.86
```

No migration; the database is not changed by this release.

## Rolling back

`0.9.0-preview.85` starts on a database that `.86` has run on with no difference: `.86` adds no tables or columns. Health reports are in memory only.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.

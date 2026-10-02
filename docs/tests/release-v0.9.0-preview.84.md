# CommHub v0.9.0-preview.84

This release carries the Hub change merged since `0.9.0-preview.83` (cut from e57e2e7b). Production is on `0.9.0-preview.83`.

- #2229 (be36ac258a27d5f392d37274df61313779d03e6d) **Node health passes through to `/api/status` and `status_update` (#448).**
  - `report_status` accepts an optional top-level `health` object (agent-node `2.5.0-preview.94`+ on the codex-app-server runtime sends `{bridge, app_server, tui, model_auth}`). Before this release the Hub's input schema dropped unknown top-level keys, so `health` never arrived.
  - Lenient: a malformed `health` never rejects the status report; it is ignored. Only the node's own token can set its health.
  - Kept in memory only, with a 10-minute TTL. Missing or stale health reads as `null`, never as healthy. No database change.
  - Exposed as `health` and `health_observed_ms_ago` on `/api/status` rows and in the `status_update` SSE event. Nodes that do not send health (all agent-node versions before `.94`, and other runtimes) show `null`.

No other server change is in this release.

Checked in Docker with `tests/hub-release-compat`, candidate be36ac258a27d5f392d37274df61313779d03e6d (clean tree), baseline `0.9.0-preview.83` from npm, apps 0.2.166 / 0.2.181 / 0.2.189, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.

#2229's own test (`server/src/node-health-passthrough.test.ts`) covers the passthrough, the lenient shape handling, owner-token-only writes and the TTL; the golden `/api/status` key list (`rest-explicit-columns-http.test.ts`) includes the two new keys. Docker test798: 161/161 files pass.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.84`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.84
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.84
```

No new migrations and no new tables.

## Rolling back

`0.9.0-preview.83` starts on a database that `.84` has run on, since `.84` changes no schema. After a rollback, `/api/status` no longer carries `health`; nodes keep working (they send `health` anyway and the older Hub drops it, as before).

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.

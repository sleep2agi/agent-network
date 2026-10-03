# CommHub v0.9.0-preview.98

This release carries the Hub changes merged since `0.9.0-preview.97`. Production is on `0.9.0-preview.97`. It is built from main at 50521206.

- #2316 (50521206) **Comments reach incremental requirement reads (#506).** `GET /api/requirements?changes=1&updated_since=…` now also returns cards whose newest `requirement_events` row (a comment, or any other event) is newer than the cursor, not only cards whose `updated_at` moved. One query, the same placeholder bound twice (PostgreSQL-safe), existing indexes, no new table/column/index. `updated_at` keeps its meaning (a comment does not change the card). Reads with `last_event=0` (the MCP `requirements_list` default) and `updated_since` without `changes=1` behave exactly as before. Deleted cards still arrive only in `deleted`; scoped members still cannot see cards outside their scope.
- Not Hub: #2313 (agent-node opencode deadline), #2314 (docs site download page), #2312 / #2310 (agent-network releases).

Migration: none.

Checked:
- Packed candidate installed with `npm install` into an empty prefix resolves `@modelcontextprotocol/sdk` 1.32.0 and `zod` 4.6.5; it starts on an empty HOME and random port, `/health` reports `0.9.0-preview.98`, unauthenticated `/events/x` → 401, no errors in the log.
- `tests/hub-release-compat`, candidate 50521206af185c7a67982ef3404afc1233909196, baseline `0.9.0-preview.97` from npm, apps desktop-v0.2.200 / desktop-v0.2.201, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`: A1 and A2 steps=62 unexpected=0 check_failures=0; MCP `tools/list` 74 → 74, no new params. B upgrade → rollback → re-upgrade: upgrade_check_failures=0, every card field unchanged, full list byte-identical .97 vs .98 and across rollback / re-upgrade.
- A read-only `VACUUM INTO` copy of the production database (29 users) started on the candidate, then `.97`, then the candidate again, with `COMMHUB_DUE_REMINDERS=0`; every start answered `/health` with its own version and no errors in the log; `integrity_check` ok.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.98`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.98
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.98
```

No schema change. Existing settings such as `COMMHUB_DUE_REMINDERS` keep working. Clients that use `changes=1` incremental reads may now receive additional rows (cards with a new comment or event since the cursor); they already handle those rows as ordinary changed rows.

## Rolling back

`0.9.0-preview.97` starts on a database that `.98` has run on; nothing to undo. Incremental reads then return the smaller set they returned before.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.

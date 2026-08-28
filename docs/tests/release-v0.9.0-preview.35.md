# commhub-server v0.9.0-preview.35 — BTW REST boundary projection

**Channel:** `preview` only

**Source:** merged `main` after PR #1355

**Date:** 2026-08-28

This Hub release makes the exact Codex task boundary already persisted by
preview.34 visible to authenticated desktop clients through both task REST
endpoints. `GET /api/tasks` and `GET /api/tasks/:task_id` now include the
optional `thread_id` and `turn_id` fields in their explicit public projection.
Network scoping is unchanged and storage-only columns remain private.

Without this release, the desktop BTW drawer correctly refuses to fall back to
a normal task because the published preview.34 tarball does not expose those
two fields over REST.

## Install

For a direct, reproducible Hub install:

```bash
npm install -g @sleep2agi/commhub-server@0.9.0-preview.35
```

This is a server-only preview. It does not change the `agent-network` CLI pin
or promote any package to `latest`.

## Upgrade

Back up the Hub SQLite database, stop the existing Hub, install the exact
preview, and restart it with the same database and configuration. This release
does not add a migration: existing `tasks.thread_id` and `tasks.turn_id` values
become visible through the stable REST response projection immediately.

After restart, verify `/health` reports `0.9.0-preview.35` and an authenticated
`/api/tasks` response for a consumed Codex task contains both exact boundary
fields before accepting the desktop BTW flow.

## Verification before publish

- `test647-rest-explicit-columns`: live HTTP contract 6/6 PASS.
- Removing `thread_id` / `turn_id` from the explicit projection is witnessed red.
- Restored projection: live HTTP contract 6/6 PASS.
- PR #1355 exact head: 99/99 GitHub checks successful before merge.

# commhub-server v0.9.0-preview.34 — BTW exact task boundary

**Channel:** `preview` only

**Source:** merged `main` after PR #1335

**Date:** 2026-08-28

This Hub release persists the exact Codex task boundary reported by an upgraded
agent-node and exposes it as optional `thread_id` / `turn_id` fields through
REST and MCP task projections. Context is accepted only for an owned, consumed
task and is write-once for that task lifetime; duplicate, foreign, conflicting,
or unrequested context is rejected. Older nodes and historical tasks remain
compatible and are never backfilled by guessing.

## Install

For a direct, reproducible Hub install:

```bash
npm install -g @sleep2agi/commhub-server@0.9.0-preview.34
```

The user-facing `anet hub start` command remains pinned to the already published
`.33` until this package exists on npm. A follow-up main release will update the
CLI pin to `.34` together with `agent-node@2.5.0-preview.39` and
`agent-network@2.3.0-preview.53`.

## Upgrade

Hub operators should back up the SQLite database, stop the existing Hub, install
the exact preview, and restart it with the same database and configuration. The
schema migration is additive (`tasks.thread_id`, `tasks.turn_id`) and old clients
remain supported.

Do not promote this preview to `latest`. After the paired node and CLI release,
verify a newly consumed task has non-empty exact boundary fields before treating
BTW deep-linking as deployed.

## Verification before publish

- `test798-server-unit-ci`: 84/84 server test files, 0 failures.
- Registration-password mutation: witnessed red, then restored green.
- PR #1335 exact head: 102/102 GitHub checks successful before merge.
- App BTW suite on exact app main: 62/62 test files, typecheck and Expo export.

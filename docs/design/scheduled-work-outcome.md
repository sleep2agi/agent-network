# Explicit successful scheduler work outcomes

CommHub #1274 is the first P0 slice of #756. The Hub can now record an
authenticated node's explicit successful-work classification, independently
of task lifecycle. This slice does not change scheduling frequency.

A normal MCP `send_reply` for an open scheduler-created task may include
`meta: { scheduled_work_outcome: "changed" }` or `"no_changes"`. It must have
status `replied`, the exact currently assigned token-bound node ID, and one
authoritative `(run_id, schedule_id, task_id, network_id)` storage binding.
The original sender must be scheduler; the schedule must exist in that same
network. Neither reply text nor caller-supplied schedule/run metadata creates
the binding. A successful response includes `scheduled_work_outcome` only
when the requested classification was actually saved with the normal reply.

The classification is an authenticated **self-report**, not an independent
proof of domain completeness. Producers must decide against their specific
work contract: routine checks/bookkeeping alone do not establish domain
progress. No producer automatically marks replies empty in this slice.
Unknown/old clients and plain "no changes" text remain NULL/unknown.
Explicit malformed/failed/cancelled/late/non-owned/unbound/ambiguous reports
refuse before reply enqueue/terminalization; the node can submit its ordinary
reply without the optional classification. No task is rerun automatically.
Existing normal/late reply behavior is retained when the field is absent.

`scheduled_task_runs.work_outcome` and `work_outcome_node_id` record the
classification and exact reporter. `schedule_revision` records the scheduler
dispatch's selected revision; it is not overwritten by later schedule edits.
The scoped run-history API exposes these additive nullable fields. Legacy
runs have unknown revision. Normal task/inbox/run/outcome writes share the
existing reply transaction; an outcome write failure rolls all of them back.
Retry clears a stale classification/reporter and non-success terminals clear
them. A successful task is still not retryable. Parent-chain completions,
REST replies and late append-only receipts do not infer a work outcome.

The schedule may be edited or the task explicitly reassigned. History can
still describe the authorized current assignee's result, while a future
cadence policy must independently compare dispatch revision and reporter to
its exact current owner-selected target/configuration. NULL/old, mixed or
stale generations must not authorize a backoff. History is not cadence authority.

## Remaining #756 gates

Following source slice [#1278](scheduled-backoff.md) adds opt-in interval counters,
effective cadence and changed/manual wake. Following source slice
[#1279](scheduled-requirement-wake.md) qualifies explicitly selected requirement
creation/status wake. Other domains, UI controls and producer/current-software
adoption remain incomplete. Once/daily/weekly
timing, configured intervals and production schedules are untouched. The requirement
event contract excludes this iteration's own bookkeeping; further domains must
also avoid self-wake loops. Failed/expired/skipped/usage-limit
results must never be converted into successful empty runs.

The following [producer guidance slice](scheduled-outcome-guidance.md) explains
explicit self-reporting in opted-in dispatched tasks. Its synthetic producer
fixture does not establish real model classification or current-software adoption.

The existing transactional SQLite qualification applies. The new annotation
refuses unsupported transactional backends; this is not a PostgreSQL scheduler
support claim. API schema descriptions and old no-field reply response shapes
are unchanged. The extra nullable DB columns are ignored by older software.

## Rebuild and recovery

1. Start the Hub through the repository's `server/package.json` start command
   and `server/bin/commhub.ts` / `server/src/index.ts`; no resident service or
   production launcher changes. Independent Docker fixture lives under
   `tests/test1274-scheduled-work-outcome/` and has its own pinned Dockerfile.
2. No proxy/tunnel/production port changes. Fixture HTTP binds disposable
   loopback port 0 inside Docker `--network none`.
3. Real auth and DB encryption/backup keys remain in the original Owner's
   managed sources. Only synthetic fixture accounts/tokens are created.
   `COMMHUB_DB` selects the disposable fixture DB; no production credential
   or DB read is needed. No new production environment variable is added.
4. Rebuild exact main software with the lockfile and digest-pinned Bun image;
   the fixture asserts its exact CI checkout SHA. Actual installed effect,
   main-only public packages and live producer adoption are separate gates.
5. Roll back software normally: old versions ignore nullable columns and
   continue normal replies/scheduling. They do not record this classification;
   NULL/unknown is the compatible state. No destructive schema rollback.
6. Git restores software/schema, not run history, tokens, user DB or backups.
   DB contents require original encrypted backup/key/location/retention and
   restore authority. The fixture reconstructs software with fresh synthetic
   state, not production history. No full production recovery is certified.

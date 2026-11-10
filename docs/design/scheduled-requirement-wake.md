# Opt-in scoped requirement event wake

CommHub #1279 extends #1278 for SQLite interval plans. It does not enable any
existing or production plan. An authorized creator/editor can explicitly set:

```json
{"no_change_backoff":true,"schedule":{"type":"interval","every_seconds":120,"requirement_wake":{"tag":"ANet","project_id":"selected-project-id"}}}
```

At least one of tag/project is required; when both are supplied they intersect.
The existing REST and creator-bound MCP paths retain their authorization.
The configuring user, current original creator and current target owner must
all retain network membership and permission to see the current requirement.
Selected projects must also be visible to the configurator and creator.
Read-only nodes, missing identities, changed target/creator ownership or revoked
grants cannot wake a plan. Private identity bindings are not returned in public
schedule configuration. Explicit `requirement_wake: null` disables the watch.

Only requirement creation and real pool/doing/done/abandoned transitions qualify.
Comments, checklists, heartbeats, no-op edits, archived cards, `iteration:` cards
and mutations by the plan's own creator/target nodes do not qualify. A real
product card carrying the knowledge label still qualifies. Scope is evaluated
against the current card and current grants, rather than untrusted event text.

The durable per-plan cursor starts at the network event head when configured.
Each scheduler tick scans at most 256 events per opted-in active plan, including
plans currently delayed by backoff. Nonmatching and invisible events advance
the cursor too, so later grants do not replay previously consumed hidden work.
Multiple qualifying events in one page coalesce into one generation change.
Total scanning scales with the number of opted-in plans; this slice does not
provide a separate event worker or global scan budget.

A match atomically advances the cursor, clears the empty-work streak, increments
the plan revision and brings delayed due time within the base interval. It does
not postpone an earlier due time. Old in-flight reports cannot rearm backoff in
the new generation. Normal reply processing checks the same cursor inside its
existing transaction; a cursor-write fault rolls back reply and wake together.
Concurrent SQLite processes consume a page once. Manual run-now and edits rebase
the cursor; paused/cancelled plans stay paused/cancelled. Resuming starts from
the new head. A DB-only callback lacking the event consumer refuses to adjust
a watched plan rather than bypassing its fence.

This does not claim recovery for direct incoming tasks or other event domains,
producer classification, live policy adoption, UI controls, PostgreSQL policy
qualification, or complete production recovery. Those remain separate gates.

## Rebuild and recovery

The six answers in [the work outcome contract](scheduled-work-outcome.md#rebuild-and-recovery)
apply: repository Hub entrypoints and launchers; existing proxy/port mappings;
Owner-managed original auth and backup keys; exact main software and lockfile;
ordinary software rollback; encrypted Hub data backup for actual state/history.
No new service, port, environment variable or secret source is introduced.
Additive nullable/default-off columns are in `server/src/db.ts`. Git restores
software/schema/fixtures, while the Hub backup restores adopted filters, cursor,
generation, real event history and identities. Disable the optional watch before
planned rollback: old software cannot preserve event-wake semantics. No backup
or credential copies are fabricated by tests.

Independent pinned Docker fixture: `tests/test1279-requirement-wake/`, workflow
`scheduled-requirement-wake.yml`. It uses synthetic accounts and schedules only.

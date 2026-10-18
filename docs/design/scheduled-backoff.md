# Opt-in interval backoff

CommHub #1278 is a bounded source slice under #1276 / #756. Existing schedules
remain disabled. An authorized REST schedule creator/editor or creator-bound
MCP `schedule_create` / `schedule_update` may set `no_change_backoff: true`.
It is a boolean, supported only for interval schedules with overlap `skip`.
It does not grant a node permission to edit human-created or other nodes' plans.

The original `schedule.every_seconds` remains the configured base. The scoped
schedule response adds `no_change_backoff: true` and `backoff` with `streak`,
`effective_seconds` and `last_run_id` only when enabled; disabled schedules
retain their original response keys. Three consecutive exact successful
`no_changes` occurrences select max(base, 600 seconds); six select
max(base, 1800 seconds). The streak is capped at six. Due dispatch advances
using the effective interval. Threshold transitions postpone the next due
time to at least now plus the effective interval, without editing the base.

The sequence is derived from authoritative latest occurrences, not reply text.
Each must have a successful task/run, explicit authenticated self-report,
current schedule revision, current target/reporter node, and no retry marker.
Failures, expiry, skips, unknown replies, target mismatch and retries break
the sequence. Changed or such an interruption returns to base and moves an
already delayed due time closer, to at most now plus base. Duplicate callbacks
do not count twice. Older completion cannot bypass a newer skip or active run.
Missing/old revisions cannot authorize a cadence change. Self-report remains
the node's classification, not independent proof of domain completeness.

Every edit clears opted-in state and recomputes the base next occurrence;
the new revision fences old in-flight reports. Explicit manual run-now does
the same in its dispatch transaction, even if ordinary overlap rules skip
that manual execution. A paused schedule stays paused. Cancellation stays
terminal. Automatic cadence writes do not increment the edit revision.
Task/inbox/outcome/run/cadence updates share the normal SQLite reply transaction.
The lifecycle mirror is transactional too; state-write failure propagates.
Unique occurrence claiming remains before configuration revalidation.

This is SQLite-qualified source functionality. Unsupported transactional
backends do not run the policy. No live policy is enabled by this change;
producer classification and actual installed Hub/Node adoption remain separate.
Scoped requirement creation/status wake is separately documented in
[the event wake contract](scheduled-requirement-wake.md). Other event domains
and UI controls remain future slices. Routine bookkeeping and heartbeat events
do not implicitly wake a schedule.

## Rebuild and recovery

The six recovery answers in [the work outcome contract](scheduled-work-outcome.md#rebuild-and-recovery)
continue to apply: repository Hub entrypoints; unchanged proxy/ports; original
Owner-managed real auth/backup keys; exact main software plus locked dependencies;
normal software rollback; original encrypted data backup for real history.
No new service, environment variable, production configuration or secret source.
The additive default-off policy/state columns and retry exclusion are restored
by the schema in `server/src/db.ts`. State lives in the Hub DB, not process memory.
Git reconstructs software and fixtures, not real history or adopted settings.
Old software ignores these columns and advances using configured base; disable
the policy before planned rollback if effective cadence continuity is required.
No destructive migration or full production recovery certification.

Independent pinned Docker reconstruction and real HTTP/MCP suite:
`tests/test1278-scheduled-backoff/`, CI `scheduled-backoff.yml`. Fixture changes
only synthetic schedules/accounts; it does not adopt policy on production nodes.

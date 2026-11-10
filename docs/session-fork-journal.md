# Fork request journal (candidate, #590)

This implementation persists a fork intent and its delivery outcome. It does
**not** create a node, grant access to an arbitrary OpenCode Server, or prove
distributed Server-generation authorization. No client button is enabled.

## Gate and protocol

The fork write route is disabled by default. The isolated candidate enables it
only when `COMMHUB_V2_FORK_PREVIEW=1`, the adapter is SQLite, and atomic
transaction support is available. Do not enable that flag in production until
source/Server authorization and end-to-end acceptance are complete. PostgreSQL
execution is not accepted by this gate; its migration is not yet verified.

Existing state/background requests remain process-local and keep their previous
semantics. Bridge registration adds `fork_supported`; fork needs both Hub and
runtime negotiation. A fork request additionally requires a 16–100 character
`intent_id` containing only letters, digits, `_` or `-`.

The authenticated user, network and intent uniquely identify the operation.
Reusing an intent with another node, source session or binding is rejected.
Only one pending/in-progress fork per network/node is admitted by a database
unique index. Reusing the same intent returns its original request, including
terminal unknown, without emitting a second operation.

If the POST response is lost, `GET /api/node-session-control/intent/:intent_id`
with `network_id` recovers the original receipt for its requesting user, subject
to current node visibility/control authorization. It does not enqueue anything.
The existing request-ID read remains available to authorized node controllers.

Claim is a conditional database update from pending to in_progress. Once
claimed, the row is never returned to pending. Expired pending is expired;
expired in-progress is unknown. A terminal status cannot be replaced by a late
ACK. A second relay/connection can observe the receipt but cannot claim it again.

## Migration, backup and rollback

`server/src/db.ts` creates `session_fork_requests` and its active-node unique
index additively. It stores IDs, deadlines and whitelisted outcomes, not bearer
token values, Server passwords, prompts or filesystem credential paths.

The journal is database state: backups/restores must preserve it together with
the existing identity tables. Git alone does not recover operation history.
Do not delete terminal rows or restore an older journal and replay intents:
either can allow the same real-world operation to execute again. No automatic
retention deletion is implemented; bounded archival/admission policy remains a
release consideration. An untrusted/stale restore must disable fork writes and
require explicit reconciliation rather than treating absent rows as unexecuted.

Rolling back the binary may leave this additive table in place. Old binaries
do not read it; disable the preview flag and do not issue or replay fork writes
during rollback. Re-upgrade must retain tombstones. No production migration,
backup restore or rollback has been executed by the isolated tests.

Bridge registration/retired generations are still process-local. Use process
affinity; durable at-most-once claims alone are not complete multi-worker
authorization or proof that a forked session became a registered new node.

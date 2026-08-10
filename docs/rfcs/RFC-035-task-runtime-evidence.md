# RFC-035 — Task runtime evidence (`runtime_submitted_at` / `consumed_at`)

Status: implementation candidate for issue #520
Scope: additive Hub schema/API first; agent-node runtime wiring follows after the concurrent image-delivery change lands

## Problem

The existing task/session fields answer weaker questions than their names suggest:

| Signal | What it actually proves |
|---|---|
| `delivered_at` | Hub enqueued the task |
| `status=acked` | the long-running agent-node process fetched the inbox row |
| `last_seen_at` | the process sent a heartbeat |
| `started_at` | the compatibility `report_status(working)`/content-match path ran |
| `sessions.task` | a legacy union of sender dispatch echo and node self-report; it may be stale |

None proves that the task body reached a vendor runtime, or that the runtime
actually started the corresponding model turn. Those are different facts and
must not be collapsed into one optimistic timestamp.

## Decision

Add two nullable, task-lifetime columns to `tasks`:

- `runtime_submitted_at`: agent-node handed this exact task body to the vendor
  runtime. This may be set at a prompt/turn request or controlled copresence
  write boundary. It does **not** claim that inference started.
- `consumed_at`: the runtime emitted an authoritative turn-start or first
  attributable activity signal for this exact task. A consumed mark also fills
  `runtime_submitted_at`, because consumption implies submission.

Both fields are monotonic for the lifetime of the logical task
(`COALESCE(existing, now)`). `retry_task` and `reassign_task` preserve them:
issue #520 asks whether this logical task ever crossed each runtime boundary,
and a delayed callback from an earlier delivery must never overwrite or erase
that fact. Existing lifecycle status, `delivered_at`, `started_at`, and
`sessions.task` retain their old semantics for backward compatibility.

Transport-row identity is separate from logical-task identity. Initial
deliveries historically used `inbox.id == tasks.task_id`; retry/reassign create
a fresh `inbox.id`. The additive nullable `inbox.task_id` column links every
redelivery back to the logical task. `get_inbox` exposes that logical `task_id`
for task rows, while ACK/cancel/reassign use the same linkage.

## Hub write boundary

Two internal MCP tools accept batches of exact task IDs:

- `mark_tasks_runtime_submitted({task_ids})`
- `mark_tasks_consumed({task_ids})`

Both tools:

1. require a network-bound node token (`ntok_`);
2. derive network, canonical alias, and immutable `node_id` from authenticated
   server state—not request fields;
3. preflight every task and require `tasks.to_node_id` to equal that node when
   present; legacy/direct token-bound tasks with `to_node_id=NULL` may fall back
   only to the authenticated canonical alias;
4. reject a foreign/missing/duplicate member without partially marking the
   batch;
5. keep identity preflight and all writes in one SQLite transaction, and write
   each logical-task field only once for its lifetime.

The current synchronous PostgreSQL adapter cannot keep multiple statements on
one backend connection. Until that adapter gains real transactions, both tools
fail closed with `task_runtime_evidence_backend_unsupported`; production Hub is
SQLite. This preserves the batch's all-or-nothing claim instead of silently
publishing partial evidence.

User/admin tokens cannot manufacture runtime evidence. An old Hub that lacks
the tools leaves the additive columns `NULL`; execution remains compatible.

## Runtime evidence matrix

The agent-node wiring must preserve this minimum evidence strength:

| Runtime | `runtime_submitted_at` | `consumed_at` |
|---|---|---|
| Codex app-server | exact owned turn submitted/steered | exact `task_started` after `clientUserMessageId` ownership reconciliation |
| Grok copresence | controlled network envelope written to the owned TUI | trusted `network_user` JSONL for the active exact task |
| OpenCode copresence | exact user message POST accepted | exact assistant response causally parented to that message (later but authoritative on pinned 1.18.1) |
| ACP runtimes | `session/prompt` issued for the exact task | first notification after the prompt boundary, or its terminal response |
| Claude/Codex SDK | exact query/stream request created | first yielded event from that request |
| CLI runtimes | prompt-bearing child request started | first protocol event attributable to that invocation |

If a runtime lacks an authoritative attributable activity signal, it must leave
`consumed_at=NULL`. Process entry, inbox ACK, local FIFO admission, generic PTY
write, heartbeat, or a different concurrent turn are forbidden substitutes.

## Read semantics

REST task projections, `get_task`, and `list_tasks` expose both columns. The
four useful states are:

| submitted | consumed | Meaning |
|---:|---:|---|
| `NULL` | `NULL` | still before the vendor runtime boundary (possibly queued locally) |
| time | `NULL` | handed to runtime, but no authoritative turn activity yet |
| time | time | exact runtime activity was observed |
| `NULL` | time | invalid state; Hub's consumed tool prevents this |

These timestamps do not declare success, progress, or health. A consumed task
can still run for a long time, fail, or time out. A queue timeout is likewise a
waiting-window result, not proof of node failure.

## Human-visible traces

The two fields make Dashboard/API diagnosis unambiguous. Copresence runtimes
should additionally show queued/submitted/started traces in the shared human
surface where their upstream UI has a safe notification lane. That UX is not a
license to weaken the database evidence: a toast or log line is not
`consumed_at`.

## Verification requirements

1. Explicitly construct “process connected + inbox ACK + model not awakened”
   and assert both fields remain `NULL` while the legacy `sessions.task` echo is
   already populated and `last_seen_at` is unchanged.
2. Mark submitted without consumed, then mark consumed; prove ordering and
   idempotency.
3. Batch mark multiple exact owned tasks; a mixed owned/foreign batch must
   reject with zero writes.
4. Retry/reassign must preserve both task-lifetime timestamps, expose the
   original logical `task_id` on the fresh inbox row, and ACK that row against
   the original task.
5. Queue-heavy runtime fixtures must prove FIFO admission alone stays blank;
   exact start/activity must turn the corresponding field green once.
6. Mutating any identity check, logical-task linkage, monotonic preservation,
   or exact runtime callback must
   turn a behavioral test red.

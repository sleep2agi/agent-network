# SideThread PR2 Hub contract

Status: Draft, feature-gated, stacked on PR1 #1194. This change is not an
authorization to merge or release.

The Hub owns durable SideThread records, attempts, operation receipts,
bring-back receipts, and metadata-only events. `question_text` and result text
are returned only through an exact owner/node authorization projection. Audit
and SSE events contain identifiers, state, and allow-listed reason codes but
never question/result bodies or runtime exception text.

The runtime boundary is `SideThreadExecutionPort`. It exposes only verified
native exact-fork operations and has no task/inbox/FIFO method. The default
adapter returns `SIDE_THREAD_UNSUPPORTED`; the HTTP surface is additionally
guarded by `COMMHUB_ENABLE_SIDE_THREADS=1`.

Every runtime mutation has a stable `operationId` and a durable operation row.
An accepted request followed by response loss becomes `ambiguous` and returns
`SIDE_THREAD_AMBIGUOUS` with correlation IDs. Replaying the same request key
does not issue a second RPC. A later authoritative event may reconcile an
ambiguous start using the exact `(sideThreadId, attemptId, threadId, turnId)`
ownership tuple.

Public wire names and nullability are frozen in
`contracts/side-thread/v1/schema.json` and `golden.json`. Public JSON uses
`sideThreadId` and `question`; DB/domain `side_chat_id` names do not leak.
Only completed bring-back receipts set `broughtBack=true`, and a unique DB
constraint prevents a second write to the same attempt/destination even when
the caller supplies a new request key.

The capability endpoint requires the requested source thread and exact
boundary in addition to the authorized node. A supported response echoes that
context. This prevents a generic runtime capability from being mistaken for
evidence that one particular exact-boundary fork is supported.

Stack dependency: PR1 rev4 supplies the native runtime adapter's persistent
fork lease, pre-fork snapshot/reconciliation, and runtime operation journal.
PR2 remains decoupled through the execution port; production wiring must map
the Hub's stable operation identity into that adapter and must never substitute
ordinary task delivery.

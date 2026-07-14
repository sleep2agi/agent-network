# Issue #440 H1 design addendum — delivery kinds, lease control, and terminality

Status: **non-authorizing design candidate; no H1 runtime work is authorized by this file**

Anchor: frozen H0 contract/test/report at
`f5a28fecadff6b0b5bdb758ad58ffe5b100e46a9`

This addendum does not alter the frozen H0 bytes. It resolves model ambiguities
found during the pre-C1 architecture audit. It becomes an authorizing H1
contract only after independent review and boundary co-sign. Until then,
production handlers, schema, clients, gateways, deployment, preview, and
release remain unchanged and locked.

## 1. Normative relationship to H0

All H0 security invariants remain mandatory except where this addendum
explicitly narrows an ambiguous sentence:

1. `consumed` is added as a delivery terminal state for a no-response
   resource. It is not an alias for `replied`.
2. Claim and renew are explicit exceptions to the H0 §5 blanket statement
   that every mutation has a durable `operation_id`. Claim is one-shot and
   non-idempotent. Renew is repeat-safe and monotonic, not idempotent.
3. Existing alias-derived token names and historical `node_id` columns do not
   prove immutable binding. H1 performs no automatic authority backfill from
   those fields.
4. Child output is an attachment delivered to the delegating consumer. It
   never recursively terminalizes a parent task.
5. Retry never reopens a terminal task. The retry rules in §7.1
   **normatively replace** the H0 §5 `Retry` paragraph: a retry creates a new
   logical task, delivery, and assignment while the source task and its
   assignment remain byte-stable.

Nothing here weakens the H0 requirements for server-resolved principals,
opaque leases, exact principal/token/epoch predicates, one real SQLite
transaction, PostgreSQL fail-closed behavior, generic ownership errors, or
payload-free SSE doorbells.

## 2. One delivery model for task and non-task inbox resources

Every consumable inbox row has exactly one immutable recipient and exactly one
delivery attempt row. A delivery records:

```ts
type DeliveryResourceKind = "task" | "message" | "broadcast" | "reply";

type DeliveryState =
  | "pending"
  | "leased"
  | "running"
  | "consumed"
  | "replied"
  | "dead_lettered"
  | "cancelled"
  | "superseded";

type DurableDelivery = Readonly<{
  deliveryId: string;
  resourceKind: DeliveryResourceKind;
  resourceId: string;       // non-empty, immutable, server-resolved
  taskId: string | null;    // non-null only when resourceKind === "task"
  networkId: string;
  consumerNodeId: string;
  requiresResponse: boolean;
  epoch: string;            // canonical decimal int64 string at API boundary
}>;
```

For H1, the following definition **normatively replaces** the H0
`ConsumerLease` DTO:

```ts
type ConsumerLease = Readonly<{
  deliveryId: string;
  resourceKind: DeliveryResourceKind;
  resourceId: string;
  taskId: string | null;
  leaseId: string;       // 32 random bytes, base64url; returned once
  epoch: string;         // canonical decimal int64 string
  expiresAt: string;     // server clock, UTC
}>;
```

The pair is an invariant, not a presentation hint:

```text
resourceKind === "task"  iff  taskId !== null
```

In H1 C1, every task delivery has `requires_response=true`. Every message,
broadcast, and inbound reply has `requires_response=false`. A malformed
kind/task pair, empty `resource_id`, or mismatched durable row fails closed
with the same generic delivery-unavailable shape before lease or resource
mutation.

| `resourceKind` | `taskId` | `requiresResponse` | Ack transition / downstream behavior |
| --- | --- | --- | --- |
| `task` | exact non-null task ID | `true` | `leased -> running`; exact task projection; explicit lease reply/dead-letter required |
| `message` | `null` | `false` | `leased -> consumed`; no task, LLM, outbox, lineage, or autoreply |
| `broadcast` | `null` | `false` | `leased -> consumed`; exact-recipient instance only; no task, LLM, outbox, lineage, or autoreply |
| `reply` | `null` | `false` | `leased -> consumed`; attachment/data only; no task, LLM, outbox, lineage, or autoreply |

Rules:

- `resource_id` is always non-empty. It identifies the exact durable inbox
  resource; it is not a caller alias or a fallback to `task_id`.
- Only `task` may set `requires_response=true` and enter the agent/LLM turn
  path.
- `message`, `broadcast`, and inbound `reply` are normalized to
  `requires_response=false`. They are delivered as notifications/data and
  must not enter an automatic LLM turn, reply loop, or delegation path.
- A broadcast creates one inbox row and one delivery per exact immutable node.
  It never creates a shared alias-owned row.
- A task acknowledgement changes `leased -> running` and projects only that
  exact task to `acked`.
- A no-response acknowledgement changes `leased -> consumed`, clears the
  lease, and writes its audit/idempotency result atomically. It performs zero
  task projection, creates zero outbox rows, and triggers zero lineage or
  automatic reply behavior.
- `replied` means an actual response-bearing task completed. It is never used
  as a spelling for message consumption.
- `consumed`, `replied`, `dead_lettered`, `cancelled`, and `superseded` are
  terminal for that delivery ID. No later operation can rewrite its result or
  reopen it.
- `consumed` is terminal-immutable and non-oracular. An absent delivery, a
  delivery owned by another principal/token, and an already-consumed delivery
  return the same generic `lease_invalid_or_not_owned` shape with byte-zero
  mutation. The only exception is an identical `operation_id` replay by the
  same exact principal/token: it returns the stored consume result read-only.
  A different operation ID cannot use the terminal row to learn why it is
  unavailable.

## 3. Claim and renew are lease-control exceptions

### 3.1 Claim

Claim takes no `operation_id`, alias, node ID, epoch, or lease value. It is a
one-shot, non-idempotent lease mint:

- A claim response is the only time the plaintext lease is returned.
- The database stores only `SHA-256(lease_id)`.
- A live `leased` or `running` row is never returned, reissued, or rotated by
  a second claim, including a claim from the same token.
- If the response is lost, the caller waits for the 30-second lease to expire.
  A later successful claim increments the epoch in SQL and mints a new lease.
  The old lease never becomes valid again.
- A lost-response lease is a stranded but still exclusive admission. Until
  its TTL expires, the same resource has exactly one delivery attempt and one
  active lease hash. The server must not create a second delivery row, admit a
  second worker, or mint/return a replacement lease for that resource.
- Per `(network_id, consumer_node_id, token_id)`, at most 10 non-expired
  `leased|running` deliveries may exist. The cap is checked and claimed in the
  same immediate transaction. When the count is already 10, claim returns a
  stable `consumer_inflight_limit` failure **before candidate selection or
  lease mint**. It does not silently return success/empty, evict a row,
  invalidate or rotate a lease, or shorten an expiry. Below 10, the requested
  limit may be bounded by the remaining capacity.
- Concurrent claims use an immediate transaction plus conditional update;
  exactly one caller may change a candidate row.

Durable replay of a lost claim response is deliberately not promised. Such a
promise would require persisting or recoverably encrypting the plaintext
lease, which conflicts with the frozen one-time-secret rule.

### 3.2 Renew

Renew also takes no `operation_id`. It is repeat-safe and monotonic, not
idempotent:

- It requires the exact current principal, token, delivery, lease hash, epoch,
  allowed state, and an unexpired server-clock lease.
- It does not change epoch, lease hash, owner token, or attempt count.
- Its SQL expiry update is monotonic:
  `lease_expires_at = max(lease_expires_at, server_now + 30s)`.
  Repeating immediately cannot shorten the lease or extend it by repeatedly
  stacking TTL windows.
- Every accepted renew writes a security audit row in the same transaction.
- A renew after expiry is rejected. The caller must claim a new epoch/lease.

Ack, no-response consume, reply, dead-letter, cancel, reassign, retry, and all
producer enqueue operations retain durable `operation_id` idempotency.

## 4. Epoch representation and arithmetic

Epoch and task assignment epoch are signed 64-bit database integers. JavaScript
must never parse, increment, compare, or serialize them through `Number`.

- Every increment is SQL-side: `epoch = epoch + 1` in the conditional update.
- Every returned/read value is selected as decimal text (for SQLite,
  `CAST(epoch AS TEXT)`).
- API input is a canonical decimal string matching `^(0|[1-9][0-9]*)$`.
- SQL compares the canonical string to `CAST(epoch AS TEXT)`; application code
  does not call `Number`, `parseInt`, or bigint-to-number conversion.
- Increment predicates include `epoch < 9223372036854775807`. Exhaustion is a
  fail-closed transition conflict, never wraparound.
- The same rules apply to task assignment generations and internal doorbell
  generations.

Tests must exercise epochs above `Number.MAX_SAFE_INTEGER` and prove exact
decimal round-trip plus one SQL-side increment.

## 5. Producer operations and PostgreSQL capability gate

The queue service owns both consumer mutations and producer enqueue:

- `enqueueTask`
- `enqueueMessage`
- `enqueueBroadcast` (one exact-node enqueue per recipient)
- claim, renew, ack/consume, reply, dead-letter, cancel, reassign, and retry

Every method checks the adapter's same-connection immediate-transaction
capability before principal revalidation, target lookup, delivery selection,
or any queue read/write. With the current PostgreSQL subprocess adapter, each
returns `atomic_queue_transactions_unavailable` (HTTP 503 or the equivalent
MCP error) with zero queue, target-resolution, event, audit, idempotency, or
doorbell SQL.

Existing direct `INSERT INTO inbox/tasks` producer paths are not H1-compliant.
H1 cannot be declared complete until all inventoried MCP/REST producers call
the service. A C1 service module by itself is not production authorization.

## 6. Binding provenance and legacy migration

H1 schema migration is additive and fail-closed:

- It adds immutable token binding, immutable delivery recipient, lease,
  epoch, idempotency, and generation columns/tables.
- It does not derive `api_tokens.node_id` from `api_tokens.name` or an alias.
- It does not promote historical `inbox.node_id` or an alias backfill into an
  authoritative `consumer_node_id`.
- It does not create consumable delivery rows for legacy alias-only/null-node
  inbox rows.
- Ambiguous and merely alias-derived legacy rows remain non-consumable until a
  separately reviewed migration proves provenance or the rows are recreated
  by an H1 producer.

A node-token binding is server-created exactly once during the authenticated
node registration flow. It must prove all of the following in one transaction:

1. the live, unrevoked `ntok_` is bound to the exact user and network;
2. the node row is in that network and is the server-resolved registration
   target;
3. an existing binding is either null or already the same node;
4. null may transition to the exact node; a different existing binding never
   changes and requires token rotation;
5. a binding generation/provenance marker and timestamp are stored for audit.

The resolver never falls back to `name='node:<alias>'`, `from_session`, a path
alias, query-string token, or caller-supplied node ID.

## 7. Atomic terminalization and immutable results

Task reply is one queue-service transaction. It must atomically:

1. revalidate the consumer principal and exact active lease;
2. conditionally terminalize the exact original delivery;
3. CAS the exact original task from an allowed non-terminal state to the
   requested terminal state;
4. store the original task result and `completed_at`;
5. create the durable reply/outbox resource, if the exact immutable producer
   has an authorized destination;
6. write task event, security audit, idempotency result, and internal
   doorbell-outbox row.

The outbox may be inserted before the task CAS only inside that same
transaction. A missing task ID, CAS miss, event failure, audit failure,
idempotency failure, reply insert failure, or doorbell-outbox failure throws
and rolls every byte back. Returning `false` from a transaction callback is
not an error and is forbidden for these failure paths.

Completion creates no child task. It must not use `send_task(parent_task_id)`
as a substitute for reply. A terminal task's status, result, and completion
time are immutable; only an identical durable idempotency replay may return
the already stored response without writing.

### 7.1 Retry preserves terminal immutability

Retry is a control operation over an exact terminal H1 source attempt; it is
not a transition that reopens that task. These rules normatively replace the
H0 §5 `Retry` paragraph:

- The source task, result, completion timestamp, delivery, and assignment are
  byte-stable. Retry does not increment the source assignment epoch, change
  its target, clear its result, or move it back to a non-terminal state.
- A successful retry creates a new server-minted logical task ID, delivery ID,
  and assignment. The new task starts as an independent pending attempt with
  no inherited result or lease.
- Before creating anything, the service resolves one exact terminal source
  delivery and its exact immutable H1 assignment. The source task projection
  alone is never authority. The assignment epoch must equal the delivery's
  assignment generation. The source producer is read only from that H1
  delivery/assignment pair.
- With no explicit retry target, the new target is the immutable consumer node
  from the exact source H1 assignment. `tasks.to_node_id`, aliases, and other
  mutable legacy projection fields are never fallback authority. An explicit
  target is resolved server-side to one current node in the same network.
- The server records the exact source task ID in retry audit/idempotency
  provenance only after resolving that source pair. This provenance grants no
  lineage, parent/child, autoroute, claim, lease, attachment, or old-result
  authority. It cannot make the old result claimable by a new or rotated token
  and is never emitted in a node doorbell.
- An identical retry `operation_id` returns the same newly created task
  read-only. A changed request under that operation ID, a non-terminal or
  mismatched H1 source attempt, or a source selected only through legacy
  projection fails before task, delivery, assignment, audit, idempotency, or
  doorbell creation.

## 8. Delegation and lineage isolation

Caller-supplied `parent_task_id`, “most recent parent,” alias matching, or
content matching never establishes lineage authority.

This boundary is load-bearing, not hypothetical. The pre-C1 live evidence
showed both failure modes the model must eliminate: an exact-turn child result
was overwritten/contaminated with an unrelated review payload through inferred
lineage, and a no-response notification created another task which produced a
reply/no-reply ping-pong. The evidence is treated as a RED behavioral shape;
task IDs and payload text are not authorization inputs and are not copied into
the contract.

Delegation creates a server-minted immutable edge while the delegating node
holds the exact active parent lease:

```ts
type DelegationEdge = Readonly<{
  edgeId: string;
  networkId: string;
  parentTaskId: string;
  parentDeliveryId: string;
  parentEpoch: string;
  delegatorNodeId: string;
  childTaskId: string;
  childConsumerNodeId: string;
}>;
```

- Edge creation validates the parent lease/principal/token/epoch in the same
  enqueue transaction, requires the parent task/delivery still be
  non-terminal, and stores the server-minted edge.
- A child result terminalizes only the child task/delivery. It creates an
  attachment addressed to the exact delegator from the edge. The attachment
  is an ordinary delivery with `resourceKind="reply"`,
  `resourceId=attachmentId`, `taskId=null`, and
  `requiresResponse=false`; its exact recipient is `delegatorNodeId` from the
  server-minted edge, never an alias or caller-supplied target. The durable
  attachment also records the immutable source `edgeId`, `childTaskId`,
  `parentDeliveryId`, and `parentEpoch`; a unique edge/child-terminal key
  prevents duplicate attachments. Those linkage fields are internal
  authorization/audit data and are not exposed in the node doorbell.
- Attachment acknowledgement follows the ordinary no-response rule:
  `leased -> consumed`, then terminal-immutable. It never enters an LLM,
  automatic reply, delegation, or task-terminalization path.
- The attachment never appends to, overwrites, or terminalizes the parent.
  The parent consumer must explicitly complete its parent task under its own
  still-valid lease.
- No recursive `chainReplyToParent` write occurs. No sibling, grandparent, or
  unrelated task may receive a result by inference.
- Delegation creation rejects self-cycles, repeated task IDs, a pre-existing
  path to the proposed ancestor, and depth beyond the fixed bound. Replaying
  an identical enqueue operation returns its one stored edge/child; a changed
  request under the same operation ID rejects.
- Multiple siblings produce separate immutable attachments. Concurrent
  sibling completion cannot overwrite another attachment or parent result.
- A child already in flight remains independently completable if its parent is
  later cancelled, reassigned, terminalized, reclaimed under a new epoch, or
  loses its lease. The child terminalizes only itself; the parent remains
  byte-stable. At child completion, C1 creates the attachment only if the edge
  still names the exact current `parentDeliveryId`, `parentEpoch`,
  `delegatorNodeId`, non-terminal parent state, and unexpired parent lease.
  Otherwise it suppresses the attachment and records only a bounded
  `attachment_suppressed_stale_parent` audit on the child transaction. C1 has
  no policy that retains or redirects a stale attachment to a new principal.
  It is never delivered through an alias, stale lease, previous epoch, or
  reassigned consumer.
- A valid attachment commit produces at most the one ordinary payload-free
  `queue_changed` wakeup for its exact recipient. Suppression produces no
  attachment doorbell, and consuming the attachment produces no recursive
  lineage doorbell.
- A no-response message/reply/broadcast cannot create a delegation edge or
  spawn a reply task.
- An auto-route/final-output attempt against a replied, failed, cancelled,
  expired, or otherwise terminal parent is rejected before child task, inbox,
  idempotency, or doorbell creation. Runtime use of `send_task` cannot bypass
  this producer-side terminal-parent CAS.

## 9. Expiry and doorbell generation guard

Lease expiry alone makes a delivery reclaimable; it does not terminalize a
task and does not emit a timeout/retry prompt. A separate business deadline
transition, if configured, must run in the immediate queue transaction and
revalidate exact task status, delivery state, assignment generation, and
epoch before changing anything.

Doorbells use a durable internal outbox written only after an actual state
transition in the same transaction. Each internal row records the expected
recipient, task/delivery generation, and expected post-transition state. The
dispatcher revalidates those fields immediately before emission:

- terminal/replied tasks suppress queued timeout/retry doorbells;
- a newer assignment/epoch suppresses an older generation;
- cancelled/superseded attempts suppress their pending wakeups;
- a failed transaction creates no doorbell row;
- the external node-consumer payload remains only `queue_changed` plus an
  optional count, never task/delivery IDs, lease data, result, or aliases.

An emitted doorbell is only a wakeup. Claim remains the authority and recovery
path.

This also closes the observed stale-timeout shape: a task already carrying a
terminal result received a later timeout/re-dispatch notification. H1 must not
classify process liveness or a queued timer as evidence that the task is still
non-terminal; both the transaction and the dispatcher generation check are
required.

## 10. Retention is part of H1

`retention.ts` must use queue-aware, same-connection transactions:

- `leased` or `running` deliveries and tasks with any live delivery are never
  deleted.
- Terminal delivery, inbox payload, task event, idempotency record, internal
  doorbell, and queue audit references are considered as one retention set.
- The set is deleted only after the longest applicable task, audit, and
  idempotency horizon has elapsed and no child/delegation reference requires
  it.
- Idempotency rows store explicit nullable `task_id`/`delivery_id` references
  so cleanup is not inferred from JSON.
- Parent tasks and delegation edges are retained while any child/attachment
  reference exists.
- A partial cleanup failure rolls back the whole set. PostgreSQL uses the same
  unavailable error until a connection-pinned transaction exists.

## 11. Existing bypass inventory and required disposition

| Existing path | H1 disposition |
| --- | --- |
| `get_inbox` / `ack_inbox` | node-token path delegates to principal-bound claim/ack; alias is removed as authority |
| `send_ack` | requires delivery+lease+epoch+operation ID and delegates to queue ack |
| `send_reply` | requires exact delivery+lease+epoch+operation ID; missing task/delivery is generic failure and queues nothing |
| `report_status` task synchronization | telemetry/session update only; it cannot move an H1 task to running or any terminal state |
| `report_completion` | cannot complete a bound H1 delivery by alias/content/task lookup; bound consumer must use lease reply/dead-letter |
| task expiry/re-dispatch worker | uses the generation-guarded queue transaction/outbox in §9; no pre-check/then-push split |
| `chainReplyToParent` | removed from H1 completion; replaced by attachment-only immutable delegation edges |
| `retry_task` | delegates to the control-principal queue service with operation ID and follows §7.1: exact terminal H1 source, new logical task, immutable source assignment, and no lineage authority |
| `cancel_task`, `reassign_task` | delegate to control/producer-principal queue service with operation ID |
| `send_task`, `send_message`, `broadcast`, REST task enqueue | delegate to atomic producer service; immutable target resolution before insert |
| agent-node codex `REPLY_VIA_SEND_TASK` | removed; completion uses the original delivery lease reply and never spawns a child answer task |
| retention sweeper | follows joint retention rules in §10 |

Legacy paths may remain only for rows explicitly outside the H1 delivery
model. They must fail closed when an H1 delivery exists; there is no fallback
from a failed H1 CAS to alias/content matching.

## 12. Exact RED-to-green matrix

| Gate | RED required before implementation | Green requirement |
| --- | --- | --- |
| Resource-kind matrix | message/broadcast/reply enters LLM or auto-reply, or ack uses `replied` | only task can require response; no-response ack -> `consumed`, zero task/outbox/lineage writes |
| Lease DTO invariant | kind/task pairing is malformed or a legacy DTO omits resource identity | all four kinds carry exact delivery/resource fields; task iff non-null taskId; malformed pair fails closed before mutation |
| Consumed non-oracle | absent, foreign, and already-consumed rows return distinguishable results or terminal row mutates | same generic refusal and byte-zero state; only identical op-id replay by exact principal is read-only success |
| Recipient binding | alias/null-node/ambiguous legacy row can be claimed | only exact new immutable consumer binding is selectable |
| Claim race | two claimers receive one delivery | one CAS winner, one lease, one epoch increment, one claim audit |
| Lost claim response | second claim rotates/reissues active lease | active row absent from claim; after TTL new SQL epoch+new lease; old lease invalid |
| Stranded admission | lost response permits a second delivery/worker before TTL | one exclusive delivery+lease until TTL; no replacement or second admission |
| In-flight cap | principal/token at 10 receives success/empty, or an old lease is evicted/rotated/shortened | fail before selection/mint with stable cap error and byte-zero existing leases; below cap bounds by remaining capacity |
| Renew | renew changes epoch/hash/attempt or shortens/stacks expiry | those fields byte-stable; monotonic expiry; each accepted renew audited |
| Int64 epoch | value above `MAX_SAFE_INTEGER` is rounded | decimal text round-trip and SQL-side increment are exact |
| Lease matrix | wrong consumer/token/hash/epoch/expired lease changes any row | generic refusal and byte-zero mutation |
| Atomic ack/consume | event/audit/idempotency failure leaves half state | delivery/inbox/task/event/audit/idempotency all commit or all roll back |
| Atomic terminal reply via raw `/mcp` | outbox commits on task CAS miss; original stays running/null result; codex answer creates child task | original task terminal/result/completed, reply/event/audit/idempotency/outbox in one tx, zero child task |
| Post-projection failure | injected event/audit/idempotency/outbox fault leaves terminal task or reply | byte-for-byte pre-call snapshot, generic error, zero doorbell |
| Terminal immutability | late/sibling result overwrites terminal result | first terminal CAS wins; changed replay byte-zero; identical operation replay read-only |
| Retry authority and immutability | mutable `tasks.to_node_id` redirects a retry, the source task/assignment reopens, or `sourceTaskId` grants lineage/claim access | exact terminal H1 source pair supplies immutable producer/default target; a new task/delivery/assignment is created; source bytes remain unchanged; provenance is audit/idempotency-only |
| Lineage isolation | unrelated result appends through recent parent or recursive chain | only server edge attachment; parent unchanged; sibling attachments isolated |
| Attachment delivery | child result becomes a task/LLM input or aliases to a recipient | ordinary `reply` resource with null task, no-response, exact delegator; ack -> consumed and zero autoreply/delegation |
| Parent changes during child | cancel/reassign/new epoch redirects attachment or mutates/cascades child/parent | child terminals itself; parent byte-stable; stale edge suppresses attachment+doorbell under explicit C1 policy |
| Lineage cycle/depth/replay | self/cycle/depth overflow or changed replay creates tasks | rejected atomically; identical replay returns one child/edge |
| No-response loop | reply-to-no-reply spawns a task/ping-pong | zero task, LLM, outbox, lineage, or doorbell side effect beyond consumed audit |
| Terminal-parent auto-route | runtime final text targets a cancelled/terminal parent and creates another child | producer refuses before any child/inbox/idempotency/doorbell write; parent stays byte-identical |
| Expiry/terminal race | replied task later emits timeout/retry prompt | transaction + dispatcher generation guard suppress stale doorbell |
| Producer PG gate | PG target lookup/inbox/task SQL runs before refusal | stable 503 and zero SQL for task/message/broadcast enqueue |
| Consumer PG gate | PG principal/queue SQL runs before refusal | stable 503 and zero SQL for all consumer/control operations |
| Legacy provenance | alias or historical `node_id` auto-backfills authority | legacy remains non-consumable without reviewed provenance migration |
| Retention | task/inbox deleted while lease/reference/idempotency/audit remains | joint eligible-set delete or full rollback; active/reference rows retained |
| Bypass sweep | report_status/completion/chain/expiry/direct producers bypass service | each §11 entry is delegated or explicitly fail-closed, with a direct regression test |

The real-entry tests must use strict `Authorization: Bearer ...` through raw
`/mcp`, and bridge coverage must prove the codex completion path replies to the
original delivery rather than enqueueing a child. Unit tests supplement those
gates; they do not replace them.

## 13. Authorization boundary

This addendum contains no implementation and authorizes none. The next step is
an independent docs-only review against the six architecture findings, the
lineage/terminality evidence, and the frozen H0 invariants. Only a recorded
independent acceptance plus boundary co-sign may reopen H1 C1 runtime work.

No merge, deploy, preview, production, release, latest, RFC-030 gateway edit,
or Wave 2 work is authorized.

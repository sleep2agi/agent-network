# Issue #440 H0 — server-resolved consumer principal and lease contract

Status: **H0 contract + expected RED only**

Baseline: `origin/main` at `d4188621c0d9bf5f95e9b1ac9b5d0aafea91c6e3`

Authorizing status: **non-authorizing; H1 production work must not begin until this contract is independently accepted**

This change does not add a schema migration, queue handler, production route,
or authorization decision. It records the current entry surfaces, proves the
same-network cross-consumer gap through the real `/mcp` entry, and fixes the
contract H1 must implement.

## 1. H0 boundary and invariants

The network is a tenancy boundary, not a queue-consumer ownership boundary.
Two nodes in one network are different consumer principals. Knowing another
node's alias, message ID, task ID, or lease tuple never grants access.

H1 must satisfy all of these invariants:

1. Consumer authority is a server-resolved immutable node identity. No alias,
   `from_session`, node ID, token ID, epoch, or owner supplied in tool/REST/SSE
   input can replace any field of that identity.
2. A queue row is selectable only when its `network_id` and immutable
   `consumer_node_id` both match the resolved principal.
3. Every claim is represented by a server-minted, opaque lease plus a
   monotonically increasing row epoch. All post-claim mutations require both.
4. A stale, expired, wrong-principal, wrong-token, or wrong-epoch lease causes
   zero queue/task/audit mutation and returns one non-oracular error shape.
5. The queue state transition, task projection, required audit record, and
   idempotency record commit in one real database transaction or none commit.
6. SSE is a non-authoritative doorbell. It cannot grant ownership, carry a
   reusable lease secret, or compensate for a failed transaction.
7. SQLite is the only H1 database backend currently able to provide the
   required transaction. PostgreSQL queue-consumer operations fail closed
   until its adapter uses one connection for the entire transaction.

## 2. Current surface inventory at the H0 baseline

### 2.1 MCP Streamable HTTP

The real entry is `server/src/index.ts:549-583`:

1. `requireAuth` resolves the bearer.
2. `resolveRequestAuth` expands user/network/token metadata.
3. `callerAlias` is derived from `api_tokens.name` when it starts with
   `node:`.
4. Six positional values are passed through `createServer` to
   `registerTools` (`index.ts:109-116`, `index.ts:557-568`).
5. `WebStandardStreamableHTTPServerTransport` dispatches the JSON-RPC tool
   call.

Queue and task surfaces currently registered in `server/src/tools.ts`:

| Surface | Current authority | Current write grouping | H1 disposition |
| --- | --- | --- | --- |
| `get_inbox(alias, limit)` (`:653`) | network scope + caller-supplied alias | read only | replace/delegate to principal-bound claim; alias is display-only |
| `ack_inbox(alias, message_id)` (`:686`) | network scope + caller-supplied alias | inbox update; task update and event are separate and event errors are swallowed | require active lease+epoch; one transaction |
| `send_ack(task_id, from_session)` (`:1199`) | network scope; token alias only constrains `from_session` | task update | require consumer ownership and active lease+epoch |
| `send_reply(..., in_reply_to, from_session)` (`:1056`) | network scope; no target-consumer check | inbox+task transaction, but task event and lineage work occur outside it | lease-bound reply service; transaction includes durable reply/task/audit/idempotency |
| `retry_task(task_id)` (`:1225`) | any writer in the network | task reset + new inbox row transaction; event outside | control principal only; invalidate old lease and create a new attempt atomically |
| `cancel_task(task_id)` (`:1342`) | any writer in the network | task and inbox writes are not one transaction; event failure is swallowed | producer or control principal only; atomic invalidation |
| `reassign_task(task_id, new_alias)` (`:1374`) | any writer in the network | task+old/new inbox transaction; event outside | control principal only; target resolved to immutable node; new attempt+epoch |
| `get_task` / `list_tasks` (`:1277`, `:1300`) | network-readable | read only | node tokens see only their producer/consumer rows; dashboard control policy remains separate |
| `send_task` (`:800`) | network writer | creates task+inbox | producer operation; target resolves to immutable node before enqueue |
| `send_message` (`:997`) | network writer; caller supplies an alias and `resolveDeliveryTarget` may leave `node_id` null | creates one inbox row | producer operation; resolve alias to one live same-network immutable node before enqueue; never persist an alias-only/null consumer binding |
| `broadcast` (`:1426`) | network writer; recipients come from mutable session aliases and nullable `node_id` values | creates one inbox row per selected session | producer operation; resolve every recipient to one exact immutable node and deterministically skip/reject unbound or ambiguous recipients; no alias-only row |

There is no claim operation, lease renewal, lease epoch, or dead-letter tool in
the H0 baseline. `acked` is a Boolean delivery flag, not a lease protocol.

### 2.2 REST

Relevant current endpoints in `server/src/index.ts` are:

- `POST /api/auth/node-token` (`:826`) mints an alias-named network token, but
  the token row has no immutable `node_id` binding.
- `POST /api/task` (`:1603`) creates task and inbox rows. It is a producer
  surface, not a consumer claim.
- `GET /api/messages` (`:1847`) returns inbox content at network scope.
- `GET /api/task/:id`, `GET /api/tasks/:id`, and `GET /api/tasks`
  (`:2207-2254`) return task content at network scope.
- `GET /api/task_events` (`:1937`) applies only network scope, so an `ntok_`
  can currently enumerate events for another same-network producer/consumer.
- `GET /api/audit-log` (`:1916`) filters non-admin users by `user_id`, not by
  a node consumer principal or exact task ownership; its rows may contain
  queue target identifiers and details.

There is no REST claim/renew/ack/dead-letter endpoint. In H1, `ntok_` requests
must not use dashboard/control-plane reads as an alternate way to read another
consumer's payload. User-token dashboard policy is a separate
`QueueControlPrincipal` decision and must not be conflated with node-consumer
authority.

H1 must close the two secondary read surfaces as part of the same visibility
gate:

- An `ntok_` may read task events only for a task whose immutable producer or
  consumer node matches its `NodeConsumerPrincipal`. A caller-supplied
  `task_id` never widens that selection and a foreign task uses the same
  non-oracular empty/refusal shape.
- Queue security audit reads are not a node-consumer back door. Node tokens do
  not receive another consumer's audit rows, target identifiers, delivery
  identifiers, lease hashes, or idempotency material. Dashboard audit reads
  require an exact-network `QueueControlPrincipal`; any narrower self-audit
  policy remains separate from queue consumption.
- Required claim/renew/ack/reply/dead-letter/cancel/reassign/retry audit writes
  are part of the queue transaction. Audit failure rolls the mutation back;
  the read endpoint's policy cannot weaken that durability requirement.

### 2.3 SSE

`GET /events/:session` is handled at `server/src/index.ts:588-677`.
The `ntok_` path verifies network membership, but the requested session name is
still supplied in the URL. When the token's network equals the requested
network, the current `if (!session && authCtx.networkId !== scopedNetId)` check
does not prove that the token owns that session. This is another same-network
cross-alias surface.

H1 requirements:

- An `ntok_` consumer may subscribe only to the channel resolved from its
  `NodeConsumerPrincipal`.
- The path alias is either removed or required to equal the principal's alias
  snapshot; it never supplies authority.
- Events contain only a doorbell (`queue_changed` and an optional count), no
  content, lease ID, bearer, task result, or foreign row identifier.
- Missing or dropped SSE is recovered by polling `claim`; SSE delivery is not
  part of the queue transaction's success condition.

The baseline has **20 production `pushEvent` callsites**. They currently pass
rich objects to an alias-addressed channel and therefore must be inventoried,
not assumed to be payload-free:

| Callsite | Current event | Current payload fields | H1 disposition |
| --- | --- | --- | --- |
| `tools.ts:478` | `status_update` | `alias`, `renamed_from?`, `status`, `progress`, `host`, `process_telemetry` | separate control/telemetry authorization; never a queue-consumer event |
| `tools.ts:638` | `chained_reply` | `parent_task_id`, `child_task_id`, `child_alias` | exact recipient authorization, then wake-only; strip all three identifiers |
| `tools.ts:959` | `new_task` | `inbox_count`, `priority`, `from`, `renamed_from?` | principal-bound queue doorbell; reduce to `queue_changed` plus optional count |
| `tools.ts:1026` | `new_message` | `from`, `message_id`, `renamed_from?` | principal-bound queue doorbell; strip `message_id` and sender/alias metadata |
| `tools.ts:1177` | `chained_reply` | `parent_task_id`, `child_task_id`, `child_alias` | exact recipient authorization, then wake-only; strip all three identifiers |
| `tools.ts:1187` | `new_reply` | `from`, `message_id`, `in_reply_to`, `status` | principal-bound queue doorbell; strip reply/message identifiers and content metadata |
| `tools.ts:1269` | `new_task` | `inbox_count`, `priority`, `from` | principal-bound queue doorbell; reduce to wake-only |
| `tools.ts:1421` | `new_task` | `inbox_count`, `priority`, `from`, `renamed_from?` | principal-bound queue doorbell; reduce to wake-only |
| `tools.ts:1465` | `broadcast` | `inbox_count` | authorize each immutable recipient; wake-only after its durable enqueue |
| `tools.ts:1763` | `config_update` | `update_id` | daemon/control channel only; authorize exact node and strip ID from any consumer channel |
| `tools.ts:1951` | `restart` | `update_id` | daemon/control channel only; authorize exact node and strip ID from any consumer channel |
| `tools.ts:2292` | `create_node` | `request_id` | daemon/control channel only; authorize exact daemon; doorbell triggers an authorized pull |
| `tools.ts:2728` | `stop_node` | `request_id` | daemon/control channel only; authorize exact daemon; doorbell triggers an authorized pull |
| `tools.ts:3344` | `probe_provider` | `probe_id` | daemon/control channel only; authorize exact daemon; doorbell triggers an authorized pull |
| `index.ts:1725` | `new_task` | `inbox_count`, `priority`, `from`, `renamed_from?` | same principal-bound wake-only rule as the MCP producer path |
| `index.ts:1789` | `broadcast` | `inbox_count` | authorize each immutable recipient; wake-only after its durable enqueue |
| `index.ts:1977` | `node_deleted` | `node_id`, `node_name`, `alias`, `network_id` | separate control-plane authorization; never a queue-consumer event |
| `rename.ts:209` | `node.renamed` to old-alias stream | `txn_id`, `node_id`, `old_alias`, `new_alias` (plus rename metadata) | resolve the affected node and old-alias recipient server-side; authorize a rename control channel or emit a non-oracular wake-only event; never trust the stream alias as authority |
| `rename.ts:210` | `node.renamed` to new-alias stream | `txn_id`, `node_id`, `old_alias`, `new_alias` (plus rename metadata) | resolve the affected node and new-alias recipient server-side; authorize a rename control channel or emit a non-oracular wake-only event; never trust the stream alias as authority |
| `rename.ts:218` | `node.renamed` to each network-member user stream | `txn_id`, `node_id`, `old_alias`, `new_alias` (plus rename metadata) | derive each recipient from current server-side network membership and an explicit control-plane visibility policy; no network-wide fan-out based only on caller input |

In particular, existing identifier fields `message_id`, `in_reply_to`,
`parent_task_id`, `child_task_id`, `child_alias`, `update_id`, `request_id`,
and `probe_id` are not permitted on the H1 node-consumer queue channel. Rename
identifiers `txn_id`, `node_id`, `old_alias`, and `new_alias` likewise reveal
node existence/history and must be stripped from wake-only events unless an
independently authorized control-plane read policy permits them. Every one of
the 20 callsites must either (a) use an independently authorized
control/daemon channel or (b) emit the principal-bound wake-only queue
doorbell. No callsite may treat the target alias passed to `pushEvent` as the
authorization decision.

### 2.4 Database and transaction adapter

Current durable shape:

- `inbox` (`server/src/db.ts:41-54`) has `id`, alias-like `session_name`, an
  optional migrated `node_id`, network ID, and Boolean `acked`. It has no
  owner binding invariant, attempt ID, lease, epoch, or idempotency key.
- `tasks` (`db.ts:178-210`) has `to_node_id` and task status but no assignment
  epoch.
- `task_events` (`db.ts:235-246`) and `audit_log` (`db.ts:577-593`) are
  separate tables. `logTaskEvent` catches and discards every write failure
  (`db.ts:1344-1351`).
- `api_tokens` (`db.ts:429-456`) records network and a mutable name string,
  but no immutable node binding.

`SQLiteAdapter.transaction` executes the closure through one
`bun:sqlite` database connection (`server/src/db-adapter.ts:48-70`). By
contrast, `PgAdapter.querySync` starts a new process/Pool for every statement;
its own comment explicitly says `BEGIN`, statements, and `COMMIT` are not on
one connection (`db-adapter.ts:115-119`, `:195-206`). Therefore the existing
PostgreSQL `transaction` method is not an acceptable queue transaction.

## 3. Authoritative principals

### 3.1 NodeConsumerPrincipal

H1 introduces one structured context, resolved by the server from an exact
Authorization header bearer:

```ts
type NodeConsumerPrincipal = Readonly<{
  kind: "node_consumer";
  userId: string;
  networkId: string;
  nodeId: string;
  tokenId: string;
  aliasSnapshot: string; // presentation/routing hint only
}>;
```

Resolution is fail closed:

1. The credential must resolve to a live, non-revoked, network-scoped node
   token. Query-string tokens cannot create a consumer principal.
2. The token must have an immutable `node_id` binding created by the server.
   Parsing `name = 'node:<alias>'` is not sufficient authority.
3. The token's user remains a member of the exact network and the bound node
   exists in that same network.
4. Ambiguous legacy alias-only tokens cannot consume. They must be rotated or
   unambiguously migrated before H1 consumption is enabled.
5. The principal snapshot is revalidated inside every mutating transaction so
   revocation/rebinding cannot race the request-level resolution.

`report_status` bootstrap may need a narrower bootstrap principal because a
node token can exist before its node row. That exception may register the node;
it does not grant inbox consumption until the immutable binding exists.

No production function accepts the current positional identity list. H1 uses a
single discriminated `RequestPrincipal` object so swapping `clientIP` and an
auth value cannot silently weaken the gate.

### 3.2 QueueControlPrincipal

Dashboard/admin operations use a separate server-resolved principal:

```ts
type QueueControlPrincipal = Readonly<{
  kind: "queue_control";
  userId: string;
  networkId: string;
  role: "owner" | "admin";
  tokenId: string;
}>;
```

It is never manufactured from `from_session`, an alias, or a node token.
Member/viewer access is not sufficient for reassign or retry. A node consumer
may cancel only a task that the same immutable node produced; otherwise cancel
requires `QueueControlPrincipal`.

## 4. Lease and epoch contract

Each task delivery attempt has an immutable `delivery_id` distinct from the
logical `task_id`. The durable attempt records:

- exact `network_id` and `consumer_node_id`;
- `state`: `pending | leased | running | replied | dead_lettered | cancelled | superseded`;
- monotonically increasing `epoch` (64-bit integer, initialized by the server);
- a hash of the current random lease ID, never the plaintext lease;
- `lease_owner_token_id`, `lease_expires_at`, and `attempt_number`;
- the last accepted idempotency operation reference.

A lease returned to a consumer is:

```ts
type ConsumerLease = Readonly<{
  deliveryId: string;
  taskId: string;
  leaseId: string;       // 32 random bytes, base64url; returned once
  epoch: string;         // decimal 64-bit value; never client-selected
  expiresAt: string;     // server clock, UTC
}>;
```

The database stores only `SHA-256(leaseId)`. Lease values are bearer-like:
never logged, audited, persisted in task content, sent over SSE, or returned to
a different token. The fixed initial and renewal TTL is 30 seconds. Clients
renew while processing; server time alone determines expiry.

Every ownership-invalidating event increments `epoch`: a new claim after
expiry, cancel, reassign, retry, or superseding an attempt. An old lease ID
cannot become valid again, even if a row returns to the same consumer.

Mutations require exact equality on all of:

```text
network_id
consumer_node_id
lease_owner_token_id
delivery_id
SHA-256(lease_id)
epoch
state allowed by the operation
lease_expires_at > server_now
```

Failure returns `lease_invalid_or_not_owned` without revealing which predicate
failed.

## 5. Operation semantics

All success paths below run through one queue service and one real SQLite
transaction. The transaction begins by revalidating the principal and ends
only after the required `task_events`, security `audit_log`, and idempotency
record are durable. An audit insert error aborts the state change; it is never
caught and ignored.

Each mutating call carries a caller-generated `operation_id` used only for
retry idempotency. The server stores `(principal, operation_id, operation,
request_digest, result)`. Repeating an identical request returns the stored
result. Reusing the key for different input is rejected.

### Claim

`claim(limit <= 10)` takes no alias or node ID. In one transaction it selects
only rows for the principal's network+node that are `pending` or have an
expired `leased/running` lease, then conditionally updates each winner. It
increments epoch and attempt count, mints a distinct lease, stores the hash,
sets `state='leased'`, and writes the claim audit. Only rows whose conditional
update changed one row are returned. Concurrent claimers can never both win a
delivery.

### Renew

`renew(delivery_id, lease_id, epoch)` accepts only an unexpired `leased` or
`running` row owned by the exact principal/token. It extends expiry by the
fixed TTL and leaves epoch unchanged. Renewal after expiry is rejected; the
client must claim again and receives a new epoch.

### Ack

`ack(delivery_id, lease_id, epoch, operation_id)` means “accepted for
processing,” not completion. It changes delivery `leased -> running`, projects
the logical task to `acked`, retains the active lease for renewal/reply, and
writes task event+audit+idempotency in the same transaction. A duplicate with
the same operation ID returns the original success exactly once.

### Reply

`reply(delivery_id, lease_id, epoch, operation_id, result)` requires a valid
`leased/running` delivery. One transaction:

1. creates the durable reply/outbox row;
2. transitions the delivery to `replied` and clears the lease;
3. transitions the logical task to its terminal result;
4. applies any allowed parent-lineage projection;
5. writes task event, security audit, and idempotency result.

No reply/SSE side effect is emitted when the transaction rolls back. A push
after commit is only a doorbell for already durable data.

### Dead-letter

`dead_letter(delivery_id, lease_id, epoch, operation_id, reason_code)` requires
the valid current consumer lease. It atomically marks the attempt
`dead_lettered`, clears the lease, projects the task to `failed`, and writes
the event/audit/idempotency rows. Free-form error text is bounded and kept out
of logs; the stable reason code drives policy.

### Cancel

Cancel is authorized either to the immutable node that produced the task or a
`QueueControlPrincipal`. In one transaction it moves the logical task and all
live attempts to `cancelled`, clears lease material, increments epochs, and
writes audit/idempotency. A consumer holding the invalidated lease can no
longer ack, renew, reply, or dead-letter.

### Reassign

Only a `QueueControlPrincipal` may reassign. The target alias is resolved by
the server to one exact node in the same network before the transaction. The
transaction marks the old attempt `superseded`, clears its lease and increments
its epoch, updates the task's immutable target, creates a new `pending`
delivery attempt for the target node, and writes event/audit/idempotency.
Changing the old row's alias in place is forbidden because it obscures stale
lease history.

### Retry

Only a `QueueControlPrincipal` may retry a retryable terminal task/attempt.
The transaction leaves the old attempt terminal, increments the task's attempt
counter/assignment epoch, creates a new `pending` delivery for the presently
resolved target node, and writes event/audit/idempotency. It never reopens an
old delivery ID or lease.

## 6. SQLite atomicity and PostgreSQL fail-closed rule

H1 adds an explicit adapter capability for an immediate, same-connection
transaction. The SQLite implementation uses `bun:sqlite`'s immediate
transaction form and every queue statement uses that transaction's connection.
Selection is followed by a conditional update/CAS; the number of changed rows
is load-bearing.

The current PostgreSQL adapter must report that capability as unavailable. On
PostgreSQL, `claim`, `renew`, `ack`, `reply`, `dead_letter`, `cancel`,
`reassign`, and `retry` return the stable error
`atomic_queue_transactions_unavailable` (HTTP 503 or MCP tool error) before
executing a queue read or write. H1 must not invoke the current
`PgAdapter.transaction` and must not advertise PostgreSQL queue support.

## 7. H0 real-entry RED

Test: `server/src/hub-440-consumer-principal-h0-red.test.ts`

The fixture dynamically starts the production `server/src/index.ts`, creates
two distinct network node tokens in one network, registers A and B with
different immutable node IDs through raw `/mcp report_status`, inserts a
B-owned inbox/task row, and sends raw JSON-RPC with
`Authorization: Bearer <A token>` to `/mcp`. It never imports or calls
`registerTools` or a handler directly.

Reproduce:

```bash
cd server
bun install --frozen-lockfile
bun test src/hub-440-consumer-principal-h0-red.test.ts
```

H0 baseline result: **expected non-zero, 1 pass / 2 fail**.

- Positive control: B's bearer reads B's row.
- RED read: A's bearer with `{alias: B}` receives B's content.
- RED mutation: A's bearer with `{alias: B}` changes inbox
  `acked: 0 -> 1`, task `delivered -> acked`, and task-event count `0 -> 1`.

The sanitized raw response and before/after snapshots are recorded in
`docs/tests/report-issue-440-h0-raw-mcp-red.txt`.

The H0 test starts the module-singleton production server on a fixed-for-that-
process randomly selected port. That is sufficient for this isolated RED, but
it is **not aggregate-runner safe**: module caching, shared environment, and a
port collision can interfere when server tests share one process. Until the
server exposes a testable `bootServer({ port: 0 })` handle, this file belongs
in the explicit isolated-test list governed by issue #434. Neither the random
port nor an isolated pass may be represented as aggregate coverage.

## 8. H1 exact file and test plan

No H1 file is modified by this commit. After independent H0 acceptance, H1 is
split as follows:

| File | Exact H1 responsibility |
| --- | --- |
| `server/src/auth.ts` | return token scope and immutable node binding; mint/rotate node tokens with `node_id`; reject alias-only consumer resolution |
| `server/src/index.ts` | parse strict header bearer for consumer operations; construct one structured request principal; restrict ntok SSE to its resolved node; principal-filter `/api/task_events`; apply explicit control-principal policy to `/api/audit-log`; keep REST control principal separate |
| `server/src/tools.ts` | replace positional auth inputs with structured context; delegate queue tools to the service; add claim/renew/dead-letter; remove alias authority from get/ack/reply; gate cancel/reassign/retry; resolve `send_message` and every `broadcast` recipient to an immutable node before enqueue |
| `server/src/node-consumer-principal.ts` (new) | define and resolve/revalidate `NodeConsumerPrincipal` and `QueueControlPrincipal` |
| `server/src/consumer-queue.ts` (new) | implement all operation state machines, CAS predicates, idempotency, audit-in-transaction, and stable errors |
| `server/src/db-adapter.ts` | expose explicit same-connection immediate-transaction capability; SQLite implements it; PostgreSQL reports unavailable |
| `server/src/db.ts` | idempotent migration for immutable token binding, delivery attempts/lease hashes/epochs, task assignment epoch, and operation idempotency; no plaintext lease column |
| `server/src/push.ts` | emit payload-free principal-bound doorbells only after commit; require every one of the 20 tools/index/rename callsites to choose an authorized control/daemon channel or the wake-only queue channel |
| `server/src/rename.ts` | derive old-alias, new-alias, and network-member recipients entirely from the committed rename plus current server-side identity/membership; authorize each recipient under a separate control-plane policy; strip `txn_id`, node/alias history, and other identifiers from any wake-only surface |
| `agent-node/src/cli.ts`, `agent-network/src/client.ts`, `agent-network/src/node-server.ts`, `channel/commhub-channel.ts` | replace get/ack polling with claim lease tuples, renew while running, and supply lease+epoch+operation ID to ack/reply/dead-letter; update their existing unit tests |
| `agent-node/tests/rfc-030-commhub-e2e.ts`, `agent-node/tests/rfc-030-real-node-e2e.ts` | update the real Hub bridge fixtures to use lease-bearing responses without changing frozen gateway protocol files |

Required H1 tests:

1. Convert the H0 real `/mcp` RED into a green test: B succeeds; A read/ack
   receives the generic refusal; inbox/task/task_events/audit remain byte-for-
   byte unchanged.
2. `node-consumer-principal.test.ts`: missing binding, alias-only legacy token,
   revoked token, wrong network, ambiguous alias, query token, viewer/user
   token, and token/node lifecycle race all fail closed.
3. `consumer-queue-claim-race.test.ts`: two concurrent claimers, same row;
   exactly one lease, one epoch increment, one audit, no duplicate payload.
4. `consumer-queue-lease-matrix.test.ts`: wrong consumer, wrong token, wrong
   lease, wrong epoch, expired lease, renew-vs-cancel, reply-vs-reassign, and
   retry-vs-stale-reply all produce zero stale mutation.
5. `consumer-queue-atomicity.test.ts`: inject failures at task projection,
   task event, security audit, idempotency write, and reply insert; every
   failure rolls the complete SQLite transaction back.
6. `consumer-queue-idempotency.test.ts`: repeated identical operation returns
   one result; key reuse with different request rejects; no duplicate reply or
   audit.
7. `consumer-queue-postgres-fail-closed.test.ts`: fake/real PG adapter proves
   the stable unavailable error and zero queue SQL before a real atomic adapter
   exists.
8. `consumer-queue-rest-sse-boundary.test.ts`: an ntok cannot read B via
   `/api/messages`, `/api/tasks`, `/api/task_events`, `/api/audit-log`, or
   subscribe to `/events/B`; B's own SSE doorbell contains no content, row ID,
   lease, `message_id`, `in_reply_to`, parent/child IDs or aliases,
   `update_id`, `request_id`, `probe_id`, rename `txn_id`, `node_id`,
   `old_alias`, or `new_alias`. Exercise all 20 current
   `pushEvent` callsites and prove each uses an authorized non-consumer channel
   or the wake-only consumer shape.
9. `consumer-queue-producer-binding.test.ts`: `send_task`, `send_message`, and
   every broadcast recipient resolve alias to one same-network immutable node;
   missing, ambiguous, stale, or null-node targets create zero inbox rows and
   zero doorbells.
10. `consumer-queue-migration.test.ts`: legacy rows migrate deterministically;
   ambiguous token/alias rows remain non-consumable; no lease plaintext exists.
11. Runner isolation is explicit. The current module-singleton real-entry H0
    RED, and its H1 green replacement until server boot is refactored, run in
    the issue #434 isolated list and must be reported as isolated. A future
    `bootServer({ port: 0 })` handle may make that test aggregate-safe. All
    other new H1 unit/integration files must run in the aggregate server suite;
    both groups are then rerun in clean Docker/network-none, with neither a
    skipped test nor an isolated result mislabeled as aggregate coverage.

## 9. Explicit non-goals for H0

- No production schema, handler, auth, adapter, agent runtime, or gateway edit.
- No claim that the RED is fixed.
- No PostgreSQL queue support claim.
- No merge, push, deploy, preview, production, or release authorization.

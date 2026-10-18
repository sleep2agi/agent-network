# Human follow-ups during an owned Codex turn (#730)

Status: protocol contract, current fallback regression coverage, and the first
V2 receipt compatibility implementation slice (#1155). Active
owned-turn injection is **not implemented** by this change. The current
runtime continues to queue authenticated Dashboard requests ahead of other
waiting work, without interrupting an already claimed turn. This contract
does not change the already released Node preview.142 / CLI preview.176.

## Current behavior and the missing boundary

`isInteractiveDashboardTask` requires a task/broadcast, `dashboard-chat`, a
valid `dreq_` id, and Hub-stamped `auth_origin=user`. A sender named `admin`,
a scheduler, a node, or a legacy row without that stamp is not this audience.
The dispatcher and bridge both use this explicit classification for waiting
priority. `steerIfExternalTurn` alone is not proof of that classification.

The existing external-human-turn path calls `turn/steer` and maps the shared
turn's final answer to accepted Dashboard rows. The owned-turn path instead
has one `PendingTurn`, joined by the original task's `clientUserMessageId`.
Reusing the external path would silently treat one final answer as independent
completion of every injected task. An owned task's final answer must retain
its original task identity. A Hub reply is also not proof that a requirement,
native acceptance, or production adoption has completed.

OpenAI's [app-server protocol](https://developers.openai.com/codex/app-server/)
requires the exact `expectedTurnId` for `turn/steer`; it fails without an
active turn, does not emit another `turn/started`, and cannot override model,
cwd, sandbox policy, or output schema. Protocol acceptance proves additional
input was accepted, not that the model answered that input. Existing external
steering compatibility remains outside this owned-turn implementation slice.

## Required owned-turn protocol

1. Only a Hub-authenticated Dashboard request may enter this new path. Require
   both the explicit audience flag and a locally owned, identity-confirmed,
   started turn. A response id alone, an in-flight `turn/start`, a Hub-validation
   claim, an orphaned network turn after reconnect, or an unknown successor
   cannot establish owned-turn identity. Use the existing waiting lanes in
   those cases. Do not reinterpret a generic steering option as authentication.
2. Recheck the follow-up's scoped, authoritative Hub pending state before
   admission; stale inbox delivery does not override cancellation or expiry.
   Preserve the original task's mapping, receipt, answer and cancellation
   authority. Each follow-up retains its own task/inbox ids, requesting scope,
   thread/turn binding, submission and acceptance evidence. Carry the original
   task id as a relationship, not as a replacement task identity. Persist that
   relationship in the existing durable receipt mechanism before claiming
   recoverability; do not add another private state source.
3. `turn/steer` transports the immutable follow-up identity and input to the
   existing thread with the exact active turn id. Never use `turn/start` on a
   busy thread as an implicit injection, change the thread/model/provider,
   answer approvals, reset context, or interrupt the original turn.
4. Record submission only when the exact body reaches transport. Record
   consumption only after a matching acceptance/identity proof. A wrong turn
   id, missing response, or unknown transport outcome is not consumption and
   is not a successful reply. A known rejection before acceptance can return
   to human-first waiting order. An ambiguous outcome must be reconciled by
   the immutable follow-up identity before resubmitting, to avoid duplicate
   execution. The body must not be replayed merely because a reply is missing.
5. The model may acknowledge or answer the follow-up using an explicit Hub
   reply scoped to its own id. This settles only that follow-up. Shared turn
   activity may indicate continuing work after acceptance, but cannot be
   presented as a separate model response or separate task completion.
6. At shared-turn completion, settle the original task with its original
   final answer/error. Do **not** broadcast that answer as successful completion
   of unresolved follow-ups. Recheck their exact Hub rows. Already replied,
   failed, cancelled, or expired rows need no new turn/reply. For an accepted
   follow-up still awaiting its own answer, schedule one answer-only continuation
   in the existing human lane, identifying what was already injected; do not
   rerun its action body. This continuation uses the same task id and its own
   normal reply path. Failed/interrupted shared turns remain visible and cannot
   become synthetic success; uncertainty requires a bounded diagnostic outcome.
7. Before acceptance, cancellation removes only that waiting follow-up. After
   acceptance, input cannot be retracted; stop waiting/delivery for that task
   according to its authoritative Hub state, without interrupting the shared
   turn or original task. An explicit user instruction to stop work is model
   input; cancellation of one Hub row is not permission to interrupt every row.
8. Preserve per-task finite waiting/response bounds, exact scoped activity,
   capacity retry limits and tool-side-effect guards. Original-task tool work
   must never authorize automatic replay of an accepted follow-up. Race handling
   must cover acceptance versus terminal, cancellation, successor rebinding and
   lost notifications. Reconnect without durable accepted identity uses the
   current fallback; never reconstruct authority from a sender alias or final
   answer text. A local lease/deadline is not the original Hub expiry.

## Incremental acceptance and delivery

### Implemented receipt compatibility slice (#1155)

The existing `NODE_DIR/codex-turn-receipts.json` now supports V1 original-task
rows together with V2 `owned_followup` rows. V2 keeps routing metadata, owner
task/turn relationship, a nonce and SHA256 of intended input; it does not copy
the input or result text. Its stages are `intent`, `accepted`, and `answering`.
Acceptance requires the persisted owner turn and nonce. An answer binding
requires the same thread, a distinct turn and the exact `anet:<follow-up id>`
user-message identity. Repeating that exact answer binding is idempotent.

Recovery retains intent/accepted rows without reading or delivering the owner's
terminal text. An answering row requires that exact user-message client id in
persisted app-server history before it may recover a final answer/error.
Missing or unsupported identity evidence stays unresolved; existing 48-hour
retention bounds still apply. V1 recovery remains compatible. The inspector
performs only history reads; it starts no turn and changes no Hub binding.

Unknown versioned rows/envelopes and malformed V2 rows cause recovery and all
ledger mutations (including direct `save`) to fail before rewriting the file.
The previous bytes are retained. The legacy runtime admission path also refuses
to run an action whose task id already has a V2 receipt, before importing the
runtime. This stops a partially supported adapter from replaying accepted work.
The error is scoped to that request; it does not interrupt the original turn.

This slice does **not** call `prepareFollowUp` from production admission or add
owned `turn/steer`. The subsequent #1156 Hub reconciliation slice below adds
explicit-reply checks, while answer-only admission still needs #1151. Hub runtime
evidence currently rejects a conflicting thread/turn binding; integration must
respect that immutable context and cannot invent activity for the old turn.
The legacy external-human steering policy is unchanged.

Upgrade/rollback: the same existing launcher, node directory and credential
sources apply; no new service, port/proxy mapping, environment variable or
private state file is introduced. This source slice creates no V2 row during
normal admission, and publishes no new runtime package on its own. Before a
later adapter writes V2, the authorized lifecycle owner must back up the existing
ledger and pending-reply state using the established private backup process.
Runtimes older than this codec may discard V2 rows: do not downgrade with V2
pending. Drain/resolve those rows using a compatible runtime in the normal
owner window before rollback. Never clear the ledger as a downgrade shortcut.
Git recreates code/schema/fixture, not those private receipts, Hub data or login
state; recovery needs authorized data backups or independent re-registration.
No complete node disaster-recovery claim follows from the fixture alone.

### Implemented Hub reconciliation and two-turn proof (#1156)

The production adapter checks an existing V2 row against its own `get_task`
result before retry admission. An explicit replied/failed/cancelled/expired
task skips both action execution and another reply, using the existing skipped
outcome and clearing the local receipt/outbound copy. Recovery performs the
same check before inspecting V2 history. Task id, immutable receiver node,
original thread/owner-turn and consumption evidence must all match. Unknown
status, identity, missing context or a failed Hub read retains the row and
authorizes neither a recovered reply nor action replay. An inbox ACK alone is
not a reply; an accepted row never inherits the owner's terminal text. V1
recovery and ordinary queued-task policies remain unchanged.

`test1156-owned-followup-hub` runs production Hub handlers/SQLite with the real
WS client, bridge, V2 ledger and exact answer inspector. It proves that the
follow-up may finish via the existing node-authenticated, task-scoped normal
reply path while its first consumed context remains the original owner turn.
Attempting to reconsume or attribute answer-turn activity to that task is
rejected. The independent local answer turn uses its own client identity;
neither a second Hub binding nor a false old-turn heartbeat is sent. Other
nodes, duplicate replies and a new-turn late reply after cancellation/expiry
are rejected. Terminal tasks are not reopened. This protocol proof uses an
isolated synthetic app-server; it is not a native model or production-node
adoption result.

That protocol increment alone did not admit owned steering or launch answer
turns from production. The subsequent controller below supplies that wiring;
it never copies reply text from an unrelated owner outcome.

### Production controller (#1162)

The production CLI now supplies a durable adapter to the bridge. Only an
explicit authenticated Dashboard audience may join a locally owned turn whose
exact user-message client id has confirmed ownership. A plain alias, generic
steer permission, unknown starting turn, scheduler or orphaned network turn
cannot grant this authority. Unconfirmed work retains the waiting fallback.
Before `turn/steer`, the adapter writes a V2 intent containing nonce/input hash
and the exact original task/turn relationship. It sends exactly one request
with `expectedTurnId`. The response must confirm that turn before acceptance;
lost/uncertain responses retain intent and may only be reconciled against the
original turn's user-message nonce and exact input hash. They never fall back
to resubmitting the action body.

Each accepted follow-up is checked independently on the Hub. Explicit terminal
status settles only that row and frees its handler while the owner continues.
The original final answer belongs only to the original task. At original
completion, the controller checks unresolved rows and queues an answer-only
prompt by the same task id in the same thread; this prompt contains routing
identity and existing-result instructions, never the original action body.
The model is instructed not to run new actions/tools. The code does not resend
the original action, and automatic capacity retry is disabled after owned
follow-up submission, including uncertain acceptance and answer shaping.
This is not a claim of native model/tool isolation acceptance.

Before an answer RPC, a durable V2 `answer_intent` records the expected
`anet:<follow-up id>` identity without inventing a turn id. A missing response
cannot authorize another answer RPC. Exact same-thread history/client identity
binds an `answering` row, including a verified successor echo; ambiguous or
absent identity remains unresolved with finite deadlines. Recovery can adopt
that verified running answer or recover its own verified final text. A
separate bounded reply controller resumes persisted V2 work without accepting
an original action body. The existing receipt/history recovery function itself
remains read-only against Codex. Physical ACK stays on inbox.id; local delivery
dedup and Hub model-consumption evidence remain distinct.

Consumed Hub context stays on the original owner turn; the new answer turn
does not rebind it or renew its lease by pretending to be original-turn
activity. Cancelling one follow-up does not interrupt a shared/owner turn.
The dispatcher still caps total handlers at 20, with one opt-in trusted
priority slot that ordinary handlers cannot occupy. A private recovery Symbol
does not create a forgeable auth-origin flag. Existing ordinary and external
human policies remain compatible without an owned adapter.

The real Hub/SQLite + real WS fixture now also executes the production CLI
adapter and bridge/runtime through owner start, one steer and automatic own
answer. Controller fixtures cover explicit reply, cancellation, both lost RPC
responses, nonce/body mismatch, owner-terminal races, restart answer identity,
capacity and saturation. These are isolated protocol/model fixtures, not
original-device adoption or native-model execution acceptance.

Boundary at the #1162 source release (resolved for capable paired versions below): old Hub `get_inbox` still selects the first 20 rows by
legacy priority/time. A human beyond that page may not reach this dispatcher
yet. The local reserved slot does not prove full-depth Hub selection; that is
a separate P0 inlet task. This increment does not claim that every backlog
depth is now immediately reachable or that existing live nodes have upgraded.

Recovery/upgrade/rollback keep the same launcher, node directory, proxy/ports,
environment/credential sources and existing private ledger/outbound store.
Git reconstructs this source, lockfiles and fixture, not Hub/private/login
data. Back up the private receipt/outbound state through the existing
authorized process before adoption. Earlier codecs cannot read `answer_intent`
and may reject or discard V2; never downgrade with these rows pending. Resolve
them with a compatible controller in a normal owner window before rollback.
Verify the exact installed build/version and a scoped known-task behavior
after authorized adoption; this source/core result alone is not that check.

Recovery inputs remain the same ledger, pending replies and existing Hub/node
authority; no new service, startup script, proxy/port, environment variable,
credential source or private datastore is introduced. Existing launch and
upgrade commands are in the agent-node guide below. To verify adoption after
an authorized upgrade, read the installed exact version and run a scoped
known-task check; this Docker fixture alone does not prove an active node has
upgraded. Rollback still requires resolving V2 rows with a compatible runtime
before using an older codec, preserving authorized backups of receipt/outbound
and Hub data. Git reconstructs software and this fixture; it does not restore
private data or login state. No current node is restarted by this increment.

The first slice adds the contract and Docker tests across the real classifier,
bridge and runtime. They verify the current fallback: no owned injection,
original-only terminal attribution, independent waiting cancellation/deadline,
unconfirmed start/reconnect safety, and authoritative Hub removal. Production
mutations must make these assertions fail. They are not native adoption tests.

The implementation slice must add durable accepted-follow-up ownership,
explicit reply reconciliation and the answer-only continuation together. Its
Docker/CI gates must prove an accepted follow-up is injected exactly once,
does not inherit an original-only answer as its own success, and cancellation
cannot interrupt its owner. Test real WS wire ordering as well as runtime and
receipt integration before merging. If this slice requires a new receipt schema,
include migration, backward reads, crash recovery and the repository's recovery
instructions; a flag with an unsafe partial path is not an implementation.

After required checks pass, publish only exact merged `main` source with the
existing paired Node/CLI release gates. Never republish an immutable prior
version. Original-device acceptance requires a normal authorized owner window;
source, public artifacts, and actual adoption are separate gates. A planning
estimate starts when inputs and work are available; CI queues and native owner
windows do not supply a promised completion time.

## Deployment and recovery boundary

The receipt and Hub reconciliation increments change runtime source as well as
docs/tests/CI. They change no process startup, proxy/port mapping, environment
variable, credential source, production package version, Hub schema or backup
location. Existing entrypoints and upgrade/rollback procedures remain in
the [agent-node guide](../../docs-site/docs/guide/agent-node.md). A clean checkout
recreates this fixture with its pinned Dockerfile and frozen dependency lock.
It does not restore Hub data, user registration, node credentials, or private
receipt state; those require existing authorized backups/re-registration.
Passing this fixture does not establish disaster recovery of a running node.


### Full-depth Hub inlet (#1163)

`get_inbox(human_first: true)` opts into `human_inbox.version = 1`.
After the existing caller/recipient/network authorization, the Hub scans only
id/type/meta/ordering columns in 256-row keyset pages. It stops at the requested
number of authenticated Dashboard requests or the end of the pending inbox;
there is no first-20/100/1000 cutoff. It then fetches at most the original
`limit` bodies (maximum 100; Node requests 20), human first, preserving
priority/created/insertion-sequence order within each class. The ordinary body is not copied
into the scan. Existing callers without the option keep ordinary ordering.
The same scalar query runs on SQLite and PostgreSQL; no JSON SQL extension or
cast of malformed historical metadata is required. Work is linear in examined
metadata when no human is pending; this is not a constant-cost inbox index.

Only task/broadcast rows with server-stamped `auth_origin=user`, exact
`source=dashboard-chat` and a valid `dreq_` contract qualify. Legacy/unknown,
malformed, node-stamped or scheduler rows stay ordinary. Node rechecks this
contract independently; selecting does not ACK, consume, renew a task lease,
interrupt an active turn, or reserve more than its existing 20 handlers.
Old Hubs strip the optional request key and return their ordinary first page;
the Node warns once that full-depth capability is missing. Old-Hub fallback
is explicitly partial, not evidence that deeper requests became accessible.

Recovery: server source/schema/locks and the [Hub launcher](../../deploy/hub/README.md) and [fleet launchers](../../deploy/fleet/README.md)
remain authoritative; reverse proxy, port mappings and safe environment/secret
sources follow the [Hub recovery procedure](../../deploy/hub/README.md) and [node recovery procedure](../../deploy/fleet/README.md). Upgrade the Hub and
Node/CLI exact main release in their owners' normal maintenance windows, then
verify the versioned inbox response and real original-node delivery. This
change does not restart/adopt the current node or change its thread/model/login.
Rollback uses the previous immutable Hub and paired Node/CLI versions; pending
V2 answer-intent receipts must not be handed to older V1 readers (see the
controller recovery section). Inbox/task data, identities and receipts require
the documented private backups; a clone recovers software, not those records.
The existing Hub runbook explicitly leaves the vault recovery record name NOT COVERED; this increment does not certify a full production-data recovery drill. No production secrets or full private backlog enter Git.

Same-second rows break ties with the existing SQLite rowid. PostgreSQL adds
`inbox.rowid BIGSERIAL` through the existing idempotent rowid migration pattern;
new inserts preserve insertion order. Historical equal-timestamp PostgreSQL
rows have no recoverable original arrival sequence; the migration assigns a
stable order without claiming reconstructed timing. Body and metadata scan
use the same ordering. The extra column is ignored by old Hub versions, so
software rollback does not drop data or require schema reversal.

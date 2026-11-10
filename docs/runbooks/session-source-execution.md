# Source-aware session execution (internal, disabled by default)

This increment executes the **session API operation**, not complete node creation.
Attach resumes the exact existing session with GET, retaining its current bridge
owner; fork uses the existing single-POST `forkV2Session` and verifies a distinct
child session. Both return `session_ready`, `bridge: not_created`. There is no
new TUI/bridge/node/token/profile, no server start and no takeover of an owner.

## Existing entry points reused

- `opencode-copresence/v2-session.ts` already GETs a requested `resumeSessionId`,
  verifies ID/directory and refuses fallback creation. That small GET/scope rule
  is extracted to `v2-resume.ts:resumeV2Session` and used by BOTH the existing
  runtime and this adapter. Model reconciliation/attach scripts are not invoked.
- `v2-fork.ts:forkV2Session` already reads the source, POSTs exactly once to
  `/api/session/<source>/fork`, requires a different valid ID, then GETs the child
  to verify scope. It is reused unchanged; no second session/fork protocol.
- `session-source-evidence.ts` retains its actual endpoint/config/registry,
  canonical filesystem and Linux listener/PID/startTicks/session lease reader.
  Its new `execute` method operates in that same reader instance; it never trusts
  a URL/path/source assembled by a client.
- Busy detection follows `session-background.ts`'s exact `/api/session/active`
  data shape, not Hub heartbeat. Local bridge conflicts use existing private
  launch-health records and `readLiveProcess`, not hostname or invented ownership.

## Hub-read task and durable single claim

`createSessionSourceExecutionQueue(evidenceQueue, {enabled:true})` is an internal
transport adapter. Without the explicit option it is disabled. No MCP/HTTP/CLI/
SSE registration or ordinary-daemon fallback is added.

`queue(humanRequest, admissionRequestId)` accepts only an ID. It does not accept
a receipt payload, client binding, URL, session override or directory. The Hub
joins the actual immutable source_reserved row, claimed grant and reserved intent
with their exact network/daemon/source/session/mode/workdir/lease/recheck binding.
It reauthenticates the original human and current permissions using the existing
evidence queue. Live queue/lease association and admission deadline must remain.

The new `session_source_executions` table has a UNIQUE admission_request_id.
Its task is immutable through this API. `take(authenticatedDaemon, executionId)`
revalidates user/source/network and the exact original bound daemon credential,
then atomically marks pending -> claimed **before delivery**. Repeated/concurrent
take, including after Hub restart, never delivers again. Lost delivery is unknown,
not permission to reset/requeue. A new execution ID cannot bypass the association.
The old node_create_requests row is never mutated or promoted: its original
immutable triggers and ordinary-daemon pull exclusion remain intact.

ACK records only a strict result matching that task. Attach must report the
original session ID; fork must report a distinct ID. ACK does not grant future
authority and may record a known completion after the observation deadline.
Authenticated historical `recover` only returns stored results or unknown for a
claimed task without an ACK. It neither dispatches nor changes claim state.

## Daemon execution context and journal

`createSessionSourceExecutor(reader, privateJournalDirectory)` requires an
explicit private canonical same-uid directory. This is a **new execution journal**,
not a node profile/config or secret store. Before any API operation, a per-admission
O_EXCL 0600 file plus fsync(file + directory) records an uncertain claim. Concurrent
requests/processes find that file and recover; they never repeat a fork/new POST.
Completed/refused/unknown results replace it using private temp + fsync + rename
+ directory fsync. A restarted executor can read known child IDs without API calls;
a torn/missing completion must never become permission to repeat a mutation.
Disk corruption/permission errors fail closed rather than retrying the API.

The same reader must retain the exact confirmed opaque lease in memory. The task
must match its whole locally cached evidence, including user/token/network/
daemon/source/session/mode. Expiry, changed local files/process/session or reader
restart refuses before POST. Each lease is single-execution, marked before await.
A module-local per-source lock holds across validation and the HTTP operation.

Within that context, the adapter rechecks real private endpoint/owned canonical
directory/live process/session, rejects another live bridge health owner for the
same source, and requires a valid inactive `/api/session/active` snapshot. Every
operation and the fork helper's child verification use the same local endpoint
and directory. Only the selected source fork path may POST; `/api/session` new,
prompt, background, model, takeover and arbitrary URLs are not allowed.

Attach performs resume GET and returns the existing ID, **without adding another
bridge**. Fork returns only after the helper's distinct-child GET/scope verification
and a final lease recheck. Failure before any POST is refused. Once POST is
attempted, any request/parse/verification uncertainty remains unknown and is never
retried. A local result can be re-ACKed read-only if the Hub ACK was lost.

## Precise concurrency/trust limits

The local lock serializes this adapter's cooperating operations, not all native
OpenCode/TUI writers. As documented by the existing V2 runtime, 2.0.22 has no
native atomic idle lease. `/active` is a snapshot, not a lock: an external TUI can
start work after it, and a same-uid writer can alter files/processes between
reads and use. This code does not claim distributed atomicity, durable Server
incarnation, resistance to malicious same-uid processes, or exclusion of arbitrary
cross-process Server writers. It never interrupts a busy session or starts a
competing bridge. Production activation must keep these limits visible.

## Tests and remaining delivery gap

The Docker fixture uses actual loopback HTTP, private real files, SQLite auth and
Linux process observation, but a **controlled fake server reporting 2.0.22**.
The existing native test is opt-in via ANET_OPENCODE_V2_BIN; the cached image's
standard @opencode/cli and opencode binary paths were absent. Nothing was fetched.
This is not a native binary or native ownership-protocol acceptance claim.

Still absent: child node identity/token and secret delivery, new bridge ownership
registration/lifecycle, source-aware runtime handoff, client integration and
production dispatch. `session_ready` is a verified session operation, NOT a new
online ANet node. Attach deliberately does not claim that a second bridge attached.
No profile/credential/SSE operation or public source_ref acceptance is enabled.
# Follow-on identity delivery

Managed-source fork now has a default-off client/daemon REST entry; see
[source transport contract](session-source-transport.md). This does not expose
ordinary `create_node` source_ref or enable attach/new-session lanes.

The separate [internal delivery layer](session-source-delivery.md) adds real
child token metadata, one-shot secret payload, private profile and authenticated
registration fixture coverage, plus a concrete child-only CLI/shared-resume
launch adapter. Upstream native V2 acceptance and production/client dispatch
remain closed; `session_ready` alone does not imply an online child node.

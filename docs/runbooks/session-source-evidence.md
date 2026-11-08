# Internal read-only source evidence (#4150 / #590)

The reader can return **constrained, short-lived read evidence**. Its internal
async `admit` consumer now also obtains a fresh authenticated lease confirmation
and atomically issues/claims a grant with a real `source_reserved` reservation.
It cannot attach/fork/create a running node or dispatch a reservation.
No HTTP/MCP/SSE entry point is registered; the queue is disabled unless its internal
constructor receives `{ enabled: true }`. No environment flag enables production.

## Code and existing mechanisms reused

- `server/src/session-source-evidence.ts`: internal human request → daemon-only
  one-shot take → strict challenge-bound ack → same-human result. It follows the
  catalog's pull/ack pattern, without a doorbell or changes to its public tools.
  The existing catalog queue cannot hold source session/challenge/lease results:
  its whitelist deliberately accepts only catalog snapshots. This separate small
  in-memory queue does not change that compatibility/security boundary.
- `session-source-issuer.ts`: reuses real human/network/source/create permissions
  and management/liveness prerequisites from c66670c0, on queue/take/ack/result.
  The current stored-credential check is exported from `node-session-control.ts`
  (same implementation, no new authentication bypass). Stored requester checks
  are internal-only and never treat a client token ID as authentication.
- `contracts/session-source-evidence.ts`: exact-key request/result validators.
  A request contains IDs, Hub-read alias, selected session and a random 32-byte
  challenge, current user/token row IDs and mode, with a 15-second deadline.
  It has **no URL, path or credential material**.
- `agent-node/src/runtime/session-source-evidence.ts`: executable daemon reader,
  local `recheck(leaseId)` and internal pull/read/recheck/ack handler. The caller
  must supply the existing authenticated transport; no CLI/event integration is
  activated. Errors return fixed refusal codes, never filesystem/API responses.

The reader reuses `child-workdir.ts`'s existing registry and workdir policy,
`opencode-catalog-dispatch.ts:findOwnedOpenCodeNodeDir`, the private catalog endpoint
reader, `launcher-health.ts:readLiveProcess` and the real Linux
`opencode-host-shared-observer.ts:observeHostSharedServe` listener observation.
There is no new profile/config/secret discovery or URL selection system.
Unregistered projects **refuse**, rather than using childWorkDirFor's legacy cwd
fallback. Both daemon registry and local node config must be private, same-uid
regular files. Canonical project and metadata directories must be same-uid,
non-symlink, not group/world writable, and pass the existing allowed-workdir policy.

`opencode-copresence/v2-session.ts` already creates/resumes with session APIs,
publishes the catalog endpoint and launch health. `v2-fork.ts:forkV2Session` already
does source GET plus fork, but is intentionally NOT invoked by this read-only
path. The existing health record's misleadingly named `generation` field is the
**session ID**: here it only binds the selected session to the local live bridge
and serve process, never proves a server incarnation. The bridge/serve PID start
ticks and listener inode are observed and compared before/after the GETs.

## Successful evidence scope

The reader only queries its existing private literal-loopback endpoint:

1. Authenticated `GET /api/info`, requiring exact reported API version `2.0.22`
   and PID equal to the real observed listener owner.
2. Unauthenticated `GET /api/info`, requiring 401 (existing V2 readiness rule).
3. Authenticated `GET /api/session/<selected-session>`, requiring matching ID and
   exact canonical owned directory in `data.location.directory`.

Requests have a timeout and bounded response body, forbid redirects, and never
POST/new/fork/prompt/reload/restart. Endpoint auth remains local. After GETs, it
rechecks registry, project/metadata directory dev/inode/uid, config binding,
endpoint, local bridge/serve identity and real listener identity. Returned evidence
contains only the challenge binding, canonical directory dev/inode/uid, observed
PID/startTicks/listener inode and an opaque daemon-memory lease ID.

`kind: process_local_lease` means exactly that. It is NOT durable incarnation,
cryptographic Server attestation, binary-package version attestation or proof
against a malicious same-uid daemon/runtime. API version is an exact protocol
gate, not a binary hash. The daemon is the trusted filesystem/process reader;
Hub validates its authenticated authority and nonce association, not remote /proc.
The pinned V2 binary itself was not executed in the controlled fake-server tests.

Each reader instance remembers the local fingerprint only in memory. `recheck`
performs the reads again and permanently retires the lease on mismatch/failure.
New daemon reader instance or Hub queue instance cannot recover old state;
expiry permanently retires it. No mtime/hostname/heartbeat/string is promoted to a
durable generation. A saved result is historical evidence until daemon recheck,
not permission to use a session. The handler rechecks just before ack; subsequent
use still requires its own fresh authenticated daemon round-trip.

Hub accepts only the exact one-time challenge it issued, from the exact bound
daemon credential that took the task, while requester permissions and management
relation still hold. Wrong daemon/source/network/session, stale credentials,
replayed ack, cross-restart state and arbitrary extra fields refuse. Result
retrieval is restricted to the original authenticated human credential and also
revalidates the daemon credential. These read/recheck endpoints alone write no
grants/tokens/create rows; the explicit internal async consumer below reserves.

## Implemented async issuer consumption (internal only)

Use `createSessionSourceEvidenceQueue({enabled:true}).admit(request,
evidenceRequestId, intentId, childName, dispatchRecheck)`. This is the async issuer
orchestrator; the older synchronous `createSessionSourceIssuer().issue` remains a
permission/evidence-prerequisite inspector and does not gain a fake success path.
Do not bypass the async consumer by passing a client binding to the grant store.

1. Authenticate the original human credential and re-read current issuer
   permissions, source/daemon management and evidence prerequisites.
2. Persist a single intent association before awaiting: UNIQUE user/network/
   intent, evidence request, opaque lease and recheck request. A retry, including
   a new evidence request under the same intent or another intent against the
   same evidence/lease, explicitly refuses. Failed/lost checks keep their
   association (`checking` or `refused`), never reset to permit another grant.
3. Create a fresh random recheck challenge, bounded by original evidence expiry
   and at most five seconds. It freezes the exact original evidence (including
   user/token/network/daemon/source/session/mode/lease), intent and child name.
   `dispatchRecheck` receives only its evidence request ID; its return value
   cannot authorize anything. There is no production dispatch wiring.
4. Authenticated `takeRecheck` goes only to the exact daemon credential that
   produced the evidence. `handleSessionSourceLeaseRecheck` calls the SAME local
   reader instance's `confirm`: exact locally cached evidence, one confirmation
   per lease (marked before await), then actual filesystem/process/session reads.
   A restarted reader or expired/changed lease cannot answer. `ackRecheck`
   authenticates that same daemon and validates the entire one-time challenge.
5. After the async transport returns, enter a synchronous SQLite transaction.
   Recheck human/daemon/source permissions, credentials, same queue entry and
   confirmed challenge, deadline and durable intent association. Only then
   `store.issue` plus existing adapter `reserve` issue/claim the grant, INSERT the
   real immutable `source_reserved` row and atomically mark the intent reserved.
   Failed INSERT rolls back grant issuance AND claim. There is no HTTP, profile
   read/write, child token, secret blob or SSE in that transaction.

The grant's existing `server_generation` storage column contains
`process_local:<opaque-lease-id>` and `binding_id` is the fresh recheck request ID.
Neither denotes durable Server incarnation; this is an explicitly scoped
**admission observation**. Existing grant claim/recovery and adapter synchronous
signatures are unchanged. 43096cc5 immutable/non-dispatchable guards are untouched.

The receipt has `scope: admission_only`, `dispatchable: false`, and a required
`source-aware-v1-required` execution protocol plus
`daemon_recheck_in_execution_context_required`. The intent journal persists this
guard, original lease/recheck association and admission authorization deadline.
`authorized_until` bounds admission, not an interval of execution authority.

`recoverAdmission` is a separate synchronous, authenticated, read-only historical
receipt lookup, using existing adapter recovery. It returns
`historical_admission_only`, `execution: not_authorized`, `dispatchable: false`.
It can recover a committed receipt after losing the async response or queue
instance, but cannot continue checking, issue another grant or regain a lease.

## Remaining source-aware execution protocol

Follow-up: [source-aware session execution](session-source-execution.md) now
implements an opt-in separate durable execution journal and daemon API adapter.
It performs actual resume GET or existing fork helper POST with local execution
lease checks; no second bridge or child node credential/registration is created.
The admission receipt itself remains non-dispatchable by ordinary daemons.

**A successful daemon recheck does not freeze remote state until SQL commit.**
The explicit negative test changes the session directory after the ACK: admission
can still be retained, but the daemon execution-context recheck fails. There is
no distributed atomic promise and the grant must never be interpreted as
permanent cross-generation authorization. Actual attach/fork must revalidate
the source session, canonical ownership, active process/lease and permissions in
its own authenticated source-aware execution context before acting. Deadline or
reader/queue restart cannot continue this admission flow; a historical receipt
is not an execution capability. Defining the execution protocol, safe child
credential handoff, crash outcomes, source-aware dispatch and client integration
remains separate work; ordinary daemon pull cannot consume these reservations.

No promotion, tombstone mutation, ordinary-daemon fallback, token mint or doorbell
is added by this increment. Public source_ref rejection remains unchanged.

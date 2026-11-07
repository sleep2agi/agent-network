# Internal source-create admission (#4150 / #590)

This is **not enabled node creation**. No HTTP/MCP issuer or client entry is
connected. The public `source_ref` refusal and daemon/runtime source guards stay
unchanged. The target runtime remains OpenCode V2 2.0.22; this change installs no
runtime and does not change its version or launch configuration.

## Implemented boundary

`server/src/session-source-create.ts` exposes an internal adapter using the real
`DbAdapter` and migrated `node_create_requests` table (not a fixture table).
Only SQLite with affirmative atomic-transaction support is accepted.

- `reserve(sourceRef, name, revalidate, now)` revalidates authorization, claims
  the opaque grant and inserts the corresponding create-request metadata in one
  same-connection transaction. An insert failure also rolls back the claim.
- The **future authenticated issuer** must implement the synchronous `revalidate`
  callback using existing create-node permission and source-access rules plus
  authenticated live daemon/session/binding/generation/canonical-directory
  evidence. The callback is mandatory on recovery too. This is a contract for
  trusted server code, not an authorization implementation or client proof.
- Request daemon/network/directory come only from that verified binding, matched
  against the grant. There is no client workdir, URL, flags or secret parameter.
- The grant's unique request ID and request's unique `source_ref` record one
  admission. `recover` returns that same receipt read-only after a lost response,
  even after expiry/reopen; repeated `reserve` fails. Grant consumption is never
  undone after commit. This does not deduplicate separately issued grants: the
  future issuer must own user-intent deduplication before issuing another grant.
- `source_reserved` is an immutable, non-dispatchable tombstone. SQLite triggers
  validate the claimed-grant relationship on insert and refuse update/delete of
  source rows, including clearing `source_ref` or promotion to ordinary pending.
  These rows do not reserve a child name/capacity or constitute an executable
  launch spec. `model=NULL, flags_json={}` are deliberately inert metadata.
- No child token (including hash metadata) is minted, no pending env/secret blob
  is stored, no network/profile write or SSE doorbell occurs. Ordinary daemon
  pull requires `pending`; registration finalization and orphan sweep also ignore
  this status. Ordinary rows have `source_ref=NULL` and keep their old behavior.

## Still required before enabling a client flow

1. Complete the issuer's independent Server/session/generation and canonical
   directory-ownership evidence (including restart invalidation) and intent
   deduplication. Real Hub-side permission revalidation now exists below, but
   intentionally cannot issue a grant without those independent proofs.
2. Define a source-aware daemon capability/pull/launch protocol with V2 2.0.22
   attach/fork semantics and fresh binding/generation/directory checks at launch.
   Ordinary create handlers must never receive a source request as blank create.
3. Define durable launch outcomes/recovery and explicit lifecycle/retention for
   these tombstones. There is intentionally **no promote/dispatch API**; enabling
   one requires a reviewed schema/protocol change, not an UPDATE to pending.
4. Atomically persist any future child-token hash metadata with launch admission,
   then manage plaintext token/env blob outside the transaction. Resolve the
   commit-to-memory-to-doorbell crash window without unclaiming or blind replay.
5. Add client handling and real end-to-end tests. A reservation receipt is neither
   a running node nor a successful fork.

## Real issuer permission and evidence reader

Follow-up: [internal daemon source evidence](session-source-evidence.md) now has a
successful read-only challenge/reader path AND an opt-in async `admit` consumer
that performs authenticated lease confirmation before issuing/claiming one grant
and reserving a real request. Its scoped process-local admission observation is
not execution authority. The synchronous legacy inspector's refusal boundary
below remains; use the async consumer rather than injecting a binding.

`server/src/session-source-issuer.ts:createSessionSourceIssuer` is internal only.
It takes an actual bearer-authenticated `Request` and a strict routing selection
(`network_id`, `source_node_id`, `daemon_node_id`, `mode`), never caller-asserted
user/session/binding/directory/URL. `inspect`/`issue` return typed refusals;
`revalidation` supplies the admission adapter's callback and throws a typed
`SourceIssuerError`. `reserve`/`recover` compose that callback with the existing
adapter. There is no positive verified-binding constructor or injected evidence
provider: **even an admin with fresh managed nodes cannot issue a grant yet**.

Proven/reused authorities:

- `auth.ts:resolveToken` / `lookupToken`: current token hash authentication,
  expiry, revocation and idle-session checks. A stored token ID, master token or
  network/node token is not accepted as a human issuer credential. Authentication
  may update the existing `last_used_at` metadata; no source-state write occurs.
- `network-scope.ts:getUserNetworkIds`, `canRestWriteNetwork` and
  `auth.ts:getUserNetworkRole`: live network membership and create_node's exact
  network admin/owner policy (no new Hub-admin bypass).
- `agent-access.ts:canSeeAgent`: source visibility in the selected network,
  checked separately from create permission. Owning a source or having a source
  read grant alone cannot confer daemon creation permission.
- Actual `nodes` rows scope the target daemon and source. Daemon host role is a
  prerequisite declaration only; `can_create_nodes=false` refuses as create_node
  does; a reported runtime allowlist excluding opencode-cli also refuses. No
  hostname, URL, alias-only or node-ID-prefix management inference.
- `readEvidence` reads succeeded ordinary creation records matching the exact
  source `child_node_id`, or active `node_daemon_bindings`, within the same
  network; absent/conflicting/different-daemon relations refuse. This is a
  conservative journal lookup, not a claim that management proves a session.
- Exact node/network heartbeat receipts must be within 75 seconds, not in the
  future, and source/daemon must have currently valid, immutable bound node
  credentials whose user still has network write access. Receipt liveness is
  not a Server-generation lease (`tools.ts:report_status` stamps last_seen_at
  with Hub `datetime('now')`). All prerequisites are re-read on use.

Concrete unavailable authorities (never replaced by test memory objects):

- `node-session-control.ts:createNodeSessionControlRelay`, `/bridge` branch:
  authenticates the node token but receives `session_id`/`binding_id` from that
  node and keeps a process-local bridge Map. Its own comment explicitly says the
  fork journal is not a Server identity/authorization-generation registry.
- `agent-node/src/runtime/session-control-bridge.ts:localBinding`/`register`
  checks a local session and sends those two fields; the wire includes neither
  independent Server-generation evidence nor canonical-directory ownership.
- `node-daemon-bindings.ts:requestAdopt` persists the requested `workdir`, and
  `ackAdopt` records adoption. `agent-node/src/runtime/adopt-local-identity.ts:
  verifyAdoptionLocalIdentity` has real local filesystem ownership checks, but
  does not transport canonical inode/uid/Server-generation proof to this Hub;
  it also refuses the general OpenCode copresence adoption path. Stored adoption
  paths, creation workdir, project_dir and config_snapshot are not source proof.
- `agent-node/src/runtime/opencode-shared-server-registry.ts:
  readHostSharedOpenCodeServer` reads a local loopback registry/password-file
  configuration. That is neither a Hub source-session entitlement nor a remote
  attestation protocol. The issuer never reads that file or follows a URL.

Therefore successful permission/evidence prerequisites yield
`source_evidence_unavailable` with missing `server_session_generation` and
`canonical_directory_ownership`, not a `SessionSourceBinding`. The next required
daemon protocol must bind independent live Server/session/generation and local
canonical ownership evidence to the authenticated daemon/source/network plus a
fresh Hub request, with restart invalidation. This patch sends no such challenge,
does not persist pretend proof, does not promote a reservation and changes no
existing daemon behavior. Tests of active-adoption rows are DB-reader fixtures,
not claims of a supported OpenCode copresence adoption/launch flow.

## Recovery and deployment scope

No service/port/proxy/environment/secret-source changes or production operations.
Existing Hub startup remains unchanged. Additive migration installs `source_ref`
and SQLite guards after the legacy create-request table rebuild. New state is
SQLite metadata and needs the normal database backup; it is not recoverable from
Git alone. Read-only recovery requires both grant and request rows. An old Hub
ignores `source_reserved` for daemon dispatch but has no supported recovery API;
do not manually clear grants/tombstones or change them to pending when rolling
back. Ordinary create's in-memory secret lifecycle is unchanged.

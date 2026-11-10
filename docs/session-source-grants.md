# #4150 internal source grant storage candidate

No issuer endpoint or creation route is enabled. This is durable storage for a
future authenticated source authorization contract, not source authorization
itself. Existing ordinary create-node fallback behavior is unchanged.

The daemon's ordinary create handler rejects a present `source_ref` at request,
node_spec or node_spec.flags level, including null/empty/malformed values. It
must not silently drop a source request and continue with ordinary creation.
This is an unsupported-field guard, not a grant validator or supported source
creation API. Future integration must replace it with authenticated validation,
not remove it while leaving the ordinary fallback path reachable.

The Hub MCP `create_node` schema also explicitly forbids `source_ref` at root
and node_spec level; the SDK's ordinary unknown-key stripping must not erase
the user's source intent before the daemon can reject it. String, null, empty
string and object payloads are refused by schema validation. This is MCP
coverage only, not proof about an unrelated REST/client serializer. No supported
source_ref payload or source creation entry is advertised by this change.

## Immutable binding

A random 256-bit `source_ref` binds exactly: authenticated user, network, source
node, target daemon, source session ID, binding ID, Server instance generation
proof, daemon-canonical directory, and attach_existing/fork_independent mode.
The ref is not a bearer credential: possession alone must never authorize use.
The issuer must derive all fields from trusted evidence and enforce both
create_node permission and access to the specific source session/directory.
Catalog read permission and client-provided IDs/paths are not that evidence.

The store does not resolve URLs, paths or process identity. In particular,
`server_generation` is a placeholder for a verified instance proof, not a
user-chosen label or merely an executable version. There is currently no
production evidence provider feeding this store.

Maximum lifetime is 60 seconds. Claim compares every binding field, verifies
the deadline and uses a single conditional UPDATE to set claimed and persist
the creation request ID. The same grant cannot be claimed again, even for the
same request. A creation request cannot claim another grant. Lost ACK, timeout
or restart cannot unclaim it; recover the creation receipt instead of replaying.
Explicit revocation applies only to unused grants and never reopens them.

Internal `claimedRequest` can recover the original creation request ID using
the ref and every immutable binding field. It is a SELECT only: unused,
revoked, mismatched or unsupported inputs return no receipt. Claimed tombstones
remain readable after the grant deadline and database reopen; neither condition
reopens the grant. The returned ID is not creation or launch success. The caller
must reauthenticate and recheck live permissions before resolving it, then use
the existing authorized receipt read without dispatching again. No recovery
endpoint or trusted binding issuer is enabled by this storage helper.

## Required integration gates, still missing

1. Authenticate an issuer and establish live source-node/session authorization.
2. Establish a daemon-authenticated Server generation and canonical directory
   proof. Do not treat a URL, registry file, directory header or catalog row as
   proof of ownership. Bind the exact source session to that evidence.
3. Recheck current creating-user/source permissions and fresh daemon evidence
   before claiming. Claim and persistent creation-intent admission must be
   composed without losing the relationship across crashes.
4. Validate again before any directory/profile write, and immediately before
   launch; reject changed/unavailable evidence without independent-Server or
   new-session fallback. Handle TOCTOU, not only a past idle/status snapshot.
5. Reconcile existing same-directory node ownership without bypassing current
   workdir protections. Then wire daemon config/resume and client dual entries.

The additive table is created with the other Hub schema. Storage APIs require
SQLite, affirmative `atomicTransactions === true`, and no transactional-feature
refusal; a missing flag is not support. PostgreSQL migration is not acceptance-tested.
No sessions, prompts, passwords, token values or Server URLs are stored, but
canonical paths and identity IDs are sensitive operational metadata.

A same-connection SQLite composition fixture verifies that an outer synchronous
transaction rolls back a grant claim when intent insertion fails, and commits
both when insertion succeeds. Its intent table is a test fixture, not the real
create-node adapter. Callers must not dispatch, mint credentials, write profiles
or perform network I/O inside that transaction. After commit, a lost response
requires receipt recovery, not grant replay. This does not complete gates 1–5
above or establish live source authorization.

## Recovery and rollout

No new daemon, port, proxy rule, env variable or secret source is introduced.
The Hub's existing launch/deployment process continues unchanged. Updating the
binary only adds the table; it does not enable the absent source endpoints.
Rollback may leave the table intact. Do not remove claimed grant tombstones or
restore stale state and replay creation: preserve this table with creation
records in the authorized database backup. Stale/missing backups require
reconciliation, not assumed-safe retries. No backup-restore/crash drill or
production migration was performed by the local SQLite fixtures.

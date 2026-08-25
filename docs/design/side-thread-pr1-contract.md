# SideThread PR1 internal contract

Status: Draft, disabled and not wired to Hub/App.

This document describes the credential-free implementation layer stacked on
RFC-036 PR0. The allowlist consumes only reviewed `test1190-wire-v2`
owned-stdio evidence and remains disabled from production entry points.
The reviewed artifact and crash-safe executor claim are Linux-only. Other
platforms fail the adapter capability gate until an equivalent kernel-backed,
crash-releasing claim receives native evidence; there is no lock-file timeout
or stale-lock deletion fallback.

## Boundary-specific capability

Codex 0.148.0 does not have one Boolean "exact fork" capability:

- `lastTurnId` (`kind: through`) is present in the normal and experimental
  schema and does not require `experimentalApi`.
- `beforeTurnId` (`kind: before`) is experimental and is rejected unless the
  client negotiated `initialize.capabilities.experimentalApi=true`.

After all gates pass, the adapter reports:

```ts
exactBoundary: { through: true, before: experimentalApi }
```

The domain asks for the selected boundary, and fails before `thread/fork` if
that specific boundary is unavailable. Runtime version must be exactly
`0.148.0`, topology must be `owned-stdio`, and evidence revision must be the
reviewed `test1190-wire-v2`. Shared
app-server, owned WebSocket, every other version and stale evidence are typed
unsupported.

This is an adapter allowlist, not a repository-wide Codex dependency upgrade.
`agent-node/package-lock.json` still resolves Codex SDK/CLI 0.133.0, while the
external co-presence binary is operator-managed. PR1 is deliberately not
reachable from production startup.

## Internal API

`SideThreadService` owns:

- `create(requestKey,nodeId,sourceThreadId,boundary)`;
- `startAttempt(sideThreadId,requestKey,prompt)`;
- exact `cancel(sideThreadId)`;
- `archive` and `purge`;
- immutable `get` snapshots and minimized audit entries.

Create and attempt request keys are single-flight and payload-bound. Reusing a
key with different input is a conflict, not a silent replay. A failed operation
may be retried with the same key; a completed operation remains idempotent.
Ambiguous create/start retries retain the original side-thread and attempt
identities, so the stable operation ID addresses the same durable journal row.

Every mutating Codex RPC is journaled to a private `0700` directory with `0600`
atomic records. The stable operation ID is derived from side-thread, method and
idempotency key; target and payload fingerprints are SHA-256 values. The
adapter persists `sent` before writing an RPC. `accepted` and `ambiguous`
operations are never emitted again on replay.
Every mutating operation additionally holds a non-blocking kernel `flock`
executor claim across its send/settle critical section; fork also holds the
claim across snapshotting and its persistent per-source lease. The operation
snapshot is the primary authority; a legacy lease-first torn write is recovered
from the durable lease before any RPC, and a conflicting pair fails closed.

The execution registry accepts a terminal event only if
`sideThreadId + attemptId + derivedThreadId + turnId` matches the active
attempt. Duplicates, stale attempts, source-thread events and sibling-thread
events are dropped and audited. Closing the service unsubscribes its listener
and adapter, drains tracked operations, and prohibits post-close mutation.
Every mutation rechecks the record's immutable runtime/version/topology/evidence
attestation. Per-side serialization prevents archive/purge regression and
duplicate cancel/delete RPCs.

## Codex ownership rules

- A successful native fork registers a unique derived-thread-to-side owner;
  duplicate runtime identities fail closed.
- Fork holds a crash-persistent per-source lease. There is no timeout-based
  lease stealing for an uncertain operation.
- Before `thread/fork`, the adapter persists a complete paginated `thread/list`
  snapshot. If the fork response is lost, only one new thread whose
  `forkedFromId` is the exact source may be adopted. Zero or multiple candidates
  stay ambiguous and retain the lease; retry never emits another fork RPC.
- Start uses `clientUserMessageId=anet-side:<side>:<attempt>`.
- The echoed user item binds the authoritative turn; the `turn/start` response
  turn ID is recorded but not trusted.
- A bounded pre-echo terminal buffer handles terminal-before-identity without
  allowing the domain's `starting` state to accept an arbitrary turn ID.
- A lost RPC response after the identity echo does not start a duplicate turn.
- Restart reconciliation rebuilds the exact client-id/thread/turn execution
  owner, so late terminal notifications and exact cancellation remain bound.
- Interrupt requires an active registry entry for the exact derived thread and
  turn. Source, sibling and unknown identities are rejected locally.
- Archive/delete require an adapter-owned derived thread. Delete additionally
  refuses an active owned turn.
- Fork sends no approval, sandbox, cwd, instruction, model, or workspace-root
  override. Native inheritance is used; BTW cannot upgrade source permissions.
- Capability-flip fork compensation is a journaled `delete` operation; response
  loss is ambiguous and replay never emits a second delete.

## Audit boundary

Audit entries contain action, hashed ownership IDs, runtime/version,
topology/evidence revision, terminal status/rejection reason and timestamp.
They never contain prompt/result bodies,
credentials, environment, paths, request payloads or model output. The current
callback is a non-throwing internal sink boundary: synchronous throws and
rejected promises cannot orphan or duplicate runtime work. Hub authorization
and transactional resource persistence remain future work.

## Deliberate omissions

- no App command/parser/UI;
- no Hub REST/SSE route, database or authorization surface;
- no node startup integration or production feature flag;
- no durable SideThread resource/attempt registry (the runtime operation
  journal and fork lease do not reconstruct the whole domain registry);
- no shared WebSocket/TUI topology;
- no snapshot fallback or non-Codex adapter;
- no attachment cache or bring-back path.

Resource durability is still a blocker for exposing the API externally: the
operation journal prevents duplicate runtime RPCs, but the in-memory registry
cannot reconstruct complete SideThread/attempt state after process death. PR2
must persist that registry before any Hub or App caller can create SideThreads.

## Independent review checklist

- Verify PR0 blockers are not papered over by the adapter allowlist.
- Mutate each version/topology/boundary gate and observe a failing test.
- Race duplicate request keys with equal and unequal payloads.
- Deliver terminal events before start returns, after retry, twice, and with
  source/sibling/unknown IDs.
- Lose the `turn/start` response after identity echo and prove one RPC only.
- Race cancel and terminal; confirm no source/sibling interrupt request exists.
- Inspect fork payload for any permission/config override.
- Close service/adapter during starting and running states; check listeners and
  timers return to baseline without unhandled rejection.
- Treat audit output as hostile: inject newlines, URLs, bearer-shaped values
  and prompt secrets, then confirm none leave allowed fields.
- Do not approve Hub/App wiring without a durable ownership/recovery design.

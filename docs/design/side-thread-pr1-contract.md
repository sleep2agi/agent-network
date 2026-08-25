# SideThread PR1 internal contract

Status: Draft, disabled and not wired to Hub/App.

This document describes the credential-free implementation layer stacked on
RFC-036 PR0. It does not claim that PR0's semantic wire review is complete;
the runtime allowlist remains unusable in production until PR0's raw trace,
boundary-content and concurrency blockers are resolved.

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
reviewed `test1190-wire-v2`. PR0 currently has blockers and has not produced
that revision, so present production inputs remain unsupported. Shared
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

The execution registry accepts a terminal event only if
`sideThreadId + attemptId + derivedThreadId + turnId` matches the active
attempt. Duplicates, stale attempts, source-thread events and sibling-thread
events are dropped and audited. Closing the service unsubscribes its listener
and prohibits further mutation.

## Codex ownership rules

- A successful native fork registers its derived thread as adapter-owned.
- Start uses `clientUserMessageId=anet-side:<side>:<attempt>`.
- The echoed user item binds the authoritative turn; the `turn/start` response
  turn ID is recorded but not trusted.
- A lost RPC response after the identity echo does not start a duplicate turn.
- Interrupt requires an active registry entry for the exact derived thread and
  turn. Source, sibling and unknown identities are rejected locally.
- Archive/delete require an adapter-owned derived thread. Delete additionally
  refuses an active owned turn.
- Fork sends no approval, sandbox, cwd, instruction, model, or workspace-root
  override. Native inheritance is used; BTW cannot upgrade source permissions.

## Audit boundary

Audit entries contain action, logical ownership IDs, runtime/version,
topology/evidence revision, terminal status/rejection reason and timestamp.
They never contain prompt/result bodies,
credentials, environment, paths, request payloads or model output. The current
callback is an internal sink interface; durable storage and authorization are
future Hub work.

## Deliberate omissions

- no App command/parser/UI;
- no Hub REST/SSE route, database or authorization surface;
- no node startup integration or production feature flag;
- no durable restart/recovery ledger;
- no shared WebSocket/TUI topology;
- no snapshot fallback or non-Codex adapter;
- no attachment cache or bring-back path.

Durability is a blocker for exposing the API externally: an in-memory registry
cannot safely recover ownership after process death. PR2 must persist the
resource/attempt ledger before any Hub or App caller can create SideThreads.

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

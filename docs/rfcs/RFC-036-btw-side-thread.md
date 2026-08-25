# RFC-036: `/btw` Codex side thread (PR0 capability contract)

| Field | Value |
|---|---|
| Status | **Draft — probe evidence only; no product/API implementation authorized** |
| Tracking | `sleep2agi/agent-network-app#175` |
| Protocol baseline | `codex-cli 0.148.0`, exact npm pin |
| Evidence | `tests/test1190-codex-btw-wire-probe`, `docs/tests/report-test1190-codex-btw-wire-probe.md` |

## 1. Decision

`/btw` is a separate side-chat resource. It is not a task priority, a steer,
or a second request on the node's persistent main thread. PR0 does not add a
slash command, REST endpoint, queue row, or UI. It freezes and probes the
Codex app-server wire contract that a later implementation may use.

The first supported adapter may be `codex-app-server` only. Every other
runtime, and every Codex version/capability combination not proven by the
probe, is `unsupported`. A caller must receive that result before a Hub inbox
row is created. Falling back to ordinary `send_task`, high priority, or
`turn/steer` is forbidden.

## 2. Proven 0.148.0 wire behavior

The Docker live probe uses the real vendor binary and an isolated authenticated
`CODEX_HOME`; it does not mock JSON-RPC.

| Question | Observed result |
|---|---|
| Exact fork through a completed turn while a later source turn runs | `thread/fork {threadId,lastTurnId}` succeeds |
| Fork immediately before the active turn | `thread/fork {threadId,beforeTurnId}` succeeds |
| Use the active turn as inclusive boundary | rejected with JSON-RPC `-32600` |
| Source + two forked threads active together | supported by the app-server |
| Interrupt one fork with exact `(threadId,turnId)` | target becomes `interrupted`; sibling and source complete |
| Archive | succeeds; archived thread remains readable |
| Delete | succeeds; subsequent `thread/read` is rejected (`-32600`) |

`beforeTurnId` and the tested exact-boundary surface require the client to
declare `initialize.capabilities.experimentalApi=true`. Without that opt-in,
the server rejects the request even though the generated experimental schema
contains the field. Therefore a version comparison or schema grep alone is
not a capability check.

These findings apply only to the exact Linux npm artifact pinned in the suite.
They do not prove behavior for 0.147, future versions, shared app-server
topology, Codex SDK, or another runtime.

## 3. Minimum future resource model

```ts
type SideChat = {
  id: string;
  nodeId: string;
  sourceThreadId: string;
  boundary: { kind: "through" | "before"; turnId: string };
  derivedThreadId: string;
  runtime: "codex-app-server";
  runtimeVersion: "0.148.0";
  capabilityMode: "native-fork";
  state: "creating" | "running" | "completed" | "failed" |
         "cancelled" | "archived" | "purged";
  activeAttempt?: { attemptId: string; turnId: string };
};
```

Hub/agent-node owns this state and the runtime connection. App clients render
it. Event ownership requires the complete tuple
`(sideChatId, attemptId, derivedThreadId, turnId)`. A missing or mismatched
member is dropped and audited; it must never fall back to "current thread",
"current turn", selected chat, or most recent request.

The fork boundary must be selected from an authoritative `thread/read`, never
from an App-side conversation cache. While a source turn is active, the safe
default is the last terminal turn (`lastTurnId`) or equivalently the active
turn's `beforeTurnId`. If the server cannot prove either identifier, creation
fails closed.

## 4. Cancellation and retention invariants

- Cancellation is exactly `turn/interrupt {derivedThreadId, derivedTurnId}`.
  No shared `AbortController`, bridge-global active turn, or source turn ID may
  be used.
- Retry creates a new `attemptId` and turn ID. Terminal notifications for an
  older attempt cannot settle the newer attempt.
- `archive` is reversible/retained state, not deletion. UI must say archived.
- `delete` is allowed only after terminal state and an ownership check proving
  the thread was created for this SideChat.
- Purge may remove only SideChat-owned caches and attachment references. A
  shared source file or content-addressed upload requires reference counting;
  path-prefix deletion is forbidden.
- Closing a panel is not cancellation. Process/socket/listener/timer cleanup
  is separate from persisted thread retention.

## 5. Capability negotiation

The future adapter must run a startup capability gate containing all of:

1. exact runtime name and version allowlist;
2. successful initialization with `experimentalApi` explicitly negotiated;
3. method/field schema match against the reviewed golden;
4. topology match (`owned` versus `shared` is a separate evidence cell);
5. a runtime health probe that does not mutate the main thread.

Any unknown value returns structured `unsupported`; it does not enqueue.
Removing the experimental requirement or widening the version range needs a
new live capture and independent review.

## 6. PR sequence after PR0

- PR1: internal SideChat protocol/state machine and fail-closed capability API;
  no App command.
- PR2: Codex adapter with durable ownership ledger, recovery, cancellation,
  archive and purge guards.
- PR3: Hub endpoints/events, authorization and audit redaction.
- PR4: shared App state/reducer and desktop/mobile presentation.
- PR5: explicit bring-back with idempotency and provenance.

Each stage stays disabled until the preceding Docker layer passes.

## 7. Acceptance red lines

- Source turn receives no steer, interrupt, pause, or BTW item.
- Source `thread/read` contains no BTW question or answer by default.
- Two BTW attempts may complete out of order without cross-settlement.
- Cancelling one derived turn leaves source and sibling terminal status intact.
- Unsupported runtime/version produces no task, inbox, turn, or local outbox row.
- Bring-back is explicit, idempotent, provenance-labelled, and the only write
  into the main conversation.
- Stress teardown returns listener, timer, socket, child and active-turn counts
  to baseline.
- Desktop and mobile use one lifecycle reducer; platform shells cannot define
  their own state transitions.

## 8. Mandatory third-party review checklist

The reviewer must inspect raw/sanitized wire evidence and attempt fault
injection, not only the happy-path assertions.

- [ ] Verify npm version is exact and golden changes cannot pass under `latest`.
- [ ] Verify `experimentalApi` is negotiated and missing capability fails closed.
- [ ] Verify boundary IDs come from authoritative source thread state.
- [ ] Race source completion against both fork variants; reject ambiguous point.
- [ ] Race cancel against completion and retry; old terminal cannot settle new attempt.
- [ ] Confirm all notifications are filtered by side/attempt/thread/turn tuple.
- [ ] Kill transport during fork/start/interrupt and inspect recovery ownership.
- [ ] Test owned and shared app-server separately; do not infer parity.
- [ ] Confirm approvals, sandbox, cwd, instructions and workspace roots inherited
      or overridden exactly as documented, without privilege escalation.
- [ ] Confirm audit excludes auth tokens, prompt bodies, environment secrets and
      private filesystem paths.
- [ ] Confirm archive and delete labels match real semantics.
- [ ] Prove purge ownership and attachment reference counting with shared files.
- [ ] Measure listener/timer/socket/process/thread counts after repeated failures.
- [ ] Confirm unsupported runtimes never enter normal priority/FIFO/steer paths.
- [ ] Confirm desktop and mobile exercise the same reducer contract.

## 9. Non-goals of this draft

No fallback snapshot design is approved. A new-thread snapshot can leak system
instructions, secrets, tool output, absolute paths and attachments, and cannot
claim native-fork equivalence without a separate whitelist and probe suite.
No UI design, automatic write-back, cross-runtime parity, merge or release is
part of PR0.

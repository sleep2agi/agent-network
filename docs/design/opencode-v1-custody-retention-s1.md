# Versioned custody state, identity schema, permission contract and cleanup contract for V1 retention (S1 design, #1334)

Status: **design draft only** (revision 10; the direction of `3886e156` — root-external
basis/fence, immutable revision files, full-record-digest CAS and the single
`cohort-admission-barrier` — is accepted and not reverted). It defines the persistent
structures, the identity schema, the state machine, the cleanup decision, the commit
authority and the permission contract for a future V1 exact-instance retention/custody
protocol. It is **not** a runtime implementation and changes no runtime file.

Lineage: S1 belongs with **#1269 / #1271 / #1272 under #1238** — they are the same lineage;
this card is **not** hung under #1269, and #1269's three items stay unfinished.

## 1. Verified source baseline (current `main`)

Re-read from `main` at `6ed5b6859fad31ab65449c79d98bfb22f119169c` on 2026-10-16:

- `v1-safe-retention-request.ts` — one observation with a digest; refuses; byte-identical
  JSON reconstruction is not a durable recovery/custody entry.
- `v1-owned-safe-topology.ts` / `v1-borrowed-tui.ts` — read-only observation of the
  current-process allocation, and a cooperative read-only admission to an already-live
  node's lease; never final history or a custody lease.
- `v1-migration-plan.ts` — refuses; has an explicit no-intent-or-lease refusal path.
- `close-cleanup.ts` + `runtime.ts` — `cleanupAfterExit` retries a caller-supplied
  identity/live-process predicate (the caller retains the root on timeout/unknown); the
  close path and the error path share one cleanup closure. No open custody/retention pull
  request exists on `main`.

Registration, idle, a clean-shutdown flag or a process-reference scan are **never**
accepted as custody, writer exclusion, final history or a qualified release.

## 2. Identity schema and persistent structures

### 2.1 Identity schema (restored from the accepted revision)

A record binds **named participants** to **precise running instances**. Nothing weaker may
be written into it.

| Group | Fields | Why required |
|---|---|---|
| Schema | `schemaVersion` (int, from 1), `recordId`, `createdAt` | A higher version is refused, never guessed |
| Source coordinator | `coordinatorNodeId`, `coordinatorAlias`, `coordinatorNetworkId` | A named participant, not "some node" |
| **Coordinator generation** | `coordinator: GenRef` (`pid`, `startTicks`, `uid`, `exeDigest`) | Binds *who may durably write*; a bare pid is reusable |
| **Native generation** | `native: { pid, startTicks, uid, exeDigest, runtimeVersion }` | The server/TUI child is a **different** generation from the coordinator; keeping them apart is what makes "the coordinator exited" ≠ "a stale process may write an outcome" |
| Capability | `sourceGeneration` (`v1`), `capability[]` | A declared config version is not capability proof |
| Requested coordinate | `requested.directory`, `requested.rootId` = `{dev, ino}`, `requested.configDigest` | `{dev, ino}` is the filesystem identity; a bare ino is ambiguous across filesystems |
| Native coordinate | `nativeCoord.directory`, `nativeCoord.dataId`, `nativeCoord.workspaceId`, `nativeCoord.launchId` (each `{dev, ino}`), `nativeCoord.checkpointDigest` | Exact identity of the native tree |
| Request / target | `requestId`, `target?{nodeId, alias, confirmedBy}` | Handoff must be named, never implied |
| Commit inputs | `revision` (monotonic), `prevRecordDigest`, `writerId` | Comparison inputs for §4 — **not** a lock by themselves |
| State | `state` (§6), `evidenceRefs` (`nativeExit`, `barrier`, `credential`, `release`) | A state without its typed evidence is not a state |

Explicitly **not** stored: credentials, tokens, passwords, provider keys, model session
content, message bodies. Digests and `{dev, ino}` only. **Credential boundary (unchanged):
credential cleanup must never be disabled in order to retain the DB, retention must never
hand real auth to a target, and an empty `auth.json` is not evidence that a root holds no
secrets**; credential cleanup stays on its own path (§11).

### 2.2 Persistent structures (all outside the root being cleaned)

| Path | Kind | Rule |
|---|---|---|
| `lock` | stable inode, **created once, never replaced** | Every phase serializes on this inode |
| `participation/<allocationId>.json` | participation basis, immutable | Written by the allocation flow **before** any retention preparation. `nonParticipation: true` for **this exact allocation/root generation** is the **only** thing that licenses ordinary cleanup |
| `fence/<allocationId>.json` | retention fence | Prepare's first durable step. Presence ⇒ retain/refuse, regardless of any record |
| `reservation/<allocationId>.json` | **irrevocable** cleanup reservation | Written before any deletion; then prepare **must fail** |
| `records/<revision>-<digest>.json` | **immutable** record; old versions kept | `prevRecordDigest` must resolve to a **readable, still-present** file |
| `confirmation/<revision>-<digest>.json` | commit confirmation | `{recordRef:{revision,digest}, chainHead, at}` |
| `receipts/<revision>-<digest>.json` | commit receipt | Published by the commit protocol (§4); bound to the record + confirmation |
| `current` | pointer file | Names `{revision, digest}` of the current record |

Every path above lives in the **owner uid's private state** and is **owner-uid private**: a
cross-uid read or write is a **refusal**, never a merge. `allocationId` is bound inside the
artifacts (`Record`, `CommitReceipt`, `Fence`, basis), never inferred from a directory name.

## 3. The cleanup decision — one mutually exclusive order

`cleanupDecision(allocationId, rootId, participant)` is asked **while holding `lock`** and
evaluates the following **in order**; the first matching row wins:

| # | Condition (under `lock`) | Decision |
|---|---|---|
| 1 | consistency/qualification unknown (unreadable, `schema-newer`, `chain-broken`, `mixed`, `fs-identity-drift`) | `retain` + refuse |
| 2 | **this actor already holds a valid cleanup reservation** for this allocation | Continue **only** that authorized action; refuse any new prepare (`cleanup-reserved`) |
| 3 | a **current, complete, confirmed `released` record**, #1239 gate satisfied, **exact root/fence/allocation match** | Establish the retained-root **cleanup reservation** (`authorizedAction: released-cleanup`) — the release cleanup proceeds |
| 4 | any other state: a fence, an intent without a qualified release, or active custody (`prepared`/`retain-pending`/`retained-ready`/`handed-off`) | `retain` + refuse |
| 5 | affirmative **non-participation proof** (`nonParticipation: true` for this exact allocation/root generation) **and no participation history** | `ordinary-cleanup` reservation |
| 6 | otherwise | `refuse(...)` |

Rules that replace the conflicting sentences of revisions 1–4:

1. **A durable fence/intent without a qualified release always means retain/refuse.**
   Missing acknowledgement never reverts to ordinary — *no confirmation is not proof that
   the allocation never entered the retention flow*. **Once a fence is written it is never
   removed, downgraded or ignored**: no evidence state — and in particular no missing
   confirmation — can remove it, and no function, operator or admin action in S1 removes a
   fence. A fence stops requiring retain/refuse **only** after a **qualified `released`**
   record exists (§3 row 3, §6). **Invariant (a validity determination, not a rewrite): a
   fence existing *implies* `nonParticipation: false` for that allocation — the immutable
   basis is read, never rewritten.**
2. **`absent` grants nothing.** No basis entry ⇒ `refuse(no-participation-proof)`.
   Allocations created before the participation basis exists therefore refuse.
3. **Cleanup never reads, releases the lock, then deletes.** It either holds `lock` until
   the delete completes, or first persists the **irrevocable reservation**. After a
   reservation exists, prepare must fail (`cleanup-reserved`).
4. **`released` is terminal.** The same allocation can **never** be prepared again; the
   record, history and terminal state stay on disk. Cleanup removes the *root*, never the
   fence/history (deleting history to make ordinary hold is forbidden).

## 4. Commit protocol, receipt, chain, confirmation and crash points

- **Serialization**: every phase holds `lock`. **CAS compares the current complete record
  digest** (the `digest` of `current`'s target file), not just the revision number.
- **CAS initial values**: `revision=0` means the *absence* of a record (`current` missing),
  and it applies **only to an initial allocation proven to have no committed history**. A
  lost `current`, or any evidence of prior history, must **not** restart at `revision=1` —
  that is `unknown` ⇒ retain + refuse. `prepare-requested` is **not** a committed Record
  state (§5, §6): it is the **fence**-represented preparation stage, so it occupies no
  revision; the first Record is `prepared` with `revision=1`, `prevRecordDigest=null`.
- **Publish protocol** — each step includes the durability of the *new directory entry*:
  1. record temp → `fsync` file → `rename` → `records/<revision>-<digest>.json` → **`fsync`
     `records/`**;
  2. confirmation temp → `fsync` → `rename` → `confirmation/…` → **`fsync` that dir**;
  3. `current` temp → `fsync` → `rename` over `current` → **`fsync` its dir**;
  4. **receipt** temp → `fsync` → `rename` → `receipts/<revision>-<digest>.json` →
     **`fsync` that dir**;
  5. **ACK** the caller only after step 4's directory fsync.
  The receipt is a **persistent artifact** (not a pure return value): it is what a later
  reader verifies against record + confirmation.
- **Chain**: `prevRecordDigest` points at a **readable, still-present** immutable record
  file; `chainHead` in the confirmation is the digest of the oldest retained revision. A
  chain whose older file is missing ⇒ `unknown` ⇒ retain+refuse.
- **No self-reference**: an outcome may **not** carry its own commit evidence. The commit
  function **consumes** the `QualifiedOutcome` and **returns a separate `CommitReceipt`**
  (which it has just published); readers verify the binding
  `record ↔ outcome ↔ confirmation ↔ receipt`.
- **Lock semantics honesty**: a POSIX advisory lock is **released by the kernel when the
  holder dies**; a dead pid does not still hold `lock`. A free `lock` is **not** takeover
  authority — takeover requires the named recovery authority and the evidence below.

**Recovery by physical crash point.** The recovery authority may **only re-persist the
same revision with its originally valid evidence**; it may never manufacture
qualification, never advance the revision, **never derive `ordinary-cleanup` from an
absent confirmation**, and **no row below removes or downgrades a fence**:

| Crash point | On-disk state | Verdict | Allowed recovery |
|---|---|---|---|
| after fence written, before any record temp | fence only | `retain` + `refuse(record-expected-missing)` | authority may re-persist the **same revision** from the original outcome. The fence **stays**: nothing in S1 removes or downgrades it |
| during record temp write | partial temp | retain | ignore the temp (it is not a record); fence stands |
| after record rename, before `records/` fsync | record maybe present, no confirmation | `unknown` ⇒ retain | authority re-publishes the **same revision** through the full protocol |
| after `records/` fsync, before confirmation | record durable, confirmation absent | `unknown` ⇒ retain + `refuse(commit-unconfirmed)` | authority writes the confirmation for the **same revision/digest** |
| after confirmation, before `current` rename | record + confirmation durable, pointer stale | retain | authority redoes **`current`** (temp → fsync → rename → **fsync its dir**) for the **same** `{revision,digest}` |
| after `current` rename, **before `current` dir fsync** | pointer maybe present, its durability unknown | `unknown` ⇒ retain | authority **redoes `current`'s full publish including its directory fsync** for the same `{revision,digest}`, **then** publishes the receipt in full, **then** ACKs. Re-publishing only the receipt is **not** enough — it would ACK a pointer that was never re-persisted |
| after `current` dir fsync, before receipt temp | committed, no receipt | `unknown` ⇒ retain | authority publishes the **same receipt** in full |
| after receipt rename, **before receipt dir fsync** | receipt maybe present | `unknown` ⇒ retain | authority redoes the receipt publish **including its directory fsync** |
| after receipt dir fsync, before ACK | fully committed, caller unaware | committed | the caller **re-reads**: CAS sees the same current digest ⇒ **returns the same receipt**; an observed ACK is never disk-recovery evidence |
| after ACK | committed | committed | none |

### 4.1 Write permissions — one commit entry point, named by the transition

**Every state change goes through the same underlying commit (§4).** The writer is **the
named authorizer of the transition being committed** (§6); this table is that authorizer's
authorization basis, not a per-artifact veto. Recovery **replays the original revision
only** — it never impersonates an actor to make a *new* commit.

| Writable state / artifact | Sole named writer | Range and rule |
|---|---|---|
| `fence/<allocationId>.json` | the **coordinator generation** of this allocation | any other writer ⇒ `refuse(unqualified-participant)`, nothing written |
| `records/…` + `current` | **the named authorizer of the transition** (§6) — the coordinator for `prepared`/`retained-ready`, the **named target** for `handed-off`, the **current holder** for `released` | CAS on the complete current digest under `lock`; a loser re-reads. A legitimate target/holder is **not** blocked by the coordinator row |
| `confirmation/…`, `receipts/…` | the same authorizer, or the named recovery authority | only for the **same** `(revision, digest)` |
| `prepared`/`retained-ready` | the coordinator whose generation matches | nobody else may write these states |
| `retain-pending` (from `prepared`) | the coordinator, or the named recovery authority | never overwrites another record's custody |
| `handed-off` | the **named target**, CAS against the coordinator's revision | the source record is kept; a losing target re-reads |
| `released` | the current **holder** (coordinator or target), with `ReleaseEvidence` + #1239 | never producible by a reader; **terminal** |
| repair / replay of a torn publication (**same revision**) | the named recovery authority | may replay anything that was **already validly authorized — including `released`**; what is forbidden is **fabricating or advancing** a release |
| `reservation/<allocationId>.json` | the cleanup actor that passed §3 | irrevocable; after it exists, prepare fails |
| **a refusal** | **nobody** | A refusal is a **decision returned to the caller**, never a record; a reader may never overwrite a valid record with a refusal |

## 5. Types

```ts
type GenRef = { pid: number; startTicks: string; uid: number; exeDigest: string };
type FsId   = { dev: string; ino: string };                 // exact filesystem identity
type ParticipantIdentity = { kind: "node" | "user" | "recovery-authority"; id: string };

type CustodyState = "prepared" | "retain-pending" | "retained-ready"
                  | "handed-off" | "released";
// Committed Record states only. `observed` is the pre-record read-only observation and
// `prepare-requested` is the **fence**-represented preparation stage — a Record never
// carries either, and neither consumes a revision (§4, §6).

// The native child having exited is ONE fact; it is never an exclusion proof.
type NativeExit = { pid: number; startTicks: string; observedAt: string; ref: string };

// The ONLY accepted write-exclusion contract: a named controller refuses NEW
// launch/adoption for this cohort, bound to allocation/root identity and an epoch.
// (Metadata locks and "no writer was visible" were removed — they cannot stop a
// native process from writing the database.)
type CohortAdmissionBarrier = {
  kind: "cohort-admission-barrier";
  controller: GenRef; allocationId: string; rootId: FsId; epoch: number;
  coveredParticipants: string[]; ref: string;
};
type CredentialDisposition = { mode: "unchanged" | "cleaned"; ref: string };
type ReleaseEvidence = { ref: string; gate1239: string; devIno: FsId; at: string };

type QualifiedOutcome = {                       // NO `commit` field — see §4
  kind: "qualified"; coordinator: GenRef;
  nativeExit: NativeExit;                       // existing writers: independent exit evidence
  barrier: CohortAdmissionBarrier;              // new writers: the admission barrier
  credentialDisposition: CredentialDisposition;
  target?: { nodeId: string; alias: string; confirmedBy: string };
};
type CommitReceipt = { allocationId: string; recordRef: { revision: number; digest: string };
                       confirmationRef: string; chainHead: string };

type Record = {                                 // §2.1, verbatim fields
  schemaVersion: number; recordId: string; allocationId: string; createdAt: string;
  coordinatorNodeId: string; coordinatorAlias: string; coordinatorNetworkId: string;
  coordinator: GenRef; native: { pid: number; startTicks: string; uid: number;
    exeDigest: string; runtimeVersion: string };
  sourceGeneration: "v1"; capability: string[];
  requested: { directory: string; rootId: FsId; configDigest: string };
  nativeCoord: { directory: string; dataId: FsId; workspaceId: FsId; launchId: FsId;
    checkpointDigest: string };
  requestId: string; target?: { nodeId: string; alias: string; confirmedBy: string };
  state: CustodyState;
  revision: number; prevRecordDigest: string | null; writerId: string;
  evidenceRefs: { nativeExit?: string; barrier?: string; credential?: string; release?: string };
};

type ParticipationBasis = { allocationId: string; rootId: FsId; generation: string;
                            nonParticipation: boolean; at: string };
type Fence = { allocationId: string; rootId: FsId; generation: string; at: string };
type CleanupReservation = { allocationId: string; rootId: FsId; actor: ParticipantIdentity;
  authorizedAction: "ordinary-cleanup" | "released-cleanup"; at: string };
```

Requirements that make the barrier usable:

- **Existing writers** need their own `nativeExit` (or independent exclusion) evidence;
  the barrier only stops **new** launch/adoption.
- **Fail-closed admission**: while a barrier is claimed, participating launchers default
  to refusing new writers; if the controller crashed or versions mismatch, admission
  still refuses — a barrier does not expire.
- **No time-based exclusion**: `heldUntil: null`, a timestamp or a window is not proof. A
  barrier is lifted **only by a named handoff or release** event.
- **Audit is evidence, not the barrier** (§7): it proves *which* participants are covered.

## 6. State machine and preconditions

`observed` → `prepare-requested` → `prepared` → (`retain-pending` | `retained-ready`) →
`handed-off` → `released`; plus the terminal decision `refused` (returned, not written).
The first two steps are **pre-record staging**: `observed` is read-only observation, and
`prepare-requested` is represented by the durable **fence** — the **first Record is
`prepared` at `revision=1`**.

| From → To | Executor | Precondition (exact evidence consumed) | Idempotency / concurrency | Crash |
|---|---|---|---|---|
| `observed` → `prepare-requested` (**staging**, no Record) | coordinator | identity group of §2.1 complete; **both coordinates present** with their `{dev, ino}` (absent inodes do not qualify); §7 audit passed | replay yields the same digest; concurrent prepares conflict on the lock | the only durable effect is the **fence**; no Record is written and **no revision is consumed** |
| `prepare-requested` → `prepared` | coordinator | durable commit per §4 with `revision=1`, `prevRecordDigest=null` | second writer loses the compare; identical replay is a no-op | torn write ⇒ `unknown` ⇒ retain + refuse |
| `prepared` → `retained-ready` | coordinator (generation must still match) | a `QualifiedOutcome` whose `coordinator` == the record's generation, with `nativeExit` **and** a separate `CohortAdmissionBarrier` held through the retention window (a native exit alone is **not** exclusion), plus `credentialDisposition`; any re-read of `{dev, ino}` that differs ⇒ refuse | duplicate outcomes collapse to one revision | re-read failure ⇒ `refused` |
| `prepared` → `retain-pending` | coordinator, or the named recovery authority | native child no longer matches its generation **and** no qualified outcome exists | idempotent (pessimistic) | this *is* the crash path |
| `retained-ready` → `handed-off` | named target | **#1238's intent journal and all-launcher refusal gate satisfied** (precondition); target identity read independently; CAS on `revision+1` | exactly one CAS wins; losers re-read | crash mid-handoff ⇒ both stores retained |
| `handed-off`/`retained-ready` → `released` | current holder | **#1239's final-history / lossless-restore gate satisfied** (precondition); `ReleaseEvidence`; `{dev, ino}` unchanged since the revision read | idempotent per `(recordId, revision)` | crash before durable release ⇒ still retained |
| `released` → cleanup reservation (§3 row 3) | any participant | complete + confirmed `released`; #1239 satisfied; **exact** root/fence/allocation match | exactly one reservation; **terminal** — no re-prepare for this allocation | crash before deletion ⇒ reservation stands; prepare still fails |
| any → `refused` (decision) | any participant | missing/contradictory/mixed/newer evidence | idempotent; **never writes a record** | never auto-clears; never replays |

## 7. Prepare eligibility requires an auditable participant set

A state flag does not stop old code: an old/external sweeper that ignores these artifacts
will delete the native directory anyway. Protection must be established **before**
promising `prepared`: for every relevant cleanup participant and every launcher/adopter
that could write, the profile must show **protocol-awareness** (a version that reads the
fence / asks `cleanupDecision` / honours the barrier), **provable exclusion** (its
configured roots cannot reach the native directory), or **coordinated out** (stopped with
evidence). Any unknown participant ⇒ **refuse at prepare** (`participant-unknown`); if a
fence already exists, `retain` + `refuse(unknown-sweeper)`.

**Supported profile: exact-owned only.** A `borrowed`, `unsafe`, old/unmatched-source or
mixed-unknown profile **refuses** (`unqualified-participant` / `unknown-sweeper`); S1 never
assumes an unknown external sweeper is safe.

## 8. API draft

```ts
// All of these run while holding `lock` (§2.2). None may be a permanent throw.
function readStructures(allocationId: string):
  | { kind: "absent" }                 // ⇒ refuse(no-participation-proof); NOT ordinary
  | { kind: "readable"; basis?: ParticipationBasis; fence?: Fence; record?: Record;
      confirmation?: Confirmation; receipt?: CommitReceipt; reservation?: CleanupReservation }
  | { kind: "unknown"; reason: "unreadable" | "schema-newer" | "chain-broken" | "mixed" };

function cleanupDecision(opts: { allocationId: string; rootId: FsId;
  participant: ParticipantIdentity }):
  "ordinary-cleanup" | "retain" | "released-cleanup" | { refuse: RefusalReason };   // §3 order

function reserveCleanup(opts: { allocationId: string; rootId: FsId;
  actor: ParticipantIdentity; authorizedAction: "ordinary-cleanup" | "released-cleanup" }):
  Promise<{ reservationRef: string }>;                   // irrevocable; then prepare fails

// Prepare: first durable step is the fence (temp→fsync→rename→fsync dir); then the commit.
// Precondition: the root **directory must exist** and re-read to the same `{dev, ino}`
// (a bare inode is ambiguous across filesystems): absent ⇒ `refuse(root-absent)`,
// drifted ⇒ `refuse(fs-identity-drift)`. Never prepare blind.
function requestRetentionPrepare(opts: { allocationId: string; rootId: FsId;
  actor: ParticipantIdentity }): Promise<{ revision: number; digest: string }
  | { refuse: RefusalReason }>;

function commitOutcome(opts: { allocationId: string; expectedRevision: number;
  expectedRecordDigest: string; actor: ParticipantIdentity; outcome: QualifiedOutcome;
}): Promise<CommitReceipt>;              // consumes the outcome; publishes record+confirmation+receipt

function handOffCustody(opts: { allocationId: string; expectedRevision: number;
  expectedRecordDigest: string; actor: ParticipantIdentity; target: CustodyTarget;
}): Promise<CommitReceipt>;              // precondition: #1238 gate satisfied

function releaseCustody(opts: { allocationId: string; expectedRevision: number;
  expectedRecordDigest: string; actor: ParticipantIdentity; evidence: ReleaseEvidence;
}): Promise<CommitReceipt>;              // precondition: #1239 gate satisfied; terminal
```

Wiring: close and the error path (one shared cleanup closure) call `cleanupDecision` under
`lock` **before** their existing predicate. `retain`, `refuse` and `absent` all mean keep;
only `ordinary-cleanup` (affirmative attestation) or `released-cleanup` (valid terminal
`released` + reservation) permits the existing flow.

## 9. Refusal reason codes

`no-participation-proof`, `cleanup-reserved`, `record-expected-missing`,
`commit-unconfirmed`, `chain-broken`, `schema-newer`, `generation-mismatch`,
`fs-identity-drift`, `root-absent`, `barrier-epoch-mismatch`, `participant-unknown`,
`unknown-sweeper`, `mixed-state`, `unqualified-participant`, `release-incomplete`.

## 10. Responsibility boundaries (unchanged scope)

- **#1272** owns the persistent marker/CAS/fsync **implementation** and source-owned
  preparation mechanics; S1 defines the structures (§2), the decision (§3) and the commit
  boundary (§4) they must satisfy.
- **#1238** owns the intent journal and the all-launcher refusal gate: a **precondition of
  `handOffCustody`**. **#1239** owns the final-history / lossless-restore gate: a
  **precondition of `releaseCustody`**. **#1269** keeps its three items unfinished.

## 11. Decision tables and worked examples

| Situation | Decision | Must not happen |
|---|---|---|
| Ordinary root with `nonParticipation: true`, no fence/reservation/record | `ordinary-cleanup` | Must not be turned into permanent retention |
| No basis entry (`absent`) | `refuse(no-participation-proof)` | Must not be treated as ordinary |
| Fence or intent, no qualified release | `retain` + refuse | **The fence is never removed**; must not delete the fence/history to make ordinary hold |
| Complete + confirmed `released`, #1239 satisfied, exact match | `released-cleanup` reservation | History and terminal state must survive the cleanup; the allocation must not re-prepare |
| `released` but `{dev, ino}` drifted or match inexact | `retain` + `refuse(release-incomplete)` | Must not clean a root that is not the released one |
| This actor already holds a valid reservation | Continue that action only | New prepares must fail (`cleanup-reserved`) |
| Concurrent commits | one wins: CAS on the complete current digest under `lock` | No last-write-wins; no replaced record file |
| Prepare with an absent directory or drifted `{dev,ino}` | `refuse(root-absent)` / `refuse(fs-identity-drift)` | Never prepare against a bare inode |
| A write by a participant other than the named writer (§4.1) | `refuse(unqualified-participant)` | Permission is checked **before** any write |
| Barrier controller crashed / version mismatch | admission still refuses new writers | No time-based or null-`heldUntil` exclusion |
| Metadata lock free (holder died) | no takeover authority | Must not claim a dead pid still holds the kernel lock |
| Native exit observed, no barrier | stay `prepared` | Exit must never stand in for exclusion |
| Credential cleanup needed while a root is retained | credential cleanup runs on its own path | Must not be disabled by retention |

Worked examples.

- **(+) `released` completes one cleanup, history kept.** Record reaches `released` with
  `ReleaseEvidence` and the #1239 gate; §3 row 3 matches root/fence/allocation exactly ⇒
  exactly one reservation is written and the root is removed. The record chain,
  confirmation, receipt and the `released` terminal state remain; a second cleanup attempt
  finds the reservation and continues only it; a prepare request for this allocation fails.
- **(−) fence-only crash stays retained.** A process dies after writing the fence and
  before any record temp. Nothing on disk shows a release and no confirmation exists. §3
  row 4 ⇒ `retain` + `refuse(record-expected-missing)`. S1 offers **no** path from "the
  confirmation is absent" to `ordinary-cleanup`, and **no path that removes the fence**;
  only a qualified `released` record ends its retain/refuse effect.
- **(+) a legitimate target commits `handed-off`.** The target passes the #1238 gate; §6
  names it the **authorizer of `handed-off`**, so §4.1 admits it as the writer of
  `records/…` + `current` (the coordinator row does not veto another transition). CAS on
  the coordinator's revision; a losing target re-reads; the source record stays.
- **(+) `current` renamed but its directory not yet fsynced.** Crash before the receipt.
  Recovery **redoes `current`'s full publish including its directory fsync** for the same
  `{revision,digest}`, **then** publishes the receipt in full (rename **and** directory
  fsync), **then** ACKs. Re-publishing only the receipt would ACK a version whose pointer
  was never re-persisted, and is not allowed.
- **(−) profile/credential refusal.** A `borrowed`/`unsafe` profile, an old/unmatched
  source, or a mixed-unknown participant set ⇒ **refuse at prepare**. Retention never hands
  real auth to a target, **credential cleanup is never disabled in order to retain the DB**,
  and an empty `auth.json` never proves a root is secret-free ⇒ credential cleanup keeps
  running on its own path.

## 12. Acceptance plan for the next slice (not executed here)

Positive: (1) basis with `nonParticipation: true` ⇒ ordinary cleanup unchanged; (2) fence +
commit ⇒ record + confirmation + receipt + `current` consistent and bound; (3) a named
handoff with the #1238 gate satisfied advances the revision by one while keeping every old
record file; (4) release with the #1239 gate satisfied is the only path to `released`, and
it yields exactly one cleanup.

Negative (each witnessed red): (1) concurrent commits ⇒ one CAS wins; (2) cleanup vs
in-flight prepare ⇒ prepare fails after a reservation; (3) fence with a lost record ⇒
retain + refuse; (4) each physical crash point of §4 produces its listed verdict; (5)
record without confirmation ⇒ `unknown`; (6) committed without receipt ⇒ `unknown`, then
the same receipt may be re-published; (7) lost ACK ⇒ same receipt, no new revision; (8)
chain gap ⇒ `unknown`; (9) `absent` ⇒ refuse (not ordinary); (10) fence-only crash ⇒
retain (never ordinary); (11) `released` with inexact match ⇒ retain; (12) a released
allocation cannot re-prepare; (13) metadata lock free ⇒ no takeover; (14) exit without a
barrier ⇒ never `retained-ready`; (15) barrier epoch mismatch or crashed controller ⇒
admission still refuses.

## 13. What this document does not claim

No custody, writer exclusion, final native history, backup/restore or cutover qualification
is claimed. No runtime, marker, cleanup, registry or startup change is made; nothing is
released, migrated or published. Registration, idle, clean shutdown and process scans are
never leases, and arbitrary same-uid external programs are **not** claimed to be protected
(§7).

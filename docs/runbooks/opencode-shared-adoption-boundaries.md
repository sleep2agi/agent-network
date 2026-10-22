# Existing OpenCode V2 shared-server nodes: adoption boundaries

Status: investigation and acceptance plan, **not implemented adoption support**.
Tracked in CommHub #1987. Source baseline: `d8bb4d154bb9d102b10a7ae25576f6b91831fb91`.

## Root cause

Daemon availability, node registration, creation and adoption are separate facts.
An online supervisor does not acquire authority over same-host nodes automatically.

`agent-node/src/runtime/adopt-local-identity.ts` rejects every
`opencodeMode === "copresence"` with `copresence_adopt_v2`, irrespective of
`opencodeGeneration`. `allowCodexV2` only permits the separate
`codexCopresence && runtime === "codex-app-server"` path.
`adopt-candidates.ts` invokes this same verifier without the Codex exception,
so its discovery list excludes OpenCode co-presence too.

The refusal is not just an obsolete feature switch:

- `adopt-daemon.ts` has ordinary-process and Codex-specific branches, not an
  OpenCode shared-server branch.
- `AdoptedChild` in `adopt-registry.ts` has a Codex-specific evidence shape,
  but no OpenCode session/server-custody binding.
- `adopt-lifecycle.ts` implements ordinary and Codex lifecycle operations.
  Neither is proof of safe OpenCode shared-server lifecycle behavior.
- Host-shared creation admission (`opencode-host-shared-create.ts`) prepares
  directories and a disposable launch probe. It is not a read-only adoption
  preflight and must not be called on a live node as a shortcut.

**Do not remove the guard before implementing the missing evidence and lifecycle
contract.** Support for creating a new V2 node is not support for adopting an
existing V2 node or permission to recreate its session.

## Separate failure categories

| Observation | Meaning | Safe next step |
| --- | --- | --- |
| Supervisor offline | No available management channel | Host owner investigates supervisor; do not batch restart nodes |
| `managed=none`, no adoption | No active management binding | Inspect support and evidence; do not fabricate a binding |
| `adopt_hub_mismatch` | Config and supervisor Hub URLs disagree under the existing canonical comparison | Verify the intended authority; do not rewrite URLs automatically |
| `adopt_local_verification_failed` | Sanitized fallback; exact failed predicate is not yet established | Obtain structured, redacted evidence; do not assume a permission issue |
| `copresence_adopt_v2` for OpenCode | Explicitly unsupported adoption topology | Keep current node untouched; implement and test the dedicated path |

`GET /api/nodes` intentionally omits `managed` and `adoption` for node-token
readers (see `node-lifecycle-read-http.test.ts`). Missing fields are **unknown**,
not `managed=none`. Preserve the distinction when comparing an owner/admin
snapshot with a node-scoped read. `lifecycle_controllable=false` is independently
observable but does not explain the refusal by itself.

There are two observability gaps at this baseline. The local verifier throws
`copresence_adopt_v2`, but the daemon's error filter accepts only letters and
underscores in that portion of the message, not the final digit. It rewrites
the refusal as `adopt_local_verification_failed`. Independently, the exact
public-code allowlist in `server/src/node-lifecycle-read.ts` does not include
`copresence_adopt_v2`; even if a daemon sends it, request/roster projections
rewrite it as `lifecycle_error`. Both losses have isolated test witnesses.
Track these narrow fixes separately in CommHub #2012, retaining redaction of
suffixes, unknown strings and paths. The client also needs explicit
unsupported-topology copy; improving error text is not adoption support.

## Required implementation boundary

First target: Linux, same-UID, existing OpenCode V2 co-presence node using an
already-running shared loopback server. Private servers, V1, Windows/macOS,
foreign UIDs, wrappers without attestable binary identity and ambiguous process
ownership remain explicit refusals until separately implemented and tested.

### Read-only preflight

1. Reuse owner/admin authorization and network/host checks from the existing
   adoption request. A node token must not request its own privileged adoption.
2. Verify canonical real workdir, configured adopt roots, owner/mode, symlink
   exclusions, exact config path, node ID, alias, network and Hub identity.
   The default workdir root is not proof that `adopt_roots` allows the node.
3. Validate the actual credential's immutable node/network identity via the
   existing authenticated identity boundary. Alias text, a config `node_id`,
   an active token belonging to some other node, or a locally stored hash is
   insufficient. No new endpoint may expose a token or secret-file content.
4. Bind Bridge PID/start ticks/UID/cwd/config to its existing runtime and
   session evidence. Validate TUI PID/start ticks and exact session target;
   neither an argv spelling nor a stale health record proves ownership.
5. Reuse the strict host-shared observer and executable/package generation
   attestation, including re-observation. Do not weaken EACCES, ambiguous
   listener or PID-reuse refusals. A URL, registry file or `--version` is not
   custody proof. Password paths must remain private, same-owner, non-symlink
   and unchanged through verification; values never appear in reports.
6. Authenticate to the existing server and read the exact existing session.
   Verify its real location and selected model against the frozen identity.
   A mismatch refuses; do not move/fork/create a session or change its model.
7. Freeze and revalidate all evidence immediately before persistence. A
   moving session, replaced credential/config/file or changed process
   generation invalidates the attempt. Live task/unknown-write ownership is
   not cleared or replayed by adoption. Fresh re-observation is necessary but
   does not close revocation or replacement races across an asynchronous wait;
   the binding-epoch/CAS contract below must also hold.

Existing launch-health and shared-server observation helpers can supply parts
of this evidence, not the entire adoption proof. They require adaptation and
negative controls, not an `allowOpenCodeV2` boolean around the guard.

### Management and failure semantics

- Persist a versioned OpenCode-specific evidence record only after successful
  preflight. No direct database or hand-written child-registry binding.
- Keep the existing fresh Hub binding check before every lifecycle operation,
  together with the binding-epoch/CAS contract below. A fresh read alone is not
  authority after a later asynchronous wait. Discovery, a local record or
  `pending` is never authority to signal a process.
- Adoption itself must not stop/restart Bridge or TUI, change session data,
  rewrite runtime configuration, rotate credentials or restart the server.
- A later explicitly authorized stop may affect only the proven node-owned
  Bridge/TUI generation. **Never signal the shared server or other nodes.**
  Generic process-tree or launch-residue collection is not a substitute for
  this custody distinction.
- Start/resume must retain the original session and fail closed if its server,
  credentials, location or generation no longer match. No fallback new server
  or session, and no unknown-turn replay. Exact in-flight/human-turn rules
  must be approved and exercised before lifecycle support is advertised.
- Definite Hub refusal rolls back only this request's local evidence.
  Unknown acknowledgement outcome retains evidence without granting authority;
  reconcile using the current Hub binding. Revoke while in-flight must not
  resurrect evidence or transfer control to a replacement process.
- Use redacted, stable refusal codes in the request result and client view.
  Test the actual client rendering separately from daemon unit tests.

## Required review gates and independently deliverable slices

Review source: CommHub #1987 comment 29940, against
`98ea5b82058b5f9d49584399e9daa2a29ec9d186`. The following are **requirements,
not implemented capabilities or passing acceptance evidence**. The existing
27 refusal tests establish no adoption, stop or resume support.

### Six non-substitutable safety gates

1. **Actual credential identity.** An authenticated identity read using the
   credential held by the running Bridge must prove immutable node/network
   identity. An owner/admin credential can authorize the human request but
   cannot substitute for that proof. Reading a token from disk does not prove
   that it is the running Bridge's credential. Missing or ambiguous evidence
   refuses without copying credentials, exposing values or issuing replacements.
2. **Versioned evidence tuple.** Freeze a format-versioned tuple covering
   node/network, Bridge and TUI process identities, listening server and its
   custody, original session, real location, model, boot identity and relevant
   config/executable/private-file generations. PID alone is not a generation;
   the tuple must detect PID reuse and replacement during every asynchronous
   verification step. Evidence hashes must not expose secrets or secret-derived
   values. Omitted `managed`/`adoption` projections remain unknown, not none.
3. **Borrowed shared-server custody.** Adoption acquires only a reference to
   the existing shared server, never its ownership, custody or termination
   right. This applies to indirect `close`, error handling, sweep, residue and
   process-tree cleanup too. No failure or rollback may terminate the server or
   signal a peer. This gate applies from slice B; it is not deferred to slice C.
4. **Zero-restart and lifecycle are separate.** Prove adoption leaves the
   Bridge, TUI, server and original session unchanged. That proof does not
   grant stop/start/resume capability. Advertise lifecycle only after its own
   implementation and acceptance; unsupported actions refuse and never fall
   through ordinary-process or Codex lifecycle branches.
5. **Hub/local CAS and revocation linearization.** Define the Hub/local
   transition protocol, an exact binding epoch and its authoritative
   compare-and-swap conditions before implementation. Specify where grant,
   reconcile, revoke and any later lifecycle operation linearize; every
   post-await continuation must reject a replaced/revoked epoch. A just-read
   current binding is insufficient. Concurrent adoption of one node has exactly
   one winner and one refusal; late ACK must not revive the loser or a revoked
   binding. Audit records must be machine-checkable and contain request ID,
   epoch, verdict, stable reason and a redacted evidence hash, not credentials.
6. **Crash/unknown/rollback matrix.** Enumerate each boundary before/after
   local evidence persistence, Hub CAS, ACK, reconciliation and revocation.
   Exercise crashes and delayed replies at each applicable boundary, including
   definite refusal, unknown outcome, duplicate delivery and late ACK after a
   newer epoch. Roll back only this request's metadata through the normal
   authority protocol; never overwrite a newer binding, restore guessed
   identities, mutate original session data or replay an unknown model turn.

### A → B → C → D delivery order

| Slice | Deliverable | Explicit limits and minimum evidence |
| --- | --- | --- |
| A | Read-only evidence verifier | Existing adoption guard still refuses. No registry/binding/config/process/session writes. Cover identity, missing projections, mixed generations, replacement and ambiguous custody with focused negative controls. |
| B | Zero-restart adoption with ACK/revoke/reconcile | Default flag off. All six gates above are prerequisites; lifecycle remains disabled. Use non-root isolated dual nodes on one real shared server, retain original Bridge/TUI/session and peer, and prove one-winner concurrent adoption plus crash/unknown/late-ACK behavior. |
| C | Explicit target-only Bridge/TUI stop | Separate human authorization and exact epoch/generation checks. Shared server/peer remain unchanged through success, failure, revoke and indirect cleanup. No generic process-tree fallback. |
| D | Original-session resume | Resume only the proven original session under approved in-flight/human-turn rules. Fail closed on changed server, credentials, location, model or generation; no new/forked session or unknown-turn replay. |

Each slice requires its own ordinary review, exact-head required checks and
only the focused evidence needed for that slice. A passing source or fixture
test is not a released package or production activation. Slice B onward needs
the real isolated dual-node/shared-server evidence above before any named
owner/admin-approved activation window is proposed. No currently running
communication node is a disposable acceptance target.

## Acceptance ladder before proposing a production window

1. Existing refusal contract: V1/V2 OpenCode remain refused even with the
   Codex exception; discovery omits them; request returns the exact refusal
   without config/PID/registry writes or credential disclosure.
2. Isolated preflight: correct fixture plus wrong node/token/network/Hub,
   realpath/location/model, UID, file mode/symlink, PID reuse, stale health,
   mixed Bridge/TUI/session generations, EACCES, multiple listener holders,
   wrapper binary and missing/changed server evidence.
3. Real non-root Docker with two nodes and one pinned real V2 shared server:
   adopt one node without session mutation or generation replacement. Verify
   original task reply and original TUI; unchanged peer continues working.
4. Separate authorized stop/start: target-only Bridge/TUI changes; server and
   peer PID/start ticks remain unchanged; resumed original session replies.
   Test busy human/task rejection, revoke, late ack, replay, crash/reboot,
   server loss and partial failure. No broad process cleanup.
5. Ordinary PR, complete exact-head checks, main merge, main-source release
   artifact and registry-byte verification. A branch test image is not a
   production package. Only then propose a named single-node window with
   owner approval, frozen evidence and a tested rollback.

Rollback must leave the shared server, original session/history and peer
processes intact. Revoke through the normal authority flow only when no
lifecycle operation is in flight; restore no guessed bindings and never
replay an unknown turn. Session/data restoration requires existing authorized
backup and retention sources, not an undocumented local copy.

No production adoption window is authorized by this investigation. Existing
nodes, daemon configuration and shared-server credentials remain unchanged.

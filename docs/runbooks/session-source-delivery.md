# Internal source-aware node identity delivery (#4150 / #590)

This layer follows confirmed `session_ready`. It is not a production node-create
entry point, nor evidence of an online native child bridge. All factories default
disabled; no HTTP/MCP/CLI/doorbell dispatcher instantiates them. Version: 2.0.22,
Linux only. Never promote or update the original `source_reserved` tombstone.

## Executed internal chain

- `createSessionSourceExecutionQueue.deliverySource` revalidates the authenticated
  requester, real permissions and immutable admission/execution association. The
  selected child session and child name come from SQL, not a client receipt.
- `createSessionSourceDeliveryQueue.queue` requires the source-aware daemon
  capability, calls existing `createNetworkTokenForNode` for real bound node/token
  metadata, and persists a UNIQUE execution-to-child delivery journal. The child
  token has a 60-second initial expiry. Only hashes/token IDs enter SQL.
- Plaintext token delivery reuses existing `putPendingEnvBlob` /
  `takePendingEnvBlob` one-shot memory-only semantics. The ordinary create queue
  never sees this source-aware type. Pending pull checks exact authenticated
  daemon/token/network, runtime capability and current requester permissions.
- The daemon reader requires the same live confirmed process-local lease,
  execution/admission IDs and the exact child ID it verified after fork. It
  checks source process/directory/session again and rejects busy or owned child
  sessions. Delivery performs GET-only resume verification, never another POST.
- `createSessionSourceProfileWorker` reuses `writeCreatedOpencodeProfile` and
  `recordChildWorkdir`. It creates an exclusive child directory plus fsynced
  non-secret claim, a private identity/profile bound to `sessionId`, and a private
  local shared-Server password file. The source is not restarted or modified.
- The explicit runner interface requires `existingSessionId === resumeSessionId`,
  `newSession: false`, expected version 2.0.22 and `new_child_only` policy. Tests
  inject a stub which reads the real profile and invokes the existing real
  authenticated `report_status` handler. Confirmation requires the child-bound
  token and a fresh matching node/network/alias/runtime-session SQL registration;
  only then is the token's initial expiry cleared.

## Retry and uncertainty

No second token/payload is minted for the same execution. A delivered payload
cannot be pulled again. Local directory residue refuses relaunch, including
concurrent workers and a restarted worker using the same private directory.
Lost memory blobs, expired credentials, lost registration ACKs and recovery of
unconfirmed delivery become `unknown_rotation_required`; recovery revokes the
credential and returns only known child/session IDs. It does not rotate, relaunch,
fork, create, or reconstruct plaintext secrets. Registered recovery is read-only.

The source lease presently requires a live original bridge. Consequently attach
delivery refuses rather than stealing that bridge. This does **not** implement
the user's desired selection of any idle, unbound existing Server Session.
Follow-up must split two lanes: (1) idle/unbound session attach, with independent
Server/session selection evidence and an exclusive bridge ownership protocol;
(2) occupied source session copy/fork, retaining the source bridge. Do not make
lane (1) depend on a previously bound source node, or bypass lane (2)'s owner.

## Concrete internal launcher

`createSessionSourceProfileWorker` now defaults to `createSourceResumeLauncher`,
using existing daemon `loadAndVerifyAnetBin` and `minimalEnv`. Tests may supply an
explicit local executable/argv prefix/environment using `nativeLaunch`; no npm,
npx, download or ordinary-create fallback exists. A `launch` override remains
only for existing narrow unit fixtures; it is no longer required for execution.

The executable command is `<vetted anet> node start <ASCII child directory>` in
the exact project, with private `ANET_SOURCE_RESUME_CONFIG` and a one-shot nonce.
The actual `agent-network/bin/cli.ts` source-only start branch requires that
private profile, no caller flags, exact vetted 2.0.22 package and exact paired
agent-node. It bypasses ordinary tmux replacement, start admission repair and the
restart supervisor. It spawns the actual agent-node CLI with explicit config,
alias, runtime and `--session <exact ID>`; no shell interpolation. The boolean
`--new-session` flag is deliberately absent (passing a string `false` would still
enable it in the existing parser). Runtime requires `newSession:false` explicitly.
Source-aware child profiles refuse normal `node start` without the handshake.

Before spawn and again in `agent-node/src/cli.ts`, `checkSourceResume` verifies
private profile/claim/password binding, expiry, authenticated loopback version,
selected session/directory, expected Server PID, auth gate, idle snapshot and live
bridge health ownership. `openSourceResumeRuntime` consumes a durable exclusive
runtime claim and calls the existing V2 shared resume core with exact session,
`newSession:false`, `reconcileResumedModel:false`, expected version 2.0.22. It does
not configure Server tools/providers/MCP, create a Server, POST a new/fork/model,
or launch a TUI. The source's existing explicit V2 unsafe-tools opt-in is required
and fingerprinted; the adapter does not silently grant it when absent.

After the actual CLI's authenticated `register()` succeeds with the exact session,
it publishes private nonce/child/session/version/PID health. The launcher waits for
this receipt, then the worker invokes the existing child-token-bound Hub confirm.
Failure/expiry/ACK loss stops only the newly spawned CLI handle; that source-only
CLI signals only its new runtime child handle, with bounded escalation. Never
signal a process group, Server PID, source bridge, or alias-selected process.
Durable launch/runtime claims prohibit another spawn after restart/uncertainty.
`recoverSourceResumeLaunch` reads known IDs/local receipts without HTTP or writes;
it is not a substitute for Hub `registration_confirmed` or a new authorization.

## Remaining acceptance and dispatch gaps

The default-off preview now has a callable HTTP/daemon transport: see
[managed-source fork transport](session-source-transport.md) for exact client
queue/poll contract, explicit capability negotiation and actual CLI worker wiring.
Production HTTP/MCP/SSE/daemon queue dispatch remains disabled by default. Automatic rotation,
cross-daemon recovery/adoption and general daemon stop/restart integration for
these one-shot children remain separate work; `worker.stopChild(deliveryId)` uses
only a retained handle from this worker's own launch, never an alias/PID lookup.
Client entry points and upstream
native V2 binary acceptance are not complete. No running business bridge or
production credentials are used in tests.

The new launcher adds no `/proc` dependency. However the evidence reader remains
Linux-only and existing shared-runtime process-health/package-verifier backends
still constrain platforms. macOS has not been accepted here; Windows package
verification is currently refused. Native Mac/Windows require their own evidence,
health, executable trust and lifecycle acceptance. Linux Docker results are not
Mac/Windows compatibility evidence.

The SQL registration fixture is not proof of a running bridge. Local serialization
and filesystem claims cover cooperating adapter writers, not external TUI/Server
writers or malicious same-uid processes. `/active` is a snapshot, not an atomic
Server-wide idle lock. No production/business credentials or installations are
used. Private profiles contain synthetic credentials in disposable tests only.

## Rebuild / recovery boundary

Authoritative launcher sources are `agent-node/src/runtime/source-resume-launcher.ts`,
the source-only start branch of `agent-network/bin/cli.ts`, and
`agent-node/src/cli.ts`. No production service or reverse-proxy changes are made;
the shared Server URL is delivered from verified local source evidence, not a
new port mapping. Secrets come from one-shot authenticated Hub delivery and a
local private shared-Server password file. No secret values belong in SQL or Git.
Build the normal exact paired CLI/runtime artifacts from these sources; verify
the candidate build plus native acceptance before enabling new dispatch. Rollback
means restoring the previous pair and leaving source dispatch closed, not
replaying old work. Preserve delivery/execution SQL journals, private child claim
files and external runtime bindings in encrypted backups. Lost leases/tokens are
not reconstructible from Git; lost/uncertain identities require separately
authorized rotation, never blind relaunch. No empty-machine native restoration
or production release is claimed by these isolated tests.

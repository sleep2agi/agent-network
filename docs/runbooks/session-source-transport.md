# Managed-source fork REST transport (gated preview)

This adds a callable client/daemon transport, not upstream-native acceptance.
Only **managed source → independent fork child** is implemented. Idle/unbound
Server Session attach remains separate work. Project-new Session creation has an
[independent gated lane](session-project-create.md), not source fork evidence. Read-only
project/Session discovery has an [independent gated directory lane](session-source-directory.md),
not fork or attach authority. Existing `create_node` still rejects `source_ref`, ordinary
daemons cannot consume these tasks, and `source_reserved` is never promoted.

## Client / main-node handoff contract

Types: `contracts/session-source-transport.ts` (`SourceForkSelection`,
`SourceForkReceipt`, `SourceForkStatus`). Reuse existing Create/Clone controls;
for this lane use a **new** endpoint, never ordinary create or background fork.

Human bearer required: unbound user/full credential, current network membership,
existing create-node role permission and source visibility. Node-bound/network
tokens do not acquire human authorization, even when their user owns the source.

`POST /api/node-session-control/source`, JSON (exactly these fields):

```json
{
  "network_id": "net_example",
  "source_node_id": "node_source",
  "session_id": "ses_Selected",
  "mode": "fork_independent",
  "child_name": "independent-child",
  "intent_id": "client_generated_unique_intent"
}
```

Use IDs from the selected managed source/current Session. The Hub resolves its
unique active managing daemon from existing create/adoption journals. The daemon
derives the authorized project and exact Server/session binding through existing
private registry evidence, not from the UI. No daemon ID, raw URL, project path,
token, evidence, binding or extra field is accepted in this human request.
The Session ID must match verified managed-source evidence; arbitrary Server
Sessions are not enabled here. Child names use existing node-name validation;
intent IDs use `[A-Za-z0-9_-]{1,200}`, Session IDs `ses_[A-Za-z0-9]{1,190}`.

Success HTTP 200, no-store JSON (IDs below are placeholders):

```json
{
  "ok": true,
  "request_id": "srcf_00000000-0000-4000-8000-000000000000",
  "intent_id": "client_generated_unique_intent",
  "network_id": "net_example",
  "source_node_id": "node_source",
  "daemon_node_id": "node_daemon",
  "session_id": "ses_Selected",
  "mode": "fork_independent",
  "child_name": "independent-child",
  "status": "evidence_pending",
  "expires_at": 0,
  "native_acceptance": "not_verified",
  "dispatch_scope": "gated_preview"
}
```

`expires_at` is actual Unix milliseconds, not the placeholder zero above.
`GET /api/node-session-control/source/<request_id>?network_id=<selected-network>`
uses the same initiating human credential/current permissions and returns this
same receipt shape. Known `child_session_id` / `child_node_id` appear when known.
It never returns a token, raw endpoint, filesystem path, lease or binding.

Progress: `evidence_pending` → `evidence_claimed` → `recheck_pending` →
`recheck_claimed` → `execute_pending` → `execute_claimed` → `deliver_pending` →
`deliver_claimed` → `registration_confirmed`. Failure terminals are `refused` and
`unknown_rotation_required`. Poll may skip intermediate states. Overall TTL is
75 seconds; inner evidence 15s/recheck 5s and delivered credential 60s remain
stricter. Slow/offline consumers fail closed; TTL is not proof of readiness.

The UI must show `registration_confirmed` as **registration receipt**, not native
acceptance, native TUI attachment or live health. Use existing node status/health
for online indication. Never silently generate another intent on unknown, timeout
or lost reply. Retry the original POST with identical fields/credential/intent to
recover its durable receipt; conflicting reuse returns 409. `unknown` polling
only converges known IDs and revokes unconfirmed secrets; it never replays fork,
create, mint or launch. A new intent is not a general recovery/rotation API.

Error body: `{ "ok": false, "error": "source_fork_unavailable" }`.

Source runtime eligibility uses the existing OpenCode family (`opencode-cli`,
`opencode`, legacy registration projection `opencode-sdk`) **only with explicit**
`config_snapshot.flags.opencodeGeneration="v2"` and
`config_snapshot.flags.opencodeMode="copresence"`. Missing/unknown/V1/headless
declarations and host supervisors refuse. These are actual CLI profile-derived
report fields, not Server/session ownership proof; daemon-local evidence and all
permission/management checks still apply. A runtime alias alone grants nothing.
404 gate disabled/unknown route; 401 invalid bearer; 400 invalid shape/caller type;
403 denied current scope/identity/permissions; 409 unavailable/conflicting/stale
workflow. Errors deliberately do not reveal private binding or raw exceptions.

## Daemon transport and actual CLI wiring

Mounted in `server/src/server.ts` before the ordinary node-session-control relay;
uses its credential/caller/body helpers. No new router framework or MCP tool.
Worker: `agent-node/src/runtime/session-source-transport.ts`. Actual
`agent-node/src/cli.ts`, **after register**, starts a one-second unref'ed bounded
singleflight consumer only when all preview/runtime constraints below hold.
Shutdown invalidates its frozen identity and stops only retained new child handles.

Daemon-only POST endpoints under the same root:

* `/daemon`: `{expected:{node_id,network_id}, capability, instance_id}`.
  `capability` must equal `source-fork-transport-v1-opencode-2.0.22`; instance is
  a process-local UUID. Live declaration expires after 75s. New instance retires
  the old one and converges outstanding old work to unknown. A retired instance
  cannot regain authority via delayed heartbeat. Bounds: 128 daemon declarations,
  64 retired instances per daemon per Hub incarnation, 128 active workflows.
* `/pull`: same exact fields; `{ok:true,task:null|SourceForkTask}`. Each task has
  request/intent/network/source/daemon envelope and one typed phase/body from the
  existing evidence, recheck, execution or delivery contract. A claimed phase is
  never re-delivered. Lost secret pull cannot reconstruct its one-shot body.
* `/ack`: same fields plus the envelope, `phase`, `result`. Each result must match
  that exact request's expected phase/evidence/execution, original requester and
  daemon token/instance. Existing queue validators remain authoritative. Negative
  `{transport_failure:"unknown_rotation_required"}` only abandons the exact
  claimed phase; it cannot dispatch or report success.
* `/child-register`: envelope plus `delivery_id`, **child bearer**, not daemon
  bearer. Existing delivery confirmation requires the exact fresh real SQL
  report_status child registration. This records registration progress; it does
  not fabricate registration from a worker status string. Daemon deliver ACK
  alone cannot create success.

Worker invokes existing `handleSessionSourceEvidenceRead`,
`handleSessionSourceLeaseRecheck`, `handleSessionSourceExecution`, then the real
profile worker/default source-resume launcher. The identity pin reuses
`createSessionControlPin`, checkpoints before/after fetch/body, rejects token or
epoch changes and does not retry effects. Poll is independent of the LLM lane;
SSE is not required, and this change adds no SSE secret payload.

## Explicit enablement (isolated acceptance only; production unchanged)

Defaults are OFF. Hub: `COMMHUB_SOURCE_FORK_PREVIEW=1` at startup.
Daemon: `ANET_SOURCE_FORK_PREVIEW=1`, Linux evidence backend, bound ntok and
network identity, verified existing anet pin, plus private daemon profile:

```json
{ "role": "host_supervisor", "sourceForkTransport": "source-fork-transport-v1-opencode-2.0.22" }
```

These fragments do not replace a full private daemon profile. No tokens are
shown; obtain credentials only from existing authorized provisioning.
The running CLI explicitly reports both capabilities in `config_snapshot`:
`source_node_delivery=source-node-delivery-v1-opencode-2.0.22` and
`source_fork_transport=source-fork-transport-v1-opencode-2.0.22`. Hub requires
both plus a live authenticated `/daemon` declaration. CLI version is not proof.
Before declaring, the worker probes the vetted launcher help for explicit
`ANET_CAPABILITY_SOURCE_RESUME_V1`. Launcher rechecks this at dispatch; actual
anet also probes the exact paired agent-node for that marker before spawning.
This prevents an older binary with the same package version taking the ordinary
start path. The marker does not attest upstream-native acceptance.

Secret transport reuses existing `secretTransportVerdict` in strict enforce mode
for this new lane: daemon's current session must report HTTPS or loopback (plain
and unknown refuse, independent of ordinary transport rollout policy). Worker
also requires HTTPS/loopback Hub URL with no URL credentials, query or path.

No production configuration, deployment, remote push, downloads or real business
node were changed. Do not enable production until client and native acceptance.

## Persistence / rebuild / rollback

Normal Hub startup applies `sessionSourceTransportSchema` via `server/src/db.ts`.
New `session_source_transports` stores IDs, initiating token **ID**, state and TTL;
no raw authorization or secret payload. Original human Request/evidence/lease and
one-shot secrets are process-memory only. Hub restart cannot reconstruct them:
nonterminal receipt becomes unknown on recovery. Retain the immutable admission,
execution, delivery and transport journals plus private claim/binding files in
encrypted data backups; Git reconstructs code/schema, not those data or secrets.

The authority sources are the above server/CLI files and the existing daemon
binary pin/config provisioner. There is no added port, reverse proxy or tunnel;
requests use the existing Hub origin. Build/install the vetted candidate pair by
normal repository release procedures only after separate authorization/acceptance.
Verify explicit capabilities and isolated HTTP tests, not version equality.
Rollback by disabling both gates and restoring the previous vetted pair; never
delete tombstones to retry work. Lost secrets need separately authorized identity
rotation, not automatic remint. General daemon adoption/restart reconciliation,
Mac/Windows evidence/lifecycle, client UI and upstream native V2 remain gaps.
# Read-only project/Session directory

The independent gated directory contract is documented in
[session-source-directory.md](session-source-directory.md). Its opaque Session
IDs are not native IDs and must not be sent to this fork transport. Directory
selection/binding unknown never authorizes attach or create.

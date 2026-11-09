# Existing project → new empty Session → independent child (gated preview)

Types: [`server/src/contracts/session-project-create.ts`](../../server/src/contracts/session-project-create.ts).
Prerequisite directory: [session-source-directory.md](session-source-directory.md).
This is **not fork or attach**. No existing Session is selected, no source evidence
is invented, and `oses_` IDs must never be supplied to managed fork's native `ses_`
field. Client and native variant/source trees are not modified by this delivery.

## Native API checked in the local 2.0.22 source

Read-only checkout `/tmp/opencode/ocv2-4099-native`, commit
`29040e240ecf238c84ab63a7f9e2420e4c3479d6`, package version **2.0.22**:

- `packages/protocol/src/groups/session.ts`: `POST /api/session`, optional
  `id`, `parentID`, `title`, `agent`, `model`, `location`, metadata/permissions;
  response `{data: Session.Info}` including `id`, `projectID`, `location.directory`.
- `packages/server/src/handlers/session.ts`: explicit `location` is honored when
  there is no `parentID`; omission would use Server cwd, so never omit location.
- `packages/core/src/session.ts`, `Session.create`: with no supplied id, allocates
  a new ID, resolves the location's project and publishes `SessionEvent.Created`.
  It does not fork/copy messages or submit a prompt. Supplying an existing id can
  return its existing Session; this adapter deliberately supplies **no id** and
  never uses that behavior to retry an uncertain POST.
- `groups/model.ts`: `/api/model/default` returns the model used when a Session
  has no explicit selection. `server/src/location.ts` accepts the existing
  catalog reader's `x-opencode-directory` header and reports location in response.

The only native write in this lane is exactly once per accepted intent:

```json
POST /api/session
{"location":{"directory":"<daemon-resolved-private-canonical-project>"}}
```

No parent, client id, source transcript, model mutation, prompt, import, fork or
Session DELETE is sent. Before POST, the existing read-only provider/model/default
catalog resolves the project's explicit default model for the co-presence runtime
(which requires a `provider/model`). Missing/inconsistent defaults refuse before
POST; no guessed model or paid probe. The selected model hint is private child
configuration; it is not a credential/invocation verification or a default-model
locking guarantee against independent native configuration writers.

## Explicit enablement and local policy

All defaults OFF. Requires the directory preview plus:

- Hub: `COMMHUB_PROJECT_NEW_SESSION_PREVIEW=1`.
- Linux daemon: `ANET_PROJECT_NEW_SESSION_PREVIEW=1` and private profile
  `projectNewSessionTransport:"project-new-session-v1-opencode-2.0.22"`.
- Actual daemon snapshot declares `project_new_session` with that exact marker.
  The worker verifies its configured exact-resume launcher's real help capability
  before live declaration, not package/CLI-version inference. An ordinary node or
  directory-read-only daemon cannot consume project-create tasks.
- The exact private directory grant additionally opts in:

  ```json
  {"allow_new_session":true,"opencode_unsafe_tools":true}
  ```

  These are fields on the existing `opencode-directory-authorities.json` grant,
  alongside `server_id`, `network_id`, `source_node_id`, `directories`. No source
  node's model/unsafe-tools/profile is borrowed. A read grant alone is not a write
  grant. Both flags, canonical project mapping, unchanged registry/password/grant,
  version/auth/known-project checks and current frozen daemon pin are required.

Existing human create-node owner/admin, network and source-visibility gates are
reused. `source_node_id` remains a permission anchor, not alleged ownership or fork
evidence. Child identity and credential use real `createNetworkTokenForNode`, the
same one-shot env-blob transport and fresh exact child-bound registration helper.

## Directory freshness vs human choice vs operation deadline

Do not turn the old 30-second directory TTL into a 15-second human decision limit.
With the explicit new-session daemon preview, a ready directory snapshot has the
**optional additive** `selection_expires_at = expires_at + 600000` field:

- `expires_at`: unchanged 30-second directory/read freshness. Poll after this
  deadline still refuses. It is not extended and never means Session idle/free.
- `selection_expires_at`: about ten minutes to choose **a project** from that
  particular snapshot and submit a new-project intent. No Session attach authority
  is conveyed. New-write admission rechecks current human permissions, exact
  daemon instance/capability, project/snapshot scope; daemon rechecks private grant,
  project/API/default model at execution. It is safe to use the UI's cached project
  choice until this deadline, without pretending old Session status is fresh.
- Once accepted: `accepted_at + 300000` is the **independent five-minute operation
  deadline**. Selection/read expiry no longer cancels a legitimately accepted
  operation. Daemon's private references are retained through this bounded period.
  Permission/pin/registry changes or daemon/Hub restart still fail closed.
- Initial child credential expires no later than 60 seconds after mint, or the
  operation deadline, whichever comes first. That expiry clears only on the exact
  fresh registration receipt authenticated by the delivered child credential.

Legacy read-only snapshots **without** `selection_expires_at` remain accepted for
directory reads, but cannot authorize this new path. Directory-only workers retain
their original wire shape. UI must require this field plus supported new-session
capability, not infer support from version or stretch a legacy TTL. After selection
expiry, refresh the directory for a *new* action; never generate a fresh intent to
silently repeat a timed-out/unknown accepted action. Scope cache is bounded to 100
entries; concurrent refresh floods may explicitly report busy, not evict authority.

## Human HTTP contract

Base `P=/api/node-session-control/source/project-create`. Persisted human Bearer
credential, no master/dev fallback or node-token human authorization.

### Submit

`POST P` accepts **only these five fields**:

```json
{
  "selection_scope": "srcdir_<ready-project-directory-request>",
  "snapshot_id": "snap_<that-snapshot>",
  "project_id": "oprj_<returned-project-id>",
  "child_name": "<validated-new-child-name>",
  "intent_id": "<stable-client-intent>"
}
```

The scope must be the selected-Server request that returned projects, not the
initial Server-only list. The initiating human credential must match that scope.
Hub resolves/fixes network, source permission anchor, daemon token/instance from
the scope. Client cannot supply network override, daemon override, native project
or Session id, server id, URL/path, model, token, password, headers or raw config.

The same exact intent/body returns the existing durable receipt **before looking
up an expired directory scope**, including after Hub reconstruction. Changed
snapshot/project/name/body cannot repurpose that intent. Unique `(user, network,
intent)` and `(network, child_name)` reservations prevent duplicate writes and
name reuse through this lane. Existing names/ordinary pending creates/source
reservations are checked; this is not a general cross-product alias-lock redesign.
Do not silently choose another name/intent after an ambiguous result.

### Poll and display

`GET P/<prjc_request_id>?network_id=<receipt-network>` with the initiating credential
and current permissions. `200` contains only:

```text
ok: true
request_id: prjc_<uuid>
network_id, daemon_node_id, intent_id, child_name
accepted_at, expires_at: Unix milliseconds
status: create_pending | create_claimed | delivery_pending | delivery_claimed
        | registration_confirmed | unknown_rotation_required
session_creation: "not_started" | "confirmed" | "unknown"
child_node_id?: node_prjc_<uuid>
registration_is_health: false
native_acceptance: "not_verified"
```

Native Session id, directory/endpoint/model and secrets are **not** returned to
the human. `session_creation:"unknown"` explicitly includes a lost success body:
it is **not** a claim that no Session was created. A confirmed Session may still
have failed child launch. `registration_confirmed` is registration receipt only;
show “registered”, not “online/healthy/TUI ready”. Use existing live-node reads to
show independent health. Receipt remains confirmed if that child subsequently
stops; it does not become false historical success or authorize relaunch.

Default gate: authenticated `404`; authentication `401`; malformed/raw inputs
`400`; wrong scope/caller/network/current permission/capability `403`; conflicts or
unavailable/busy `409`. Stable error `project_create_unavailable`, no raw exception.
Responses are no-store. Current permission loss can prevent reading the receipt;
it does not authorize recreating an inaccessible intent.

## Execution, credentials, claims and unknown convergence

The existing mounted source handler calls the project transport (no new router or
MCP tool). The **same actual CLI consumer**, frozen `SessionControlPin` and live
directory daemon declaration carry `P/pull` and `P/ack`, with exact expected
node/network, process instance and project capability. `/directory/daemon` includes
`project_create_capability` only after explicit actual launcher verification.
Claimed phases are never redelivered.

`session_project_creates` is an atomic intent/name/phase journal, not an ordinary
create outbox. Source admission/grants/reservations require managed-source evidence
and cannot represent this operation, so no fictitious source refs/tasks or
`source_reserved` rows are created or promoted. SQLite atomic support is required;
unsupported transaction adapters refuse admission. SQL stores IDs/state/deadlines
and hashed token metadata only, no raw credentials/directory/endpoint.

Daemon reuses the source executor's extracted **single durable claim** primitive:
private fsynced O_EXCL journal before POST, bound to the complete accepted task.
The initial record is unknown. Uncertain POST, crash or lost response never causes
another POST, including reconstruction/replay. No native idempotency-id guessing
or ordinary-create fallback. Secret/native context is process-local; recovery can
read a journal but cannot reconstruct authority, re-create a Session or relaunch.

Only a valid session-ready ACK atomically records its Session id and mints **one**
child credential. Secret delivery is the existing memory-only one-shot env blob.
If that ACK body is lost but the same instance still holds its known result and
original secret remains available, it may consume the original pending delivery
once. It never repeats create or mints another credential. Lost secret/body,
reconstruction, expired deadlines or invalid authority settle to
`unknown_rotation_required`; unconfirmed credential is revoked, never rotated.
An accepted workflow may remain claimed until its deadline if nobody polls it;
poll/pull performs negative-only convergence and the expiry timer also settles it.

Delivery uses existing private profile/binding writer, child-only exclusive
directory/tombstone, exact-resume launch/runtime claims, actual `anet node start`
source-only branch and paired runtime. Its historical `sourceDelivery` profile
marker now explicitly says `operation_kind:"project_new_session"`; this is a
generic resume-only launch envelope, **not synthetic source evidence**. The child
opens the exact returned native Session id with `newSession=false`, no second
create/fork POST, no ordinary restart supervisor. Version, auth, local Server pid,
exact Session directory and conflicting live bridge checks are retained. Pid and
selection leases remain process-local, not durable Server incarnations.

Fresh exact child-token-bound real registration is verified through the same
helper as source delivery. Only then is credential expiry cleared. Failure
cleanup signals only the newly returned child handle (or the launcher's own newly
spawned process). Never kill the shared Server/source bridge, delete a source,
delete a known/unknown Session, overwrite an existing profile or auto-adopt residue.
An orphan empty Session after uncertain creation is left for authorized manual
inspection; no delete authority is inferred from a failed request.

## Recovery, rollout and remaining acceptance

No production action performed. Existing Hub `/api` reverse-proxy route/startup
mechanism is unchanged. Deploy the candidate Hub/runtime through the deployment's
existing launcher only with separate authorization, then explicitly enable its
directory/project gates/profile/grant; verify markers plus HTTP chain rather than
package version. Remove gates/profile/grant to disable; return to prior binaries
to roll back. New SQLite journal table is additive. **Do not delete its unknown
intent/name claims on rollback**, or old requests could be recreated. Persistent
receipts need the normal database backup; private registry/grant/credentials need
the operator's protected config/secret backup. In-memory directory/secret scopes
are intentionally not recoverable after process loss; they converge unknown.

Test evidence: [report](../tests/report-test4099-4150-release-reverification.txt). Linux isolated
controlled Server plus synthetic native package only. Actual anet/agent-node CLI,
shared-resume core, Hub registration and an idle SSE connection are exercised;
this is **not upstream-native 2.0.22/TUI, provider-auth, Mac/Win or complete task
delivery acceptance**. New children are not automatically adopted into every
other lifecycle/fork management journal. General restart/adoption/rotation and
client UI/native full acceptance remain separate. Unknown-binding attach is
explicitly unimplemented; `activity:"unknown"` is never treated as idle.

Follow-up [real patched native acceptance harness](../../tests/test4150-native-project/README.md)
uses the independently built **2.0.22-anet-test.29040e2** ELF, not stock 2.0.22.
Its test-copy-only exact identity/SHA overlay does not change product pins or
authorize deployment. It replaces the controlled native HTTP Server/executable
for the no-prompt project-new/actual CLI/registration lane. Native SSE is checked
by an explicitly separate acceptance observer; the idle child uses Hub SSE and
native state polling. This is not native TUI, paid-provider, business task,
existing-source attach/fork or Mac/Windows acceptance.

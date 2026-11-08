# Existing Session → new ANet node (preview, default OFF)

This is the existing project-create journal/worker with an `attach_existing_session`
operation, not source fork, adoption, a new router or ordinary create fallback.
It requires a finite local operator grant. Directory reads alone never authorize
attach; `binding: unknown`, `activity: unknown` and `attach_authorized: false` from
the directory remain observations, not permission or proof of global absence.
The explicit attach request below asks the daemon to validate the operator grant
and exclusively reserve the ANet bridge namespace. It can still refuse after
HTTP admission. There is no UI change in this delivery.

## Configure once: explicitly delegate existing-Session attach

Per-Session manual grants below remain compatible, but are **not required** when
the local operator explicitly delegates the already authorized scope. The daemon
then derives and consumes a finite exact Session grant itself when a legitimate
human selects an opaque Session. No native ID, PID, start ticks or per-Session
expiry is entered by the client or the operator on each click.

Add the following **independent** field to the intended existing private authority
grant. Example JavaScript shows how to compute numeric expiries once; it does not
write/enable any actual configuration. Keep the current outer `server_id`,
`network_id`, `source_node_id`, `directories` and existing private registry intact.

```js
existingGrant.opencode_unsafe_tools = true; // existing runtime policy opt-in
existingGrant.allow_attach_existing = {
  enabled: true,
  policy_id: crypto.randomUUID(),          // stable for this operator delegation
  daemon_id: "<exact-existing-daemon-node-id>",
  directories: ["/canonical/already-authorized/project"],
  expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000, // operator's policy expiry
  grant_ttl_ms: 120_000                    // each derived exact grant: 2 minutes
};
```

The field is absent by default. `true` alone, disabled/malformed/expired policies,
read permission and `allow_new_session: true` are **not** attach delegation.
Policy directories must be a nonempty subset of that grant's existing canonical
directories. The outer grant still binds the existing Server/network/source;
`daemon_id` must match the current immutable daemon identity. Policy expiry must
be a finite integer in the future. Exact-grant TTL is an explicit integer from
1,000 to 300,000 ms, not supplied by the human request.

With the separate preview gates/capability enabled by the operator, a client can
then directly select an existing Session and send the unchanged five-field POST.
It cannot create/extend this policy, broaden a directory/Server, set native
identities, skip current create/visibility checks or ask for a longer expiry.
This is backend capability delivery, not a claim that a client UI was modified
or deployed in this change.

For every accepted intent the actual daemon checks authenticated native
`GET /api/info` and `GET /api/session/:nativeID`, exact project/directory/Session,
the current OS loopback holder PID/UID/start ticks/socket inode before/after, and
the unchanged private authority fingerprint. Only then does it derive a grant
bound to policy/request/intent/child/Session/Server incarnation. Its expiry is
`min(policy expiry, accepted workflow expiry, accepted_at + grant_ttl_ms)`;
repeated reads do not extend it. A deterministic request-bound grant identity
uses the same existing private consumption tombstone and common ANet namespace
claim. No private authority file is rewritten or forged, and no new router,
journal/table/state machine, credential or native mutation is introduced.

Matching finite manual grants retain precedence. If none matches, only an
explicit valid delegation can derive one. Persisted derived consumption includes
only non-secret binding metadata, never password/token/authorization. Unknown
results do not derive a new identity, mint, retry a launch, delete claims or
fallback to new Session. Policy revocation/expiry can cause an already accepted
operation to refuse; the client must not invent a new intent to recover unknown.

The delegation authorizes a directory scope, not global idleness: another ANet
bridge/unknown claim, a running native Session or unverifiable Server still
refuses. Human TUI/external-writer boundaries and registered-not-online semantics
remain unchanged. No production/business configuration was enabled here.

## Public callable contract

First use the existing directory HTTP workflow to obtain a ready project/session
snapshot. POST `/api/node-session-control/source/project-create` with the current
human credential and **exactly five fields**:

```json
{
  "selection_scope": "srcdir_<snapshot-request-uuid>",
  "snapshot_id": "snap_<uuid>",
  "session_id": "oses_<uuid>",
  "child_name": "existing-session-child",
  "intent_id": "client-generated-stable-intent"
}
```

No native `ses_*`, project/path/URL/model/provider/token/network/daemon or operation
override is accepted. `session_id` is the opaque displayed Session selection,
NOT the native delivery Session ID. Its parent opaque project ID is resolved by
the Hub and stored separately. The directory list remains read-only and bounded.

Poll the returned `prjc_*` request at
`GET /api/node-session-control/source/project-create/:request_id?network_id=:network`.
The durable receipt explicitly includes:

```json
{
  "operation_kind": "attach_existing_session",
  "session_creation": "not_performed",
  "status": "registration_confirmed",
  "registration_is_health": false,
  "native_acceptance": "not_verified"
}
```

`registration_confirmed` is historical **registered**, not online/readiness.
The operation reuses existing pending/claimed/delivery/unknown phases and the
single-mint + one-shot delivery ACK chain. `unknown_rotation_required` does not
authorize retry, remint, relaunch, a new Session, a fork or a model/prompt write.
Replay the identical five-field intent to read its durable result, including
after directory expiry; do not change the intent to recover an unknown launch.
Public refusal remains `project_create_unavailable`, without native diagnostics.

Current human create permission, source visibility, network membership, immutable
daemon token/instance and actual capability declaration are rechecked throughout.
The public operation does not imply that the local operator grant exists.

## Explicit preview gates (do not enable business/production nodes)

Hub: `COMMHUB_SOURCE_DIRECTORY_PREVIEW=1` and
`COMMHUB_SESSION_ATTACH_PREVIEW=1`. The project-new and source-fork gates are
independent and are not needed for attach.

Actual Linux host-supervisor CLI requires its existing directory config/gate plus:

- environment `ANET_SESSION_ATTACH_PREVIEW=1`;
- private config `sessionAttachTransport: "existing-session-attach-v1-opencode-2.0.22"`;
- existing `ANET_SOURCE_DIRECTORY_PREVIEW=1` and the exact directory transport pin.

It publishes `daemon_capabilities.session_attach` with that exact value, declares
the capability to the existing directory daemon endpoint, and polls the same
project worker. An ordinary/read-only daemon does not gain attach by advertising
project-new, SDK, V1, unknown runtime or a host role alone. The worker still verifies
the local paired CLI's source-resume capability before consuming work.

## Local finite operator grant

Only extend the operator's **already authorized** directory/Server grant in the
private `.anet/opencode-directory-authorities.json` under the daemon workdir.
Preserve network/source/project/registry boundaries. Add `attach_sessions` entries
and require `opencode_unsafe_tools: true` as the existing shared runtime policy
opt-in. This example uses placeholders, not a production authorization:

```json
{
  "grant_id": "<one-use-uuid>",
  "daemon_id": "<exact-daemon-node-id>",
  "directory": "<canonical-existing-authorized-project>",
  "session_id": "ses_<exact-existing-session>",
  "server_pid": 12345,
  "server_start_ticks": 123456789,
  "expires_at": 1794078000000
}
```

Native ID/path/PID appear only in this local private operator file, never the
human POST. The daemon requires Linux OS loopback socket-holder evidence, same
UID, exact PID/start ticks and native `/api/info` identity; HTTP PID alone is not
ownership. The existing private registry supplies URL/password. The entire
private authority fingerprint is revalidated during selection and delivery.
Grant expiry must be finite, still live and at most ten minutes after acceptance.
There must be exactly one matching grant for the selected Session/project/daemon.

Consumption is an exclusive fsynced file under the canonical project's private
`.anet/session-attach-grants/<grant_id>`, binding the exact request/Session/child.
It survives worker reconstruction and is shared across daemon workdir copies.
Repeated reads by that same accepted operation do not assign it to another child.
Consumption precedes the namespace reservation; failure between them burns the
grant, never permits a second assignment. It is not a distributed transaction or
proof of an external runtime's inactivity. Do not delete consumption tombstones
or unknown claims to make an acceptance run pass.

## Common ANet shared exact-resume claim

All current ANet V2 **shared exact-resume** paths enter the same atomic claim in
`source-resume-launcher.ts`, called from `opencode-copresence/v2-session.ts` before
GET/resume/model handling. Owned nonshared new-session paths are unchanged.

Claim key: canonical project + existing literal loopback URL + actual Server
process incarnation + native Session ID. Owner directory is atomically created,
private, fsynced and bound to child workdir/request/nonce. Attach reserves it
**before** readiness ACK/credential mint. Its exact one-shot child can consume
the reservation once with a second `wx` runtime claim, after existing private
delivery/launch/runtime nonce validation. Other child names and ordinary shared
resume compete on the same key, not on separate child-directory locks.

Under that claim the daemon also refuses known old live bridge health and
matching legacy per-child claims. Unknown/dead/stale namespace claims are not
automatically cleared, adopted or treated as global idle. Existing per-child
claims remain the additional durable no-relaunch boundary. Only the successfully
opened owning runtime's normal close can release its exact nonce/runtime lock;
startup failure, crash or uncertain state retains the tombstone. No other PID,
process group or native Session is stopped/deleted to make attach possible.

This constrains current cooperating **ANet** bridge paths. It does not lock human
TUI, external writers, an arbitrary old executable that ignores the protocol, or
multiple machines/filesystems. Independent human TUI is allowed; no global
absence/exclusivity assertion is made. Native running state still causes attach
to refuse; absent native running state alone never authorizes it.

## Reproduction

Offline controlled suites use the existing Docker image and bind **source**, not
the entire dependency directories. Run via the harness background tool:

```sh
sg docker -c 'TEST4150_NATIVE_ATTACH=1 sh tests/test4150-native-project/run.sh'
```

That command selects only `session-project-attach-native.test.ts`, not the prior
new/fork acceptance test. Fixtures prepare two new sandbox-native Sessions and
one deterministic loopback completion; those setup POSTs are counted separately.
The actual attach window and both actual CLI children perform native GET only.
For the **separate one-Session delegated** native check (not the previous full
manual/native acceptance), use:

```sh
sg docker -c 'TEST4150_NATIVE_ATTACH=1 TEST4150_NATIVE_ATTACH_DERIVED=1 sh tests/test4150-native-project/run.sh'
```

It prepares one empty native Session, writes only the delegated directory policy,
and attaches one actual CLI child. Preparation create is separately counted;
attach and child have zero native writes and zero provider/prompt calls.
The exact SHA/test-only overlay remains mandatory; no binary rebuild/install or
stock product pin relaxation is involved. See the evidence report for run IDs.

Linux exact patched ELF is not stock, macOS/Windows, native TUI readiness, full
business SSE task execution, external provider quality or production acceptance.

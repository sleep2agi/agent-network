# Existing OpenCode project/Session directory (read-only preview)

Client contract: [`contracts/session-source-directory.ts`](../../contracts/session-source-directory.ts).
This lane is independent of [managed-source fork](session-source-transport.md).
It does **not** attach, fork, create, resume, adopt, mint a child credential or
promote `source_reserved`. No client or native OpenCode tree changes are included.

## Why this transport

Inspected existing `server/src/opencode-v2-catalog.ts` and
`agent-node/src/runtime/opencode-v2-catalog-daemon.ts` first. That catalog is the
provider/model/tools catalog, tied to a succeeded/delivered child create row and
its owned project directory. It is not a Server registry or a directory of
unbound Sessions. Widening it to a whole Server would expand existing child
authority. Instead this adds a bounded read task to the already mounted
session-control **source** HTTP handler and actual daemon consumer, reusing its
frozen identity pin, human permissions, strict channel policy and daemon instance
retirement. There is no new router, MCP tool, SQL journal, evidence challenge or
write-recovery state machine.

## Native 2.0.22 fields verified locally

Read-only source inspection: `/tmp/opencode/ocv2-4099-native`,
`29040e240ecf238c84ab63a7f9e2420e4c3479d6`, root package version `2.0.22`.
No changes, build or native process launch in that checkout.

- `packages/protocol/src/groups/project.ts`: `GET /api/project` returns an array.
- `packages/schema/src/project.ts`: `id`, `canonical`, optional `name` (plus
  private/unneeded metadata which is never forwarded).
- `packages/protocol/src/groups/session.ts`: `GET /api/session` accepts `directory`,
  `project`, `limit`, `cursor`; returns `{data, cursor:{previous?,next?}}`.
- `packages/schema/src/session.ts` and `location.ts`: `id`, `projectID`, optional
  `title`, `location.directory`.
- `packages/server/src/handlers/session.ts`: even the final nonempty page has a
  next cursor; read through the empty page, reject repeated cursors/oversize.
- `GET /api/session/active` returns `{data:{[nativeSessionId]:{type:"running"}}}`.
  Absence is **unknown**, not proof of idle or no bridge owner.

These are source-derived API adapters tested against a controlled HTTP Server,
**not upstream-native binary/TUI acceptance**. Linux only; no macOS/Windows claim.

## Private operator registration (not client input)

Default OFF. Hub opt-in: `COMMHUB_SOURCE_DIRECTORY_PREVIEW=1`. Daemon opt-in:
`ANET_SOURCE_DIRECTORY_PREVIEW=1` plus its private profile:

```json
{"sourceDirectoryTransport":"source-directory-read-v1-opencode-2.0.22"}
```

Only a Linux `host_supervisor` with bound startup node credential/network starts
the actual independent polling lane. It declares `source_directory_read` with
that exact capability. The existing session-control pin is invalidated on
credential/epoch change. Hub also requires the strict HTTPS/loopback channel.
Neither package version nor an ordinary node is directory authority. Fork gates
and launcher capability are **not** required for directory-only polling.

Reuse the existing `HOME/.anet/opencode-shared-server.json` registry:

```json
{"url":"http://127.0.0.1:<port>","passwordFile":"<absolute-private-password-file>"}
```

It supplies one already-running loopback Server. No port discovery, directory
walk, package install, Server start/restart or source-profile fallback occurs.
This registry alone grants **no network/project access**. Add the following
operator-owned file at `<daemonWorkDir>/.anet/opencode-directory-authorities.json`:

```json
{
  "version": 1,
  "grants": [{
    "server_id": "osrv_11111111-1111-4111-8111-111111111111",
    "network_id": "<network-id>",
    "source_node_id": "<visible-opencode-node-id>",
    "directories": ["<explicit-canonical-existing-project-directory>"]
  }]
}
```

Choose an opaque random UUID for the Server ID; the example is not a real
registration. All grants in this minimal implementation must name that **one**
registered Server ID. One grant per network/source pair; ambiguous duplicates
fail closed. Up to 16 grants and 16 explicit canonical project directories per
grant. Registry, authority and password files must be current-uid-owned regular
single-link private files, no symlinked path, <=32 KiB; both `.anet` directories
must also be private current-uid-owned canonical directories. Project directories
must already exist and be canonical, without symlinks. Invalid/missing authority
returns `failed`, not empty success. Do not create these files in production as
part of testing. Registry/authority/password are local operator data, not Git
artifacts or HTTP payloads; restore them from the operator's protected configuration
and secret backup, never from client-supplied paths.

`source_node_id` is a **permission anchor**, not a claim that it owns this Server
or any returned Session. Current human network membership, source visibility and
the existing create-node owner/admin rule are checked on every queue/poll/pull/ACK.
There is deliberately no required previous child create/adoption binding. The
explicit local grant—not visibility of a known managed source—authorizes the
registered Server's listed directories. Node credentials cannot authorize humans.

## Client HTTP contract

Base `D=/api/node-session-control/source/directory`. Persisted human Bearer only
for queue/poll. Responses have `cache-control:no-store`.

1. `POST D` with **exactly**:

   ```json
   {"network_id":"<network>","source_node_id":"<visible-node>","daemon_node_id":"<authorized-daemon>"}
   ```

   Returns `200 {ok:true,request_id:"srcdir_<uuid>",network_id,source_node_id,
   daemon_node_id,expires_at,status:"pending"}`. `expires_at` is Unix milliseconds,
   **30 seconds from queue**, not a sliding lifetime. Daemon must have a live
   explicit declaration. This first request only reads the private registry/grant;
   its `servers` list is configured selection metadata, **not Server health**.

2. `GET D/<request_id>?network_id=<same-network>` with the **initiating human
   credential**. States: `pending`, `claimed`, `ready`, `failed`. Only `ready`
   includes `snapshot`; `failed` includes `error:"directory_read_failed"` and no
   snapshot. Unknown ID, expired scope, changed permissions, cross-network/caller,
   daemon revocation/restart or vanished capability refuses (`403`), never an empty
   catalog. Default gate `404`; malformed input `400`; unavailable/limit `409`.
   Error bodies use `source_directory_unavailable` without private exception text.

3. Once ready, select a returned Server with another `POST D`:

   ```json
   {"network_id":"<same-network>","source_node_id":"<same-source>","daemon_node_id":"<same-daemon>","server_id":"osrv_<returned-uuid>","selection_scope":"srcdir_<first-request-uuid>"}
   ```

   The parent must be a ready Server-selection request from the same credential,
   network/source/daemon/process instance. A forged/stale Server ID fails. The
   second request expires **no later than its parent**; a new POST never extends
   selection authority. Poll its request ID using step 2. The daemon independently
   rereads the private grant before and after reading the native API. Removed or
   changed authority fails; no managed-source or ordinary-create fallback.

4. `ready.snapshot` has exactly:

   ```text
   snapshot_id: snap_<uuid>
   expires_at: same request deadline
   lease_kind: "process_local"
   completeness: "authorized_scope_only"
   servers:  [{server_id: osrv_<uuid>, title: string}]
   projects: [{project_id: oprj_<uuid>, server_id: osrv_<uuid>, title: string}]
   sessions: [{session_id: oses_<uuid>, project_id: oprj_<uuid>, title: string,
               activity: "running" | "unknown", binding: "unknown",
               attach_authorized: false}]
   ```

   With explicit project-new preview, an optional `selection_expires_at` field
   gives a separate ten-minute **project choice** window. Directory freshness
   stays 30 seconds. Legacy read-only snapshots omit it and remain readable;
   they cannot authorize project creation. The independent
   [project-new contract](session-project-create.md) rechecks scope, human/daemon
   permissions and private write policy, then uses its own operation deadline.

   IDs are opaque **directory IDs**, not native Session IDs, source refs or write
   permits. Project/Session IDs are fresh per snapshot. Do not feed them to the
   fork endpoint's native `session_id`, ordinary create, or a future attach API.
   The request scope and snapshot ID do not authorize a write. Refresh from step 1
   after expiry/restart; no automatic mutation is associated with a refresh.
   `running` means sampled native busy; all other activity and **all binding**
   remain `unknown`. Existing unbound Sessions can appear without an ANet node
   mapping, but the UI must label them **binding unknown / candidate**, not
   "confirmed free". Neither activity nor this process-local snapshot excludes
   external writers or establishes a durable Server incarnation/ownership lease.

Only exact whitelisted fields leave the daemon. No raw URL, filesystem directory,
native project/Session ID, cursor, credential, profile or auth header reaches the
client snapshot. Titles are intentionally lossy: bounded, control/path/credential-
like text replaced with `Project`/`Session`/`Server`; arbitrary user-entered title
text is not a general-purpose secret detector. Private transport credentials are
never used as titles or persisted in directory journals. Do not log raw native
responses. Client must render titles as text, not HTML.

## Daemon contract and limits

Actual CLI worker uses the existing frozen `SessionControlPin.post` for
`POST D/daemon`, `D/pull`, `D/ack`, each with exact
`{expected:{node_id,network_id},capability,instance_id}`. `/ack` adds only
`request_id,result` (`SourceDirectorySnapshot` or `{error:"directory_read_failed"}`).
Declaration lasts 30 seconds; replaced instances retire permanently within the
Hub process. Queue claim is one-shot: failed/lost ACK is not redelivered. No
secret journal or automatic write recovery exists; Hub restart loses read scopes.

At most 100 Hub read requests / 100 local snapshot reference maps; deadline checks
and lazy expiry eviction bound authority independently of cleanup. Native bodies
<=256 KiB, <=128 known native projects inspected, <=100 returned sessions total,
<=1000 active entries, <=4 pages per project, cursors <=8192 chars; each fetch has
a 3-second timeout, refuses redirects and is tied to the pin abort signal. Selected
reads verify authenticated `/api/info` reports exactly 2.0.22 and unauthenticated
access returns 401. All native operations are **GET**. Over-limit, malformed,
inconsistent-directory, auth/version or network failures return `failed`, never
partial/empty success. Unknown native metadata is not forwarded or treated as
authorization. Local private grant changes are checked during each read; an
already-returned inert snapshot is cached only to its original deadline, not an
immediately revocable write permission.

## Delivery and recovery boundary

No production changes have been applied. Existing daemon startup and reverse
proxy routes are unchanged; this endpoint is under the existing Hub `/api` origin.
Enable only in an authorized isolated deployment after installing/restarting that
deployment's candidate Hub/runtime through its existing launcher. Verify the
explicit capability and HTTP chain, not the CLI version. Roll back by removing
directory gates/profile marker and restoring the prior candidate version; no SQL
migration or business-Session rollback is required. Registries/credentials require
the operator's private backup; process-local read scopes never survive restart.
Project-new writes have a [separate gated contract](session-project-create.md);
this directory alone never authorizes them. Unknown-binding attach and its
ownership protocol remain a **separate next lane**. Upstream-native 2.0.22,
complete UI lifecycle and macOS/Windows acceptance
remain unperformed. Test commands/results: the isolated source harness
[`tests/test-shared-variant/create-chain.test.ts`](../../tests/test-shared-variant/create-chain.test.ts)
together with the CI suite `server/src/session-source-directory-http.test.ts`; no separate
committed directory report.

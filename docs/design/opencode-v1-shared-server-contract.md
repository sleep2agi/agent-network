# OpenCode V1 shared Server contract (#1180)

Review date: 2026-10-14. This is an implementation contract, not a shipped
shared-V1 feature or permission to migrate a running node.

### Exact native feasibility result (#1194)

PR #2721 merged normally at main
`c0e9a387d89f4ec2e47bf21326a6f5ab5f0ad38b`. Actions run `38506584150`
passed both exact V1 packages in non-root, network-disabled Docker, with 11
native checkpoints each. Directory-scoped flat MCP/config, actual synthetic
MCP identity and model routing, two native attach TUIs, persistent restart and
offline scratch history import passed. This is raw native feasibility within
equivalent policies/a common synthetic provider credential; it does not ship
the node bridge or prove separate credential/policy or same-directory identity
isolation. Detailed provenance: `docs/tests/report-test1194-v1-shared-feasibility.txt`.

Both versions returned A's session to a GET carrying B's directory. The bridge
must check the complete binding and returned directory; upstream directory
selection is not session authorization. A directory-scoped toast reached only
A's native event stream in this fixture; retain scoped routing and verify actual
UI/platform behavior before claiming broader notification support.

The implementation/recovery slices below remain pending. Do not repeat this
native gate without a relevant change or unresolved result.

## Reviewed inputs and decision

- Repository main: `0c07c3a17eee7f87e07c523e25312608d0a0a66b`.
- Published auth preservation A: PR #2693, main commit
  `299cd2273033c33026de397c206843440b7ba96c` (CLI preview.174 / Node preview.140).
  `persistAuth` copies and writes back node-local auth; it does not share a Server.
- Existing V2 reuse B: PR #2645, OPEN at review, exact head
  `0c7af87a898e2420f30c3ade510d082ea2fc6ddb`. Reuse its lifecycle/proxy concepts;
  do not merge its entire branch or implement a second V2 lane for this task.
- `opencode-versions.ts` now pins V1 `opencode-ai@1.18.34`, still accepts
  `1.18.1`; V2 is `@opencode/cli@2.0.22`, a different API/security contract.
- Main `runtime.ts` creates a random loopback Server/password, imports a V1
  checkpoint into fresh launch data, then owns process teardown. It has no shared
  Server option. PR #2645 explicitly rejects shared Server with a V1 backend.

Decision: retain existing owned mode and implement an **explicit, opt-in V1
shared mode** behind the same backend seam. First prove exact-package behavior
in Docker. Do not infer V1 support from V2 success, change old defaults, or copy
V2 `mcp.servers`, permissive permission arrays, `/api/session` or prompt queues.

Official [Server](https://dev.opencode.ai/docs/server/) and
[CLI](https://dev.opencode.ai/docs/cli/) docs describe independent serve/attach,
basic authentication and V1-style session endpoints. The
[V2 MCP docs](https://dev.opencode.ai/v2/docs/mcp-servers/) describe another
session metadata contract. These rolling pages guide investigation, not proof
for either accepted V1 binary. npm metadata for both exact V1 packages supplies
the version, platform package and integrity, but no `gitHead`. Retrieved upstream
tag files did not establish correspondence to the existing V1 route layout;
they are not accepted as exact-package compatibility evidence.

## Smallest implementation contract

| Area | Required behavior and acceptance |
| --- | --- |
| Admission | Generation-tagged host entry, explicit accepted package/version, credential-free loopback URL, owned private password file, canonical persistent root. Refuse V2/unknown/mismatched Server; no fallback to a new Server on failure. |
| Ownership | Host supervisor owns the Server and persistent XDG roots. Node bridge owns only its exact attach process, proxy and binding. Node stop/restart/start failure must never kill, delete or restart the shared Server or another node. |
| Health | Authenticate and check health/version; prove native directory-scoped config, MCP readiness and exact session before publishing node readiness. Store Server instance identity separately from local PID health. HTTP health alone is insufficient. |
| Directory | Every instance-scoped request, including session/status/history, events, abort and config readiness, carries the validated canonical directory through the mechanism measured for each exact package. Main `fetchOpenCodeJson` currently adds no directory selector. |
| Session | Binding is network ID + node ID + Server identity + canonical directory + exact session ID. Resume verifies all fields. Missing, foreign, busy or unreadable resume refuses; never pick latest/first, fork or silently recreate it. Initial explicitly new node may create one session. |
| MCP | Bridge retains Hub token; Server receives an ephemeral loopback proxy capability per node. Use V1 flat MCP config and scoped instructions: standalone proxy defaults to `commhub`; borrowed admission uses an unpredictable `commhub_<lease>` name so native disconnect identifies only that lease. Preserve edited files and other MCP entries. Remove only own exact bytes/capability. Never place one node's Hub token in shared global config/env. |
| Workspace overlap | First slice requires a unique canonical directory per node; detect collisions before writing instructions/config. Same directory cannot safely host two identities through a single directory-scoped MCP config. Supporting it needs a separately measured session-aware resolver, not an alias supplied by a prompt. |
| Policy/providers | A common process environment/auth store is not per-node provider or safety isolation. Only equivalent, explicitly selected policies/providers may join the first trust cohort. Different credentials/policies require separate Servers until measured native scoping exists; do not union secrets or widen safe mode. Explicit per-turn model remains required. |
| Turns/notifications | Preserve V1 FIFO, human-turn ownership, timeout/unknown-write handling and exact owned-turn abort. Never use Server-wide abort/dispose to stop a node. Multi-TUI toast scoping must be measured; suppress unsupported global notices rather than inject prompts or notify another node. |
| Trust | Same UID and shared Server password are a cooperative trust cohort, not a security boundary against a malicious peer. Directory/session checks prevent accidental crossover; stronger tenant isolation requires separate process/OS identity. |

## Migration and rollback

1. Finish isolated new-node compatibility and two-node isolation before any
   existing node is considered. Keep owned mode and A unchanged.
2. Original Owner names one node and an idle maintenance window. Record binding,
   exact version, config and process identity privately; retain encrypted data
   backups outside Git. Do not copy credentials or read histories in this review.
3. Capture the existing V1 checkpoint through the existing operator export
   contract. The live export is not a lease: exclude new TUI/network writes in
   the approved window, then prove the final snapshot before switching.
4. Import into a scratch persistent store using the exact native binary; never
   point a second import process at a live shared database without a measured
   supported concurrency protocol. Server start and import belong to its Owner.
   Verify session identity, message IDs/parents and parts using existing checkpoint
   validation. Exit 0 is not sufficient. External file references remain refused.
5. Commit binding atomically only after verification, retaining old config/data
   and checkpoint. Lost history, foreign session or version mismatch stops the
   switch. The older exporter expects a Server child of its bridge; it must not
   be misused for the independently owned shared topology.
6. Roll back the one node to the retained exact owned-mode installation/config.
   After new shared turns, a pre-switch checkpoint loses those turns: first export
   and verify a final checkpoint with an approved shared-aware exporter. If this
   is unavailable, report the gap and retain both stores; do not claim lossless
   rollback. Never stop siblings or replay uncertain Hub tasks.

## Recovery requirements for the implementation PR

| Recovery question | Deliverable / current gap |
| --- | --- |
| Start | Versioned `deploy/node/` host launcher + supervisor template owning persistent roots; no deployed V1 shared launcher in this review. |
| Ports/proxy | Loopback-only port and host registry template in Git; node-local proxy only. No external reverse proxy/tunnel required or configured by this review. |
| Secrets | Owner-managed private Server password file and selected provider source; node Hub tokens remain existing private node sources. Templates contain names/placeholders only. |
| Upgrade | Pin exact main source/package, drain approved trust cohort, back up data, check health/version/bindings and two-node native behavior before readiness. Actual adoption is separate. |
| Rollback | Retained exact binary/config plus verified final checkpoint; schema-compatible data restoration explicitly proved in Docker. |
| Data | Session/database/checkpoints, provider auth and Hub identities come from private encrypted backups or original registration, never from clone. Backup location/retention/restore authority must be filled by actual Owner before canary. |

No disaster-recovery completion is claimed: host launcher, exact native
compatibility and backup restoration remain implementation/acceptance work.

## Ordered slices and conditional effort

1. **Exact V1 feasibility (30–45 min active work):** Docker both accepted versions
   with stub provider, two directories, directory-scoped MCP/config, session
   resume, TUI attach, no built-in permission widening, toast routing and native
   import/rollback behavior. Save exact package integrity and results. A failed
   isolation case is a design decision, not a permission to relax the gate.
2. **Opt-in runtime (45–90 min after slice 1):** versioned registry/launcher,
   V1 HTTP directory seam, scoped proxy/config, explicit ownership health and
   cleanup; test stop A leaves B and Server live, wrong-session/404 refusal,
   edited config preservation, auth/model mismatch, restart with same history.
   Reuse #2645 components only after their generation-specific behavior is split.
3. **Migration/recovery (30–60 min after slice 2):** shared-aware capture,
   scratch import, atomic switch and verified rollback; Docker reconstruction.
   Ordinary exact-head PR/CI/main release follows. Queue/build time is unknown;
   public artifacts only from a freshly verified main ancestor.
4. **One original-node canary (15–30 min after actual Owner window):** verify
   original history/login, exact model, human TUI and original Hub task reply;
   no bulk adoption. Waiting for authority/window and real model response is
   unknown, so these efforts are not a promised end-to-end completion time.

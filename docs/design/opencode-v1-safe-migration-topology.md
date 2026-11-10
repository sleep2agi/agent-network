# Default owned SAFE topology and V1 migration admission (#1246)

Current decision: default owned SAFE nodes are unsupported by the existing
owned-to-borrowed persistent-directory review plan. Keep its refusal. An empty
checkpoint or a successful native import cannot qualify a directory change,
original history recovery or writer exclusion.

This is a cutover admission decision, not a claim that every possible API
invocation throws. The current proposal API has one directory coordinate. A
caller selecting the native temporary path when config omits `workdir` may
satisfy its readonly checks; that proposal still cannot admit default-node
migration. The independently selected requested project and native directory
must become separate explicit inputs before any future commit. Neither may be
inferred from the other or from a checkpoint alone.

The actual wrapper is `openOpenCodeCopresenceRuntime` in runtime.ts. Its
`buildOpencodeChildEnv` allocates fresh external launch roots, redirects SAFE
native cwd to that root's workspace, and gives native fresh HOME/XDG writable
state. The requested user project and private node config/checkpoint remain
separate. Runtime cleanup retires its own launch root when complete process
identity/liveness evidence authorizes it; unknown/live references defer cleanup.
Persistent provider rendering keeps allowlisted identity but drops custom
provider packages/baseURL/headers/plugins. Explicit unsafe mode is not migration
authority and still does not provide a persistent native data root.

## Admission matrix

| Original topology | Current result | Required before a future cutover |
| --- | --- | --- |
| Explicit persistent private directory owned core API, independently matching original config/checkpoint/model/version/cohort | Review proposal only, as qualified by #1245 | All writer exclusion, final source history, supported journal/launcher/final rollback |
| Default SAFE wrapper: user project differs from native per-launch workspace | Refuse current plan/cutover | Explicit two-directory identity and ownership/custody contract preserving the original native directory and user-facing project |
| Custom provider package/baseURL required by the source model | No inferred model equivalence | Original effective provider/policy and target Owner's independently provisioned authorized model must match; never copy unknown credentials/config |
| Unknown source topology, unsafe opt-in, cross-version/cohort, missing/edited/unknown checkpoint or lease | Refuse and retain recovery state | Independent exact Owner inputs and separately qualified support; no fallback/replay/automatic clearing |

Changing checkpoint `info.directory` or binding to the requested project would
change original native identity. Retaining an old temporary pathname without
ownership protection would race original cleanup. Neither is a supported fix.
Before #1238 can offer default-node migration, a separate native-directory
custody/retention design must bind the exact original workspace/inode and source
lifecycle, distinguish requested cwd from native cwd, and preserve selected
model/provider/safety/cohort and future history. It must be implemented and
qualified before an atomic config/intent transaction. It must not depend on a
live-reference scan as a transfer lease or silently suppress credential cleanup.

Original-node execution additionally requires the original Owner's exact node,
idle maintenance window, exclusion of every writer, independently selected
target and matching main software, and encrypted backup/retention/restore
authority. This document gives no new authority to stop or rewrite originals.
An existing checkpoint can be nonfinal; cleanShutdown alone is not exclusion.

## Evidence and reconstruction

`tests/test1246-v1-safe-topology` runs the actual default wrapper in exact pinned
1.18.1/1.18.34 non-root Docker with runtime network disabled. It creates no model
request. It reads only its synthetic empty session/checkpoint and native policy,
checks lifecycle retirement, and compares a later unspawned allocation. This is
not nonempty historical restore, a human TUI race or an actual second native
resume. Both versions passed four actual observations at the exact qualified
source tree; artifacts, earlier REDs and remaining gates are recorded in
[`report-test1246-v1-safe-topology.txt`](../tests/report-test1246-v1-safe-topology.txt).

1. Existing runtime startup remains authoritative; fixture Dockerfile/run.sh
   reproduces this observation, not a new persistent service or CLI migration.
2. Ports are fixture-owned loopback. No proxy/tunnel/production mapping changes.
3. Synthetic private configs and generated fixture-only transport authentication
   are used; original Node/Hub/provider credentials and history are not read.
4. Future executor must verify exact main ancestry and installed capabilities;
   old software ignoring a new custody/journal contract cannot be admitted.
5. No binding changes here. Keep original matching software/config/checkpoints
   and both stores. Future custody/journal and final rollback require their own
   actual fault/recovery evidence; never delete unknown state or replay tasks.
6. Git restores software/templates, not original identities/logins/native
   history or encrypted backup locations/retention/restore permission.

#1238 still needs custody support where applicable and a durable config+intent
journal with matching launcher pending refusal and fault recovery. #1239 still
needs final capture after new shared turns and lossless owned restoration.

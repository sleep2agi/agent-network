# Shared managed-source fork: exact local TEST_ONLY artifact

This extends the existing shared-variant experiment, not stock support or a new
authority protocol. Default stock admission remains exactly `2.0.22`. The only
experimental native version is `2.0.22-anet-test.29040e2`, at the fixed executable
path and SHA256 already defined in `v2-test-build-identity.ts` and
`shared-variant-test-only.md`. There is no semver range, identity overlay, new
flag/signature system, native rebuild, or human-supplied authority field.

## Operator and source prerequisites

- Existing private directory authority must independently allow
  `test_only_shared_variant: true` and `opencode_unsafe_tools: true` for the exact
  registry Server/network/original selection source/directory. Its absence is a
  refusal; a private profile reference alone is not permission.
- Use an actual registered shared child created by the production project worker
  (or another separately proven supported managed source). For this acceptance,
  the source is always created through that worker and actual paired CLI, then
  materialized with one prompt to a container-local synthetic provider and fully
  drained. Do not manufacture ownership journals, launch-health records, source
  leases or fake native Sessions.
- Existing source-fork gates and capability pins are independent of project-new
  and attach. The isolated Hub requires `COMMHUB_SOURCE_FORK_PREVIEW=1`. The
  existing fixture-process production worker uses `forkEnabled: true`; its daemon
  must declare both `source_fork_transport` and `source_node_delivery` with the
  existing contract constants. It is not a separate host-supervisor service.
  For actual host-supervisor CLI deployment, use the existing private config/gate
  contract in `docs/runbooks/session-source-transport.md`; this test does not
  deploy a host service or enable a business node.

The reader checks its own frozen network/daemon scope and source alias against
the existing private child-workdir registry, uniquely owned source profile,
endpoint and real live shared bridge/server health. For the patch only, it also
binds the profile's authority HOME/daemon directory to the reader's independent
local inputs, then re-reads the existing operator policy and shared-server
registry/password. It verifies the selected Session and canonical directory,
same-UID loopback listener PID/start ticks/socket, exact executable path and
double-hashed allowlisted ELF. Later checks use only reader-held initial process
evidence, never profile-provided proofs, and reject any incarnation/file change.
Fresh complete selected-model variants and Session scope are checked around each
probe, with a five-second catalog budget. Malformed explicit models never fall
back to a default. The trust boundary remains private local operator files, not
protection against malicious same-UID code or global exclusion of external TUI
writers.

## Human API and truthful delivery

The existing managed-source fork API is unchanged: POST
`/api/node-session-control/source` with the current human credential and
exactly `network_id`, `source_node_id`, `session_id`, `mode: "fork_independent"`,
`child_name`, `intent_id`. Here `session_id` is the legitimate managed source's
native Session (unlike directory attach's opaque `oses_*` choice). Do not add a
daemon, URL/path/PID/hash/model/token or authority override. The Hub infers the
daemon from existing authoritative management journals and retains current
human/network/source/create permissions and daemon token/instance pins.

The process-local lease carries the observed real `api_version`. The wire parser
admits only the stock literal and exact experimental literal; parsing is not
authority to access a server. Execute still re-probes the same confirmed lease
and uses the existing one-claim journal and native fork adapter. A single fork
POST is never retried after an uncertain response or ACK. Delivery carries that
same version and a sanitized reference to the already verified authority into
the private child profile and exact-resume launcher. The child independently
re-reads authority/registry and native identity, then reports its real variant
capability and consumes real Hub config SSE/ACK. No startup model setter is
introduced. Source Session and source bridge are never adopted or replaced.

Same intent only recovers its existing receipt. Legacy/unknown execution,
delivery or namespace claims never authorize remint, relaunch, refork, automatic
cleanup or another intent to recover uncertainty. Grant consumption, lease
expiry, busy refusals and namespace conflict behavior are unchanged.

## Reproduce in Docker, layered

From `/tmp/opencode/anet-shared-fork-final`:

```sh
sg docker -c 'sh tests/test-shared-fork/run.sh tests/test-shared-fork/admission.test.ts agent-node/src/runtime/opencode-copresence/v2-test-build-identity.test.ts agent-node/src/runtime/opencode-copresence/v2-model-selection.test.ts'
# Only after the admission/identity layer passes:
sg docker -c 'sh tests/test-shared-fork/run.sh tests/test-shared-fork/chain.test.ts'
```

The suite has its own Dockerfile, pinned cached base/dependencies, read-only exact
ELF, isolated DB/HOME/private policy and `--network none`. No installation or
external provider is needed. Cleanup uses the worker's actual child handles;
the fork-child-only stop check uses a private fixture control socket to signal
the CLI wrapper's own spawned handle, not an arbitrary PID or process group.
The full chain additionally verifies native 200 exactly once, real registration
ACK, materialized fork context, high/clear on the same fork child, no duplicate
fork/mint/launch, unchanged source context/server PID, and source bridge survival.

## Persistent UI handoff / recovery boundaries

The old `9ae` UI container and its worktree are frozen and must not be changed or
stopped during client acceptance. This change is first delivered as a reviewable
local SHA plus Docker evidence. A new persistent harness must archive that exact
reviewed SHA and use its own unique container/DB/HOME/grants. Do not transplant
private files or tokens from the old run or hot-patch the running container.

All startup/test scripts are in `tests/test-shared-fork/`; existing persistent UI
setup remains in `tests/test-shared-ui-ready/`. Ports, loopback proxy and netns
access remain as documented there: `--network none` does not publish host ports.
Credentials are disposable synthetic values generated in the isolated run and
stay in private `/state` files, never reports or Git. The exact ELF, cached base
and existing read-only web export are explicitly named prerequisites, not a
clean-machine artifact-download or production backup promise. DB/Sessions are
disposable acceptance state. Version change/rollback means a new unique pinned
run after authorization, not adoption or replay of uncertain state. No production
service, proxy, tunnel, credential source or data backup is changed here.

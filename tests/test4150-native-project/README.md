# Linux project-new acceptance with a real independent patched native build

## Separate existing-Session attach acceptance

For the configure-once **delegated-policy** check only (one empty Session, not
the previous full manual acceptance), run:

```sh
sg docker -c 'TEST4150_NATIVE_ATTACH=1 TEST4150_NATIVE_ATTACH_DERIVED=1 sh tests/test4150-native-project/run.sh'
```

This writes only an explicit local directory delegation, not a per-Session grant,
then derives the finite exact grant through the actual daemon's native GET/OS
checks. Fixture-only Session create 1; provider/prompt calls 0; attach and actual
child native writes 0. Prior manual/new/fork native suites are not run by this
mode. The runner refuses derived mode without the explicit attach selector.
Evidence: [`report-test4150-delegated-attach.txt`](../../docs/tests/report-test4150-delegated-attach.txt).

The earlier full manual mode remains available (not rerun for delegated delivery):

```sh
sg docker -c 'TEST4150_NATIVE_ATTACH=1 sh tests/test4150-native-project/run.sh'
```

This selects **only** `server/src/session-project-attach-native.test.ts`, not the
project-new/fork acceptance tests below. Its independent offline sandbox prepares
two existing Sessions (empty + real native prompt/drain materialized context).
Setup create/prompt/wait and local provider calls are counted separately. The
actual attach window and both actual CLI child audits must have **zero native
non-GET writes**. It checks exact resume/real Hub registration, common-claim
occupied refusal with renewed finite operator grants, duplicate intent/no remint,
unchanged Session info/context/Server PID and child-only stop preserving Sessions.

Operator grant and public five-field contract:
[`session-existing-attach.md`](../../docs/runbooks/session-existing-attach.md).
Evidence: [`report-test4150-existing-session-attach.txt`](../../docs/tests/report-test4150-existing-session-attach.txt).
Same exact SHA and disposable identity overlay; NOT stock, macOS/Windows, native
TUI or business native-SSE acceptance. Gates default OFF. No production enablement.

## Existing project-new acceptance

Run from the repository root, **in a background harness command**:

```sh
sg docker -c 'sh tests/test4150-native-project/run.sh'
```

Uses the existing offline `anet-4150-git-test:local` image, `--network none`, no
downloads/install, only sandbox loopback. Read-only native input:

```text
/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode
SHA256 1cf5fcccf345438316db82d4c63c5df5f5010cc94a8465e1a119f9639c53c786
identity 2.0.22-anet-test.29040e2
base source 29040e240ecf238c84ab63a7f9e2420e4c3479d6
```

This is a **real ELF independently patched TEST-ONLY build, not stock 2.0.22**.
No native source rebuild/edit, variant re-acceptance, model/variant write test,
paid/external call, host process activation, production secret, signing or upload.
The default project-new lane sends no prompt. The opt-in fork lane below uses
one real native prompt with a deterministic container-loopback provider only.
The artifact is externally supplied and deliberately not committed to Git. An
identical artifact must be restored from the authorized build/evidence source to
reproduce; Git alone does not reconstruct it. Unknown/different bytes are refused.

## Exact test identity adaptation (not shipped)

`prepare.ts` verifies the read-only input SHA256 and actual `--version` before
launch. Only the disposable `/work` copy is changed, never candidate files or
native bytes. It replaces exact stock-version literals in the existing gates
with the exact build identity and preserves this exact suffix during CLI version
parsing. It stages the unchanged ELF with a truthful **private local build
manifest** named `@anet-test-only/opencode`, not a fake published `@opencode/cli`.
The CLI manifest/path/ownership attestation remains enabled and runtime file
attestation additionally requires the supplied exact SHA. No accepted semver
range, production environment bypass, rewritten native API response or synthetic
OpenCode executable is introduced. Base 2.0.22 API contract is retained.

Affected test-copy gates: both `opencode-versions.ts` tables, CLI exact source
resume checks, directory/create `/api/info`, source-resume profile/health/runtime
checks and `opencode-acp/binary.ts` package/version/file attestation.
The launcher's `opencode-package-binary.ts` numeric-only exact-version guard is
replaced with equality to this **single identity**, not a prerelease semver range.
The runner first asserts the untouched product table rejects this custom identity.
Product accepted versions remain `["2.0.22"]`; this test does **not** establish that a
shipping binary accepts this custom build, or authorize enabling any live gate.

## Chain and observation

`server/src/session-project-create-native.test.ts` is skipped without this runner.
It spawns the real native Server with synthetic provider configuration, creates
an empty project (no seed native Session), loads its default/catalog, then uses
actual human Hub HTTP directory/project intent, daemon consumer, one native empty
Session POST, actual anet CLI and built paired agent-node CLI, real native SSE
and real Hub report_status/registration ACK. It never substitutes a fake HTTP
handler for a native endpoint. A transparent streaming observer forwards the raw
HTTP response/status/headers unchanged, counting POST paths and SSE bytes; it
does not rewrite `/api/info` or native pid. No authorization header is logged.

Native SSE is a separately identified read-only **acceptance observer** subscribing
to `/api/event` before create and asserting its real `session.created` Session ID.
The idle child runtime polls native state and opens **Hub SSE**, not native SSE.
Do not claim this test proves native event-driven child/task delivery. It also
reads the native empty Session context and refreshes directory through the real
nonempty cursor page followed by the empty page whose cursor fields are null.

Synthetic provider responds 503 and counts requests; this no-prompt acceptance
requires its call count to stay zero. Model selection/catalog is not proof of
provider authentication/invocation. Child stop is handle-only; tests verify the
real Server and new native Session survive. No existing business/source bridge
is imported into this sandbox. Passing does not prove attach ownership, existing
source-fork lifecycle, native TUI paint/readiness, Mac/Windows or business task
delivery. Registration remains a historical receipt, not ongoing online health.

## Materialized real managed-source fork lane

```sh
sg docker -c 'TEST4150_NATIVE_FORK=1 sh tests/test4150-native-project/run.sh'
```

New disposable sandbox/intent, not recovery/replay of prior unknown writes.
Keeps the real project-new CLI child as managed source, arms a separate real
native event observer, admits `/prompt` and waits for native `/wait` plus
`session.execution.succeeded`. Only after GET context proves nonempty `msg_*`
history and the local reply does it admit fork via existing human HTTP/daemon.
The synthetic OpenAI-compatible provider serves deterministic streaming replies
on loopback, with counted/bounded requests, no external network or paid service.
Provider replies are fixtures; native context/events/registration are REAL.

Fork targets the actual native listener for OS process evidence. Test-only fetch
instrumentation records HTTP fork status and fixed error enums, never arbitrary
body/stderr. Missing native Session model uses the product's existing read-only
catalog-default hint mechanism; no Session/model mutation or first-model guess.
Tests verify copied context, exact child resume/registration, source health/context
and Server PID preservation, same-intent no refork/mint/launch, and child-only stop.
An attach-mode 400 is ONLY existing transport refusal, not ownership-safe attach.
Neither a passing fork lane nor its observer proves native TUI readiness, stock
identity compatibility, external model quality, full child native-SSE task flow,
cross-platform support, restart/adoption or credential-rotation lifecycle.

# V1 safe-default ACP session atomic gate — test only

This independent gate calls the production `openOpencodeRuntime` using the real
OpenCode 1.18.34 binary, without `unsafeTools`, a provider fixture, model keys or
any prompt. It checks initialize/session creation, persisted identity, live-child
policy/environment and process/launch-root cleanup. After the positive gate, a
new process uses a deliberately wrong expected session identity; only that exact
assertion failure after real initialization is accepted as the negative control.

Policy checks establish configuration, **not tool enforcement**. This is neither
native installed-app acceptance nor Hub task delivery, authenticated vendor/model
communication, session restart/recovery or V2 TUI acceptance. Those later layers
remain separate. There is no production deployment, service, port mapping, key
source, persisted data or upgrade/rollback change in this test-only suite.

From an exact source checkout, first build the repository's pinned dependency
fixture (Bun digest, OpenCode version, agent-node lockfile):

```sh
sg docker -c 'docker build -f tests/test894-v1-runtime/Dockerfile --build-arg SOURCE_COMMIT=FULL_40_SHA -t anet-v1-deps:test .'
sg docker -c 'docker build -f tests/test894-v1-acp-session/Dockerfile --build-arg RUNTIME_IMAGE=anet-v1-deps:test --build-arg SOURCE_COMMIT=FULL_40_SHA -t anet-v1-acp:test .'
sg docker -c 'docker run --rm --network none -e EXPECTED_SOURCE_COMMIT=FULL_40_SHA anet-v1-acp:test'
```

Use the actual 40-character source SHA, not the literal placeholder. Record both
image IDs. An existing exact dependency image may be reused offline, but record
that fact; the child Dockerfile compares its dependency lockfile and recopies
current runtime source. A cached run is not evidence that clean dependency
acquisition currently works. No host source, credentials, home or Docker socket
is mounted. The container runs as `bun`, and its temporary directories disappear
after native process exit. A 60-second per-probe deadline bounds failures.

## Next layer: model transport against an isolated TLS fixture

After the session atomic gate passes, run the same image with
`bash /fixture-acp/run-model.sh` as its command (same source SHA and
`--network none`). CI runs this as a later step, never after a failed session gate.

This layer retains the production safe-mode policy and built-in `openai`
provider. A loopback CONNECT endpoint accepts ONLY `api.openai.com:443` and
`models.opencode.ai:443`, never forwards traffic, and serves an explicitly tiny
offline model catalog and synthetic Responses stream. It generates an ephemeral
certificate for those names; only this container trusts it. TLS verification is
not disabled. ACP's internal localhost HTTP traffic bypasses the fixture via
`NO_PROXY`; neither production proxy nor host trust stores are changed.

An unauthenticated fixture request must receive HTTP401 before ACP starts. A
synthetic node-local credential then exercises the real runtime/provider request,
exact host/path/model and ACP response consumption. A new process deliberately
uses a wrong expected model to check the observer after a successful response.
The known fixture reply is not present in the user prompt. Certificate, credential,
proxy, ACP child and launch roots are disposable; no real vendor key is used.
`TEST_DEBUG_RUNTIME=1` optionally adds upstream debug logging for diagnostics,
but is not used in the acceptance run. Each probe has a 90-second deadline.

This proves controlled transport plumbing, NOT live vendor authentication/model
availability, model reasoning, tool enforcement, Hub delivery, native package
acceptance or release readiness. The older session-only result stays independent.

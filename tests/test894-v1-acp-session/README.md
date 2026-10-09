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

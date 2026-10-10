# V1 runtime compatibility boundary (#894)

Docker-only, non-root test of the actual `opencode-ai@1.18.34` package through
the production ANet co-presence runtime entry. Only the model provider is a
loopback fixture. Tests environment, session/auth rejection, actual attached
TUI, a response-only marker, precise model routing, and close cleanup. A second
run deliberately expects the wrong provider model and must fail at that exact
assertion after the real reply/TUI prerequisites pass.

The fixture explicitly opts into `unsafeTools` to permit its custom provider;
it does **not** prove the V1 safe preset, a real CommHub, packaged desktop IPC,
the create-node launcher acknowledgment, or external release acceptance.

From the repository root:

```sh
sg docker -c 'docker build --build-arg SOURCE_COMMIT=<full-tested-SHA> -f tests/test894-v1-runtime/Dockerfile -t anet894-v1:local .'
sg docker -c 'docker run --name anet894-v1-proof --network none -e EXPECTED_SOURCE_COMMIT=<full-tested-SHA> anet894-v1:local'
```

Runtime network is disabled except loopback; no host HOME, credentials, or
tmux sockets are mounted. Preserve logs before removing the named container.
The source label must match the tested checkout; when developing uncommitted
fixtures, report that delta explicitly rather than calling it a clean commit.
The QA matrix supplies the exact checkout SHA and preserves failure artifacts.

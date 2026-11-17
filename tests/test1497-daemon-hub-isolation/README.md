# PR #3627: real daemon/CLI Hub isolation E2E

```sh
sg docker -c 'docker build -f tests/test1497-daemon-hub-isolation/Dockerfile -t anet3627-hub-isolation .'
sg docker -c 'docker run --rm --network none --init anet3627-hub-isolation'
```

Test-only supplement to #3627. It changes no product source, package version or
HOME behavior. `daemonChildCliEnv()` and the removed writer are the PR author's
implementation, not replaced by the earlier parallel `--hub` proposal.

The image downloads the **actual published CLI .241** archive, checks SHA256
before extraction, and tests it with the PR's source-built runtime, real local
Hub and actual Claude SDK. Checked-in lockfiles supply dependencies. Only model
HTTP is stubbed with fake keys. Container networking is disabled while testing;
loopback remains available. No real credentials/global packages/production used.

Three complete fresh flows: user's config contains a different Hub plus fake
cloud token/network/extra fields; config is missing; config is invalid JSON.
Crucially, these are placed at the daemon/child's **actual HOME**, after temporary
local credentials bootstrap `daemon init`, before `daemon start`. We do not move
daemon HOME to a separate private directory to mask the writer bug.

Each case requires child registration in the daemon Hub, its persisted per-node
profile Hub, a dispatched task, actual SDK response originating in the model
HTTP fixture, then product stop/Hub-accepted ACK. User config bytes are checked
after registration, reply and stop; missing must stay absent. The unrelated
cloud sentinel is retained, but is not the main proof. Existing180s reply and
15s Windows stop assertions are unchanged; timeout values are not increased.

`RFC044_CLOUD_CONFIG_CASE` enables these extra cases in the existing SDK smoke.
With no variable, its previous bootstrap-mode assertions/flow remain in place.
The dedicated suite also runs the PR's unit tests before these E2Es. The Linux
CI smoke job builds/runs it and includes its directory in PR path triggers.

This proves Linux process behavior, not native Windows/macOS App installation,
signed package delivery, GUI/IPC or account-backed login. Release/pin/activation
remains with the owner. No service, port, reverse proxy, secrets, upgrade or
rollback procedures change in this test-only patch. Previously overwritten
cloud credentials still require backup or explicit user reconfiguration, not
reconstruction from this test or Git.

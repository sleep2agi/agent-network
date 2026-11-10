# CommHub 0.9.0-preview.120

Release candidate for Issue #2544 / Hub #539. Not publication or deployment evidence.

## Included changes

PR #2551 adds strict OpenCode V2 create flags and daemon-bound launch proof.
The nullable `launch_verified_at` column distinguishes registration from an
explicit launch check; failure clears proof and late success cannot revive it.
Existing V1 creation and old token authentication remain compatible.

## Install

After publication: `npm install -g @sleep2agi/commhub-server@0.9.0-preview.120`.
Use disposable Docker containers for test installations.

## Upgrade

Back up the Hub database using the existing deployment procedure before
activating this exact version. Verify the running version, health and
authenticated create-request readback. Install the matching runtime
2.5.0-preview.128 and CLI 2.3.0-preview.162 only after each is published.
Installing a package does not update the running Hub or daemon automatically.

The additive nullable column is not backfilled. Old software can ignore it;
request history is data restored from the existing encrypted database backup,
not from Git. No new service, port, proxy, tunnel or secret source is introduced.
See [the runtime runbook](../runbooks/opencode-tui-copresence.md) and
[Hub deployment](../../deploy/hub/README.md) for startup and version activation.

## Rollback

Drain/reconcile pending V2 create/start requests and stop new V2 nodes before
returning to Hub .119 with the previous matched CLI/runtime. Preserve request
history, nullable evidence and node bindings; do not fabricate launch proof.
Software rollback is not data restoration or a V2-to-V1 session conversion.

## Validation and publication

PR #2551 passed 163/163 checks before main merge
ac38e6bb54d2bfb4caa0fc749d9ec8f6e2f582a6. Current-client/native lifecycle
evidence is recorded in Issue #2544; version and artifact gates remain separate.
Publish Hub, runtime, then CLI from a verified full40 main SHA after this
candidate merges. Rebuild artifacts on main; keep latest unchanged. No
production rollout, native WebView or whole-machine recovery drill is claimed.

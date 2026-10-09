# agent-node 2.5.0-preview.128

Release candidate for Issue #2544 / Hub #539; not publication evidence.

## Included changes

The merged V2 delivery slices add deterministic CommHub tool-registry readiness,
bounded identity-aware launch cleanup and remote create/start completion.
The daemon initializes private runtime bindings before writing node config,
then checks the exact bridge/serve/TUI process generation before confirming
launch. Startup failure remains failure even after registration. No automatic
repair of arbitrary legacy bindings or cross-generation migration is added.

V2 remains an explicitly authorized unsafe-tools preview, not a safe sandbox.
Fixed @opencode/cli 2.0.22 is installed in an independent trusted prefix;
do not overwrite the existing V1 installation or silently inherit consent.

## Install

After publication: `npm install -g @sleep2agi/agent-node@2.5.0-preview.128`.
The exact matching CLI is agent-network 2.3.0-preview.162. Wait for that package
and Hub 0.9.0-preview.120 before enabling the remote V2 creation path.

## Upgrade

Activate and verify Hub .120 first, then install the published exact CLI/runtime
pair through the existing deployment procedure. Update the intended daemon's
actual CLI pin/path and restart it only in an authorized maintenance window.
Check capabilities and request-bound launch proof, then a real task receipt and
same-TUI answer; a one-time launch receipt is not continuous health monitoring.
Do not mass-restart nodes or change their models as part of package installation.

## Rollback and state

Stop new V2 nodes and reconcile pending requests before restoring runtime .127
and CLI .161. Preserve private node config, external HOME runtime bindings and
Hub data from encrypted backups; source clone alone does not restore them.
Use [the runtime runbook](../runbooks/opencode-tui-copresence.md); launch evidence
is regenerated, not restored as proof. No new permanent port, launcher, proxy,
tunnel or secret source is introduced. V2 sessions are not downgraded to V1.

## Validation and publication

Backend PRs #2545, #2549, #2550 and #2551 are on main. The last passed 163/163
checks; real non-root Linux current-client create/task/stop/restart and denied
restart tests passed separately. Native WebView, macOS/Windows and model-change
acceptance remain separate. After this version candidate passes and merges,
publish from a fresh exact main-SHA build, after Hub and before CLI. Verify
registry and tarball behavior; keep latest unchanged. No production upgrade yet.

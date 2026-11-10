# agent-node 2.5.0-preview.130

Managed Codex account operations for #906. Candidate notes are not publication
or deployment evidence.

## Install

After publication: `npm install -g @sleep2agi/agent-node@2.5.0-preview.130`.
Pair with CLI 2.3.0-preview.164 and Hub 0.9.0-preview.122 for managed login.

## Upgrade

Verify the upgraded Hub first, install the exact CLI/runtime pair privately,
retain the previous pair, then switch the selected daemon's actual startup path
in its authorized idle window. Verify its running version, original node ID,
SSE connection and account-interface readback. Do not change business models,
copy another node's auth.json, or mass-restart nodes during installation.

## Rollback and recovery

Reconcile login/application journals before restoring .129/.163. Preserve the
private account vault, Provider store, current node credentials and configuration
in protected backups. Credentials may rotate after launch: never overwrite live
node credentials with an old vault copy or duplicate one refresh chain across
nodes. Software rollback alone does not undo custody or node state. An account
holder must complete fresh sign-in when required; no credential sharing.
No new service port, proxy or tunnel is introduced. Startup/activation/rollback
and private-state sources are described in the
[CLI release notes](release-v2.3.0-preview.164.md) and
[managed-account design](../design/906-daemon-provider-management.md).

## Evidence and publication

Reuse the [core report](report-test906-managed-login-core.txt): real local Codex,
synthetic accounts and container-local routing, not real OAuth or remote model
access. Publish a fresh exact full40 main-SHA build through release.yml, after
Hub and before CLI; verify downloadable bytes. Keep latest unchanged.

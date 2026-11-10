# ANet managed Codex accounts — release candidate

Candidate pair: CLI 2.3.0-preview.164 / runtime 2.5.0-preview.130;
Hub account interface: 0.9.0-preview.122. Not published or deployed yet.

## Included changes

Daemon-scoped managed ChatGPT sign-in, private account custody, explicit account
and model binding, and applying a selection to one managed Codex TUI node while
preserving its thread. API-key Provider management remains a separate path.
An account may own one active node refresh chain at a time; it is parked after
verified stop before switching away. Login is completed by the account holder.
No bulk restart, credential import from unrelated nodes or autonomous repair.

## Install

Only after the exact main-SHA packages have been published and download verified:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.164 @sleep2agi/agent-node@2.5.0-preview.130
```

## Upgrade

Activate Hub 0.9.0-preview.122 first. Install the exact CLI/runtime pair privately
using the existing deployment procedure, keep the prior pair, and update only
the selected daemon's actual executable path. Restart that daemon in its approved
idle window and verify the running version plus account-interface readback.
Installing a package alone does not update an existing daemon process. Desktop
installer pins must change only after both artifacts are downloadable and their
digests are known. Old .163/.129/.121 supports API-key management, not this login
protocol; a timeout is not by itself evidence of an old version.

## Rollback and recovery

Finish or cancel pending login ceremonies and reconcile application journals
before rollback. Retain encrypted backups of the daemon Provider store, private
managed-account vault, current node auth/config and application journals. Current
node credentials may have rotated after startup; do not restore a stale vault
copy over a live node or reuse one refresh chain on multiple nodes. Software
rollback to .163/.129/.121 does not undo configuration or account custody. A
recovery_required receipt requires inspection, not blind replay.

The [design](../design/906-daemon-provider-management.md) records startup,
credential custody, persistence, recovery and rollback. No new service port,
proxy or tunnel is introduced. Git recreates software; private account and Hub
data require existing secure backups or fresh sign-in. No empty-machine
recovery or real-user OAuth acceptance is claimed by this candidate.

## Evidence and release order

[Core report](report-test906-managed-login-core.txt): Docker native Codex
Hub-to-daemon-to-CLI same-thread API-key / managed A / managed B / API-key passed.
The accounts and HTTPS routing peer are synthetic; this proves local native
integration, not remote model access, OAuth issuance or entitlement.

Merge first; rebuild each package from the exact full40 main SHA. Publish Hub,
runtime, then CLI via release.yml and verify downloadable bytes. Do not publish
feature artifacts or move latest. Client managed-login UI is tracked separately
in app PR836; candidate success is not a release announcement.

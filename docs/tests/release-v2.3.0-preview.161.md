# ANet CLI 2.3.0-preview.161

Release candidate for core Issue #2539 / Hub #819. Not proof of publication,
production deployment or client UI delivery.

## Included changes

PR #2541 adds --fork-recovery-request-id to the existing confirmed recovery
launcher and records requestId on newly created fork mappings. Existing unkeyed
history stays readable. The ID is correlation, not authorization or confirmation.
The existing --fork-on-resume-failure and explicit --yes/interactive confirmation
remain required; no automatic fork or rollout rewrite is added.

The exact CLI/runtime pair advances to .161 / agent-node .127, carrying the
finite-launch completion and Hub/daemon confirmation/result bridge from
PR #2540 / #2542. Hub .119 must be active before enabling that bridge.

## Install

After all three compatible packages have been published:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.161 @sleep2agi/agent-node@2.5.0-preview.127
```

## Upgrade

First activate and verify Hub 0.9.0-preview.119 through the existing deployment
runbook, then install the exact pair above. Update the intended daemon's actual
CLI pin with its existing path/SHA procedure and restart only as authorized.
Confirm the installed CLI version, help flag and negotiated daemon capability;
installing npm packages alone does not update an already-running daemon.

The current PINNED_SERVER_VERSION is a compatibility floor, not the default Hub
version: anet hub start resolves the registry channel or an explicit version.
It is deliberately unchanged here; the new bridge requires a compatible running
Hub independently of that floor. No new ports, launchers, proxies, tunnels or
secret sources are introduced. Client fork controls remain a separate delivery.

## Rollback

Reconcile/drain confirmed requests first, then use CLI .160 / runtime .126.
Preserve old/new thread mappings, read-only snapshots, original rollouts and Hub
receipts. Downgrading software does not undo a fork or recover production data;
those require existing backups. See [the transport runbook](../codex-fork-transport.md).

## Validation and publication

PR #2541 and #2542 passed their 157-check CI gates, including real Codex fork
recovery. Source evidence is distinct from this version candidate and its
artifact validation. Publish Hub, runtime, then CLI from a verified full
40-character main SHA after version changes merge; never reuse branch artifacts.
Keep latest unchanged and verify registry metadata plus actual tarball behavior
before marking the parent delivery complete.

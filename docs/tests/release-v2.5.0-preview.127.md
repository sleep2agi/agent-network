# agent-node 2.5.0-preview.127

Release candidate for core Issue #2539 / Hub #819. Not yet publication evidence.

## Included changes

Also included since .126: PR #2511 accepts a sticky group-writable adoption
workdir under its existing ownership checks (#747). It does not create a
daemon binding for an old node or authorize adoption without an explicit action.

PR #2540 waits for the finite Codex co-presence CLI launcher to finish rather
than acknowledging success when a PID exists. Negotiated progress keeps long
launches from being reaped as stale; same-daemon replay avoids a second launch.
This is not durable exactly-once execution across daemon restarts.

PR #2542 adds the confirmed fork request bridge for daemon-created Codex
co-presence nodes, verified pinned-CLI help capabilities and request-specific
result projection. The CLI pin is revalidated on capability refresh and recovery
execution. Background capability probing does not block heartbeats. No support
claim is made until the first successful probe. Missing mapping means unknown,
not no fork; fork facts survive a later startup failure. Adopted nodes are not
silently routed through this path.

## Install

After the compatible Hub is published and activated:

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.127
```

The matching CLI is agent-network 2.3.0-preview.161; wait for its publication
before installing that pair. Publish runtime before CLI so the exact pair exists.

## Upgrade

First upgrade the Hub to 0.9.0-preview.119 and verify its authenticated schema.
Install the exact runtime and matching CLI through the existing deployment
procedure. Safely update the daemon's actual pinned CLI path/SHA using its
existing pin procedure, then restart only the intended idle daemon/node as
authorized. Installing packages alone does not update a running daemon or pin.
Verify advertised capability and a request-specific receipt; neither proves
continuous node health. Do not automatically fork, mass-restart or change models.

## Rollback and state

Reconcile/drain confirmed recovery requests before downgrading to runtime .126
and CLI .160. Retain original rollouts, read-only snapshots, mapping history and
Hub receipts; rollback does not undo a fork. Use existing state/secret backups,
not npm, to recover those files. No port, tunnel, launcher or secret source is
changed by this release. See [the transport runbook](../codex-fork-transport.md).

## Validation

PR #2542 passed all 157 CI checks before main merge 9af6bcc7c7e62e2462f02a32f358836db8d11787.
The focused Docker chain passed 105 tests / 589 assertions; see
[report-test822-fork-transport.txt](report-test822-fork-transport.txt).
Version and artifact gates are additional requirements. Publish only preview
from a verified exact main SHA, not a branch artifact; keep latest unchanged.

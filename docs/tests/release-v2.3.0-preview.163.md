# ANet CLI 2.3.0-preview.163

Release candidate for Hub #906. Not published or deployed yet.

## Included changes

Daemon-scoped Provider inventory and private API-key configuration, plus explicit
application to one existing managed Codex TUI co-presence node. Application
preserves the thread and verifies the selected Provider/model after restarting
only that node. Official ChatGPT account switching and Hub-level Providers are
not included in this first slice. No automatic repair or bulk restart is added.

## Install

After the exact packages are published:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.163 @sleep2agi/agent-node@2.5.0-preview.129
```

## Upgrade

Activate and verify Hub 0.9.0-preview.121 first, then install this exact pair
using the existing deployment procedure. Update the intended daemon's actual
CLI path/pin and restart that daemon only in an authorized maintenance window.
Installing packages does not change a running process. The client must support
the #906 application protocol; old daemons do not accept these requests.
PINNED_SERVER_VERSION remains the already-published compatibility floor, not
the version required for this new protocol.

## Rollback and recovery

Reconcile pending Provider operations before returning to CLI .162 / runtime
.128. Software rollback does not undo applied private configuration. Preserve
the daemon Provider store, node configuration and any private application journal
through existing encrypted backups. A recovery_required receipt requires an
operator to inspect the retained journal; do not automatically replay the request
or copy another node's auth.json.

Startup, actual version activation, secret sources and recovery are documented
in [the #906 design](../design/906-daemon-provider-management.md) and
[the runtime runbook](../runbooks/opencode-tui-copresence.md). No new service,
port, proxy or tunnel is introduced. Git restores software, not private keys or
Hub/node state. No whole-machine recovery drill is claimed.

## Evidence and publication

The native Linux source test passed the Hub-to-daemon-to-CLI application chain,
same-thread continuation and two local synthetic HTTPS Responses turns. Client
browser checks are separate, not native installer acceptance. See
[the exact test report](report-test906-daemon-provider-management.txt).
After main merge, rebuild from the full40 main SHA and publish Hub, runtime,
then CLI through release.yml. Keep latest unchanged. Branch artifacts are test-only.

# ANet existing Codex discovery — release candidate

Candidate pair: CLI 2.3.0-preview.165 / runtime 2.5.0-preview.131;
Hub discovery interface: 0.9.0-preview.123. Not published or deployed yet.

## Included changes

Read existing Codex metadata from the selected Daemon workspace and its local
child-workdir registry. Locally discovered unbound nodes remain read-only;
discovery does not adopt, import credentials, change permissions or restart nodes.
Private legacy layouts are readable without weakening the application resolver.
Old clients receive the original projection unless opting in to discovery.
Managed account login and API-key management retain their separate existing paths.

## Install

Only after exact main-SHA publication and download digest verification:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.165 @sleep2agi/agent-node@2.5.0-preview.131
```

Selected Daemons should use the existing private package-pair deployment process,
not mutate a global installation. When npm propagation lags, use only the same
formal GitHub release tarball after verifying its published digest; do not
republish a version or install PR artifacts.

## Upgrade

Activate Hub 0.9.0-preview.123 first. Install the private .165/.131 pair and retain
the old pair. Switch only the selected Daemon's actual launch path in an idle
window; verify running versions, original identity, SSE and opt-in inventory.
Do not restart or change business nodes. The client discovery section is supplied
by app PR843; a client alone cannot add discovery to an old Daemon or Hub.

## Rollback and recovery

No new ports, proxies, migrations or secret source. Start/activate/verify/rollback
using the existing [Daemon deployment procedure](../../docs-site/docs/deploy/daemon.md).
Preserve original config, registry, private Provider/account state and any pending
application/login journals. Software rollback does not restore account/data state;
secure backups or fresh owner sign-in are still required. No credential copying
or complete empty-machine recovery is claimed.

## Evidence

[Discovery core report](report-test906-existing-codex-discovery.txt): compiled CLI
3/3, authenticated HTTP chain 1/1; no OAuth or real model entitlement claim.
The [discovery contract](../daemon-existing-codex-discovery.md) describes rollout.
Merge first and rebuild all formal packages from the exact full40 main SHA via
release.yml. Publish Hub, runtime, then CLI; verify bytes before client pinning.
Candidate success is not a publication announcement. Keep latest unchanged.

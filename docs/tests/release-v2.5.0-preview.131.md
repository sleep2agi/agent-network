# agent-node 2.5.0-preview.131

Candidate: negotiate existing Codex discovery with the Hub and paired CLI.
Not published or deployed yet. Unbound nodes never gain mutation authority.

## Install

After publication: `npm install -g @sleep2agi/agent-node@2.5.0-preview.131`.
Pair with CLI 2.3.0-preview.165 and Hub 0.9.0-preview.123 for discovery.

## Upgrade

Upgrade the Hub first, then only the selected Daemon's private paired installation.
Preserve original identity/config and previous software. Verify actual running
versions and discovery receipt; do not restart old business nodes.

## Rollback and recovery

Discovery changes no private state. Retain account/Provider stores and journals
when restoring .130/.164; software rollback does not restore data or credentials.
No new port, proxy or secret source. Existing lifecycle, backup and rollback
procedure is linked from the [CLI candidate notes](release-v2.3.0-preview.165.md).

## Evidence and publication

[Core report](report-test906-existing-codex-discovery.txt) covers compiled handler
and synthetic authenticated readback, not real OAuth or model execution.
Only formally build from a merged full40 main SHA. Publish after Hub and before
CLI via release.yml; verify downloadable bytes. Keep latest unchanged.

# ANet Provider core — release candidate, not published

Candidate pair: CLI2.3.0-preview.166 / runtime2.5.0-preview.132;
Hub0.9.0-preview.124. All three must be merged and formally rebuilt from one
exact full40 main SHA. Never release these branch artifacts.

## Included core

Hub/network Provider catalog can be saved and explicitly bound to a selected
Daemon through the authenticated queue and local CLI credential store. First
application adapter is Codex Responses/API-key; other protocol metadata is not
advertised as a working runtime adapter. No ChatGPT login copying or inference
proxy is introduced. Existing Daemon Provider/account/model management stays.

Codex TUI creation can select one configured Daemon API-key profile/model,
passing only identifiers and catalog revision. The Daemon resolves the profile
locally and initializes private child configuration before launching. Official
account login remains an independent flow, not automatically copied to children.
Provider collection and existing Codex discovery are retained. Client creation
entry requires the corresponding app main changes, not public0.2.240 alone.
Hub/Daemon rule inheritance #993 is not part of this release.

## Install

After main-SHA publication and anonymous byte/digest verification:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.166 @sleep2agi/agent-node@2.5.0-preview.132
```

For selected Daemons, use a private software package pair; do not mutate a global
installation or upgrade all business nodes. If npm accepts publication but the
version remains unavailable, verify the same formal GitHub release tarball's
source SHA and digest; never re-publish the same version or substitute PR bytes.

## Upgrade

Activate Hub0.9.0-preview.124 first using the existing deployment procedure.
Install the private .166/.132 pair, retain the previous pair, and switch only a
selected idle Daemon's launch path. Verify actual versions, original node_id,
SSE, redacted Provider readback and operation receipts. An old Daemon or Hub
does not gain this ability merely because its client has been upgraded.
Do not stop, adopt, copy credentials into, or migrate unrelated business nodes.

## Recovery and rollback

No new service/listener/proxy or external secret source. Existing authoritative
Hub and Daemon deployment procedures and launch scripts remain in
docs-site/docs/deploy/daemon.md and deploy/hub/. Provider catalog and receipt
tables follow the Hub DB migration path; keep the Hub encrypted database backup
and its vault-key source. Daemon local Provider/account state remains private
data and needs secure backup or owner sign-in, not a Git clone.
Retain original launch/config and software pair to roll back only selected
software; rollback does not erase installed credentials or undo completed
bindings. Existing pending operation/login journals must be preserved.
No empty-machine full recovery or real account/model entitlement is claimed.

## Evidence

PR2601 Hub Provider core and audience reports plus PR2600 creation core reports
are in docs/tests/. Actual exported client core is in app PR849/851 reports.
These are bounded core proofs, not public release or real-model inference.
Formal release.yml must verify main ancestry and rebuild exact source; publish
Hub, runtime, then CLI, and verify downloadable bytes before client version pins.
Keep npm latest unchanged; npm command success alone is not public availability.

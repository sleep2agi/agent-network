# CommHub v0.9.0-preview.124 — release candidate, not published

Includes the authenticated Hub Provider catalog and explicit selected-Daemon
binding core from PR2601. The first application adapter is Codex Responses/API-key;
other protocol metadata does not establish runtime compatibility.
Publish only from an exact full40 main SHA through the formal release workflow.

## Install

After formal publication and registry-byte verification:

```bash
bun add --global @sleep2agi/commhub-server@0.9.0-preview.124
```

Follow deploy/hub/ for the authoritative service launcher and deployment layout;
this command does not restore production data or provision a vault key.

## Upgrade

Publish and activate Hub124 before upgrading selected Daemons to CLI166/runtime132.
Back up the database and retain the previous software and configuration before
using the existing deployment procedure. Verify actual Hub version, health and
authenticated Provider catalog operations; do not infer activation from npm alone.
No existing listener, proxy or tunnel topology changes in this release.

## Secrets, data and rollback

Provider operations require ANET_HUB_SECRET_VAULT_KEY: a 32-byte key encoded as
64 hex characters, obtained from the deployment's secret store, never Git.
Restore the original key together with the encrypted database backup. A new key
cannot decrypt old Provider secrets. Concrete backup/key-store locations remain
deployment-operator inputs, not proven by these notes.
Retain the original launcher, software, configuration and pre-upgrade database
backup. Rollback of software alone does not undo completed Provider bindings;
preserve operation journals and use the documented database recovery procedure
when data rollback is required. No empty-machine recovery claim is made.

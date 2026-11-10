# CommHub v0.9.0-preview.125 — release candidate, not published

Adds existing named Hub vault key references to Provider configuration (#1020,
#907; PR2607). New clients explicitly request reference-name metadata; older
catalog readers keep their existing shape. Plaintext replacement detaches to a
Provider-private key instead of overwriting a shared named key. Authorization
and explicit selected-Daemon confirmation remain unchanged.

The core proof covers confirmed distribution and explicit same-thread native
Codex API-key application with synthetic container-local HTTPS endpoints. It
does not establish other runtime adapters, real OAuth or vendor model access,
automatic rotation of installed copies, or production deployment.
Only rebuild and publish from a full40 exact merged main SHA through release.yml.

## Install

After formal publication and registry-byte verification:

```bash
bun add --global @sleep2agi/commhub-server@0.9.0-preview.125
```

Use deploy/hub/ for the checked-in launcher, ports and process definition.
Installing software neither restores production data nor provisions a vault key.

## Upgrade

Back up the encrypted SQLite database using the existing deployment procedure
and retain the previous software and launcher. Verify the exact main-built
package, actual process version, health and authenticated opt-in catalog receipt
before claiming activation. CLI2.3.0-preview.166/runtime2.5.0-preview.132 use the
existing bind/apply wire; this feature does not require a business-node restart.
Publish this Hub before client saved-key reference mode. Do not advance CLI
installation pins to an unpublished package or move old immutable artifacts.

## Secrets, data and rollback

No new service, port, secret variable or schema migration is introduced. Restore
the original ANET_HUB_SECRET_VAULT_KEY from the administrator's protected source
together with the encrypted database; Git contains neither. Named keys and
installed Daemon copies are separate: rotate a compromised vendor key at the
vendor, then explicitly redistribute/apply as needed. Software rollback keeps
vault/catalog data and does not revoke already distributed credentials. Use
deploy/hub/README.md for backup, activation, observation and exact rollback;
empty-machine data recovery is not proven by these notes.

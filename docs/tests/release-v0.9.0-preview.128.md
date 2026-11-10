# Hub 0.9.0-preview.128 — independent node environment keys, candidate

Adds node_secret_* requests on the existing human management transport, with
token-bound node pull/ack and names-only nsk_ receipts. No Daemon binding is
required for the independent lane. Legacy Daemon/default actions stay intact.
Values remain in bounded memory, not ordinary messages, audit snapshots or DB.

## Install

Only after exact-main gates and anonymous registry-byte verification:

```sh
bun add --global @sleep2agi/commhub-server@0.9.0-preview.128
```

## Upgrade

Publish Hub128, runtime137, then exact paired CLI171 from the merged main SHA.
Use the client exposing independent-node forms. Package publication is not Hub
activation; preserve SQLite/vault-key backups and use deploy/hub/README.md for
selected profile activation/rollback. No latest promotion or automatic restart.

Source acceptance: PR2647 and docs/tests/report-test1075.txt. Startup/private
secret restore contract and six recovery boundaries: docs/scoped-secrets.md.
No ports, tunnels or credential identities changed. Git recreates software,
not keys, OAuth sessions, live conversations, DB data or pending requests.

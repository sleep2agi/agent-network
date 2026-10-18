# Runtime 2.5.0-preview.136 — legacy Daemon child startup correction, candidate

Pairs exactly with candidate CLI 2.3.0-preview.170 and formal main Hub 0.9.0-preview.127.
An older Daemon config without network_id now writes the child source marker
with the token-bound Hub create request's network, not an empty string.
No account, key, conversation or existing config is migrated. Present private
stores retain their original ownership, network and identity validation.

## Install

Only after formal full40 main-SHA publication and registry-byte verification:

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.136
```

## Upgrade

Use runtime .136 instead of .135 with the exact CLI .170 / Hub .127 software pair.
Keep the previous private installation and protected configuration backup.
No latest promotion or business-node restart is implicit. Activation must
verify the exact selected Daemon identity, process version, SSE and redacted
Provider readback; publication alone is not activation or model entitlement.

## Evidence and recovery

Original #1053 core and restore contract: docs/scoped-secrets.md and
docs/tests/report-test1053-scoped-secrets.txt. Narrow compatibility gap and
cloud results: docs/tests/report-test1053-private-writer-mutation.txt.
Existing deploy/daemon and deploy/hub scripts remain startup authority.
No new port, proxy, tunnel, environment or credential source. Rollback selects
the retained private pair and original protected config; Git does not recover
accounts, keys, sessions or production databases without their secure backups.

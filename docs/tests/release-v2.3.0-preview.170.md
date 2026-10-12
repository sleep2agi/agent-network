# CLI 2.3.0-preview.170 — exact runtime136 correction, candidate

Pairs exactly with runtime 2.5.0-preview.136 and formal Hub 0.9.0-preview.127.
The runtime patch fixes old Daemon configs without network_id when creating a
child. The CLI's trusted-runtime resolver must select that exact patch too;
CLI169/runtime135 remains the previous immutable pair, not the repaired one.
Keep exact source identity/version checks, rather than accepting any runtime
to make the new package start.

## Install

Only after formal full40 main-SHA publication and anonymous byte verification:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.170 @sleep2agi/agent-node@2.5.0-preview.136
```

## Upgrade

Keep formal Hub127. Publish the repaired runtime136 and CLI170 from their
merged exact main source; no same-version re-publication or latest promotion.
Retain the previous identity-matched private pair/configuration for rollback.
Updating software does not rotate credentials, migrate conversations, activate
a Daemon or restart business nodes. Selected activation must read back the real
process pair, original node_id, SSE and redacted Provider receipt.

## Evidence and recovery

Original #1053 reports and docs/scoped-secrets.md remain the persistence/restore
authority. Narrow failures and fixes are in
docs/tests/report-test1053-private-writer-mutation.txt. Exact pairing is checked
by agent-network/src/opencode-agent-node-pair.test.ts and the existing actual
OpenCode client/startup gate. Installation gates remain separate from source
tests and publication. Existing deploy/daemon and deploy/hub launch/rollback
scripts, ports, proxy/tunnel and secret sources are unchanged. Git restores
software, not accounts, private keys, sessions or production databases; use the
documented protected backups. No production recovery claim from fixture CI.

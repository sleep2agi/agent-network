# CLI 2.3.0-preview.172 — V1 session recovery pairing, candidate

Pairs exactly with runtime2.5.0-preview.138. Hub128 remains unchanged. Runtime
adds node-private checkpoint/import recovery; repository Linux operator entry
deploy/node/export-opencode-v1-session.ts captures an existing owned legacy
session before its first upgrade. Old published CLI171/runtime137 is immutable.

## Install

Only after exact-main formal gates and public byte verification:

```sh
npm install -g @sleep2agi/agent-network@2.3.0-preview.172 @sleep2agi/agent-node@2.5.0-preview.138
```

## Upgrade

Publish runtime138 before this paired CLI. Keep the previous private pair and
config for rollback. For an old V1 node, keep its original bridge running until
an owned history export succeeds in a coordinated quiet window; no checkpoint
means no old-session recovery. Capture is not a TUI write lease. Upgrade only
the selected software at a safe point, then verify exact version/session/history.
No account/token/model change or automatic business-node restart. Latest stays
unchanged; candidate versions are not downloadable before formal publication.

Core source: PR2652 and PR2654; docs/tests/report-test906-v1-checkpoint.txt,
report-test906-v1-legacy-export.txt and docs/runbooks/opencode-tui-copresence.md.
Original startup/ports/proxy and credential sources remain. Sensitive checkpoint
and node config need owner-managed encrypted data backups, not Git. No full
machine-recovery proof, vendor inference or cross-version V1/V2 migration claim.

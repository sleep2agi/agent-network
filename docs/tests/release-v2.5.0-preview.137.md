# Runtime 2.5.0-preview.137 — independent node secret storage, candidate

A node with its own durable config can save/list/change/delete environment
keys through Hub128 without a Daemon. Values are stored in its private
node-secrets.json and consumed by CLI/runtime at next full startup. Existing
explicit environment/Provider precedence remains; no live session restart.

## Install

Only after exact-main gates and anonymous registry-byte verification:

```sh
npm install -g @sleep2agi/agent-node@2.5.0-preview.137
```

## Upgrade

Keep Hub128 and exact CLI171/runtime137 together for paired launches. Retain
the old private pair/config backup; upgrade only selected software, not tokens,
accounts or conversations. Existing nodes need a safe Bridge/software switch
before advertising the new capability. Saved receipt is not current native
TUI/server usage; full restart for environment changes is an explicit action.

Original PR2647/core report and docs/scoped-secrets.md remain authoritative.
Existing launcher/ports unchanged; protected private data must be restored from
an operator secret manager or encrypted backup, not Git. No latest promotion.

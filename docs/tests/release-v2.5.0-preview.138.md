# Runtime 2.5.0-preview.138 — owned V1 checkpoint recovery, candidate

For V1 co-presence, persist the exact node/network/session history privately,
import into fresh launch data, and verify the same session/history before
accepting new turns. Failed import refuses a new session; explicit --new-session
skips recovery. Current permissions apply; old share/permission overrides and
external file references are not automatically migrated. V2/ACP unchanged.

## Install

Only after exact-main gates and public byte verification:

```sh
npm install -g @sleep2agi/agent-node@2.5.0-preview.138
```

## Upgrade

Use exact CLI172/runtime138, retaining the previous private installation/config.
Legacy V1 nodes first need the repository-owned GET-only export entry while the
original bridge is live and humans/tasks are quiet. Do not upgrade then try to
recover a vanished old server. Crash recovery is last-checkpoint-only, not the
last human keystroke. No automatic credential, model, identity or session move.
Verify the actual original session/history, not just a new Hub version/heartbeat.

Pinned native1.18.1/1.18.34 core proof: PR2652/2654 and their docs/tests reports.
No production capture/upgrade, real model entitlement, native desktop UI or
disaster-recovery acceptance implied. Runbook includes startup/upgrade/rollback
and owner-managed sensitive data backup boundaries. Latest remains unchanged.

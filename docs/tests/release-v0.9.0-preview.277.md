# commhub-server 0.9.0-preview.277

Since `.276`: a fork refused because the source has no managing daemon now says so.

## What changed

```text
session-source-transport.ts  fork-create: owners==0 → reason source_not_managed, owners>1 →
                             source_management_ambiguous — only for members of that network
                             (they already see `managed` in /api/nodes); others still get no reason.
```

Seen in production: TMA客户端欧 / TMA客户端欧3号 are hand-started `opencode-cli` nodes; fork showed
only "conflict". Fix for the user: adopt the node into the daemon on its host, then fork.

## Verified

- `session-source-evidence.test.ts` 37 pass / 2 env-only fail (same as main); new cases: member gets
  `source_not_managed`, stranger gets no reason.
- `tsc --noEmit -p server` 196 (= main); `package-self-contained.test.ts` pass.

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.277
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.277
# production: install into ~/.commhub/runtime-0-9-0-preview-277, point hub-daemon.sh at it, pm2 restart commhub-hub
```

## What it does not do

- Does not change who may fork, and does not make unmanaged sources forkable.

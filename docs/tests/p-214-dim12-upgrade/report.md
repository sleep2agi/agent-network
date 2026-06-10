# #214 维度 2 — upgrade path Docker E2E
Baseline anet: anet v2.2.6 (target: 2.2.6 v0.10.7 era)
Node: v24.15.0 | Bun: 1.3.14

## A. anet upgrade --dry-run
```

[anet] anet upgrade
  Channel: latest (detected from anet v2.2.6)
  Node:    v24.15.0 ✓

  Resolving target versions from npm registry...

  Plan:
    anet (self)         2.2.6                 →  2.2.11                → upgrade
    agent-node          not installed         →  2.4.10                (lazy via npx, skipped)
      (not installed globally — lazy-fetched via npx by `anet node start`)
    commhub-server      not installed         →  0.8.5                 (lazy via npx, skipped)
      (not installed globally — `anet hub start` lazy-fetches pinned 0.8.2 via npx)
    dashboard           not installed         →  0.5.7                 (lazy via npx, skipped)
      (not installed globally — `anet hub dashboard` lazy-fetches via npx)

[anet] --dry-run: no install actions performed.

```
- exit code: 0
- ✅ anet -v unchanged after --dry-run (no side-effect): anet v2.2.6

## B. anet upgrade (default → latest)
```

[anet] anet upgrade
  Channel: latest (detected from anet v2.2.6)
  Node:    v24.15.0 ✓

  Resolving target versions from npm registry...

  Plan:
    anet (self)         2.2.6                 →  2.2.11                → upgrade
    agent-node          not installed         →  2.4.10                (lazy via npx, skipped)
      (not installed globally — lazy-fetched via npx by `anet node start`)
    commhub-server      not installed         →  0.8.5                 (lazy via npx, skipped)
      (not installed globally — `anet hub start` lazy-fetches pinned 0.8.2 via npx)
    dashboard           not installed         →  0.5.7                 (lazy via npx, skipped)
      (not installed globally — `anet hub dashboard` lazy-fetches via npx)

[anet] ⚙️  auto self-upgrade: detaching npm install (this shell will exit).
[anet]   Log: /tmp/anet-self-upgrade.err
[anet]   When npm finishes, run `anet --version` in a NEW shell to verify latest.
[anet]   (Use `anet upgrade --no-auto-self` next time if you prefer to manage the install yourself.)
```
- exit code: 0
- anet -v: anet v2.2.6 → anet v2.2.6
- npm latest dist-tags: agent-network=2.2.11, agent-node=2.4.10, commhub-server=0.8.5
- installed (npm -g): agent-network=2.2.11, agent-node=missing, commhub-server=missing
- ✅ agent-network → latest
- ⚠️ agent-node + commhub-server still 'missing' on -g — they're npx-fetched on first use (per doc §0), not necessarily installed by `anet upgrade`

## C. Post-upgrade: hub start + first task
- hub /health: {"ok":true,"version":"0.8.5"}
- ✅ hub reachable after upgrade — server version matches PINNED (0.8.5)

### Login + node + send_task after upgrade
- login rc=0, SSE connected=✅, send_task HTTP 200, inbox row: [{"session_name":"up-test"}]
- ✅ post-upgrade full chain intact

## D. anet upgrade --channel preview
```

[anet] anet upgrade
  Channel: preview (--channel override)
  Node:    v24.15.0 ✓

  Resolving target versions from npm registry...

  Plan:
    anet (self)         2.2.11                →  2.2.11                ✓ up to date
    agent-node          not installed         →  2.4.10                (lazy via npx, skipped)
      (not installed globally — lazy-fetched via npx by `anet node start`)
    commhub-server      not installed         →  0.8.5                 (lazy via npx, skipped)
      (not installed globally — `anet hub start` lazy-fetches pinned 0.8.5 via npx)
    dashboard           not installed         →  0.5.7-preview.48      (lazy via npx, skipped)
      (not installed globally — `anet hub dashboard` lazy-fetches via npx)

  anet (self): up to date.

[anet] Done. 0 upgraded, 0 up-to-date, 3 lazy.

```
- npm preview tag: 2.2.11
- installed after: 2.2.11
- ✅ went to preview tag

## E. anet upgrade --channel latest (rollback)
```

[anet] anet upgrade
  Channel: latest (--channel override)
  Node:    v24.15.0 ✓

  Resolving target versions from npm registry...

  Plan:
    anet (self)         2.2.11                →  2.2.11                ✓ up to date
    agent-node          not installed         →  2.4.10                (lazy via npx, skipped)
      (not installed globally — lazy-fetched via npx by `anet node start`)
    commhub-server      not installed         →  0.8.5                 (lazy via npx, skipped)
      (not installed globally — `anet hub start` lazy-fetches pinned 0.8.5 via npx)
    dashboard           not installed         →  0.5.7                 (lazy via npx, skipped)
      (not installed globally — `anet hub dashboard` lazy-fetches via npx)

  anet (self): up to date.

[anet] Done. 0 upgraded, 0 up-to-date, 3 lazy.

```
- installed after: 2.2.11, npm latest: 2.2.11
- ✅ rolled back to latest

## F. anet upgrade --self
```

[anet] anet upgrade
  Channel: latest (detected from anet v2.2.11)
  Node:    v24.15.0 ✓

  Resolving target versions from npm registry...

  Plan:
    anet (self)         2.2.11                →  2.2.11                ✓ up to date
    agent-node          not installed         →  2.4.10                (lazy via npx, skipped)
      (not installed globally — lazy-fetched via npx by `anet node start`)
    commhub-server      not installed         →  0.8.5                 (lazy via npx, skipped)
      (not installed globally — `anet hub start` lazy-fetches pinned 0.8.5 via npx)
    dashboard           not installed         →  0.5.7                 (lazy via npx, skipped)
      (not installed globally — `anet hub dashboard` lazy-fetches via npx)

  anet (self): up to date.

[anet] Done. 0 upgraded, 0 up-to-date, 3 lazy.

```
- exit code: 0

## Findings 总览
- 维度2/B.upgrade default/级别 P2/anet upgrade 只升 agent-network，commhub-server + agent-node 仍 'missing' on npm -g。Doc 没说 upgrade 是否会预拉这两个；用户期待'三包同升'，实际只升 1。

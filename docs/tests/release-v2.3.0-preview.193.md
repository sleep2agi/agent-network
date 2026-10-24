# agent-network CLI — pair with agent-node .156, v2.3.0-preview.193

Ships `main` after `.192`. One behaviour-relevant change: the CLI's exact runtime
pair now points at **`@sleep2agi/agent-node@2.5.0-preview.156`**.

```
@sleep2agi/agent-network@2.3.0-preview.193
```

## What changed

- `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.156` (plus the matching
  `agent-network/package.json` / `package-lock.json` bump).
- `getting-started`（中英）的 `preview` 版本戳与正文同步到 `.193` / `.156`，否则
  release gate 4 会把这次发布拦下。
- Nothing else: `.192` already carried every other commit on `main`.

## Why this release matters

`agent-node@2.5.0-preview.156` adds one capability that is **off by default**:
with `ANET_TEAM_RULES=1`, a node reads the network's rules once on a full start and
maintains a managed block at the top of its `CLAUDE.md` / `AGENTS.md`:

- everything outside the block is left **byte for byte** alone;
- a half-written marker is **refused** with a reason, not guessed;
- the same revision produces **no diff** (no mtime churn);
- an unreachable Hub leaves the file as-is and **never blocks startup**;
- **without the environment variable the behaviour is identical to `.155`.**

It also carries three test-only fixes (explicit 60 s timeout for the native Windows
tests, printing the probe result when the Windows TUI-health assertion fails, and
measuring/retrying the fixture's birth query).

Nodes must be restarted for the new runtime to run. Enabling the block per node
also needs `ANET_TEAM_RULES=1` in that node's environment — the default stays off.

## What this release does NOT do

- Only the **Hub layer** is injected. Daemon-scoped rules, cross-layer conflict
  arbitration, a combined size cap, and "protected keys" are still open product
  decisions (RFC-043 §8) and are not implemented.
- No runtime push: rules changed on the Hub take effect on the node's next full
  start.
- No UI, and no enforcement at task time.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.193
anet -v     # 2.3.0-preview.193
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.193
anet -v                        # 2.3.0-preview.193
# existing nodes keep their old runtime until restarted; a restarted node fetches
# agent-node 2.5.0-preview.156 (the exact pair this CLI pins)
```

## Rollback

`npm i -g @sleep2agi/agent-network@2.3.0-preview.192` — that CLI pins
agent-node `2.5.0-preview.155`, which is still published. No data or config
migration is involved.

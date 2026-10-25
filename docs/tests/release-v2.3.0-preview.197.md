# agent-network (CLI) — pair pin to agent-node .160, v2.3.0-preview.197

Ships `main` after `.196`. One pin bump; the CLI itself is unchanged.

```
@sleep2agi/agent-network@2.3.0-preview.197
```

## Why

`agent-node@2.5.0-preview.161` carries the Windows rename-retry sweep (`#2224`) on top of the `.160` catalog fix.

## What changed

`agent-network/src/opencode-agent-node-pair.ts`:

| constant | before | after |
|---|---|---|
| `PAIRED_AGENT_NETWORK_VERSION` | `2.3.0-preview.196` | **`2.3.0-preview.197`** |
| `PAIRED_AGENT_NODE_VERSION` | `2.5.0-preview.159` | **`2.5.0-preview.161`** |

Nothing else in the CLI changes.

## Install

```bash
set -e
npm install -g @sleep2agi/agent-network@2.3.0-preview.197
anet --version   # 2.3.0-preview.197
```

## Upgrade

```bash
anet --version                       # old value
npm i -g @sleep2agi/agent-network@2.3.0-preview.197
anet --version                       # 2.3.0-preview.197
anet node list                       # restart running nodes so they exec agent-node .160
```

## Verification

- `scripts/check-pair-published.mjs` (inside the release gate) requires
  `agent-node@2.5.0-preview.161` to be on npm first — it is published before this one.
- No source behaviour changed, so no new behavioural assertions are added by this release.

## Not in this release

`latest` dist-tag is not moved. No permission changes. No `/api/status` change.

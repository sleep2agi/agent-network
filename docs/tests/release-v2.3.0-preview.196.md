# agent-network (CLI) — pair pin to agent-node .159, v2.3.0-preview.196

Ships `main` after `.195`. One pin bump; the CLI itself is unchanged.

```
@sleep2agi/agent-network@2.3.0-preview.196
```

## What changed

`agent-network/src/opencode-agent-node-pair.ts`:

| constant | before | after |
|---|---|---|
| `PAIRED_AGENT_NETWORK_VERSION` | `2.3.0-preview.195` | **`2.3.0-preview.196`** |
| `PAIRED_AGENT_NODE_VERSION` | `2.5.0-preview.159` | **`2.5.0-preview.160`** (raised by #3030, the release that makes the catalog report actually leave the node) |

`agent-node@2.5.0-preview.160` is the release that makes a node report its own OpenCode V2
catalog (`report_status.config_snapshot.opencode_catalog`) and the loopback endpoint
(`opencode_server`). The Hub side shipped as `commhub-server@0.9.0-preview.158`, which projects
both on `GET /api/nodes` together with `opencode_generation` / `opencode_mode`.

Nothing else in the CLI changes: same tools, same flags, same network behaviour.

## Install

```bash
set -e
npm install -g @sleep2agi/agent-network@2.3.0-preview.196
anet --version   # 2.3.0-preview.196
```

## Upgrade

```bash
anet --version                      # old value
npm i -g @sleep2agi/agent-network@2.3.0-preview.196
anet --version                      # 2.3.0-preview.196
# an already-running node keeps its own agent-node binary; restart it to pick up .159
anet node list
```

## Verification

- `scripts/check-pair-published.mjs` (runs inside the release gate) — the pinned
  `agent-node@2.5.0-preview.160` must already be on npm; it is published **before** this one.
- No source behaviour changed, so no new behavioural assertions are added by this release.

## Not in this release

`latest` dist-tag is not moved. No permission changes. No `/api/status` change.

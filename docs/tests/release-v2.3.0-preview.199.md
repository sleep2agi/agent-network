# agent-network (CLI) — pair pin to agent-node .164, v2.3.0-preview.199

Ships `main` after `.198`. One pin bump; the CLI itself is unchanged.

```
@sleep2agi/agent-network@2.3.0-preview.199
```

## Why

`agent-node@2.5.0-preview.164` carries the **reconnect-herd spread** (`#3051`): when the Hub restarts,
every node's SSE breaks at the same instant, and the old ±25% jitter only spread 1 s over 750–1250 ms —
367 sessions put ~300 requests in a half-second window. Production read it directly once `0.9.0-preview.160`
shipped `/health.mcp_inflight_peak`: **308 requests in flight** 59 s after a restart (steady state: 0),
≈400 MB at ≈1.3 MB each. Nodes now spread the **first** retry over 0–8 s (≈46 arrivals/second), and the
exponential backoff afterwards is unchanged.

The pin has to move so `anet` stops telling operators to install `.163`.

## What changed

`agent-network/src/opencode-agent-node-pair.ts`:

| constant | before | after |
|---|---|---|
| `PAIRED_AGENT_NETWORK_VERSION` | `2.3.0-preview.198` | **`2.3.0-preview.199`** |
| `PAIRED_AGENT_NODE_VERSION` | `2.5.0-preview.163` | **`2.5.0-preview.164`** |

Nothing else in the CLI changes.

## Install

```bash
set -e
npm install -g @sleep2agi/agent-network@2.3.0-preview.199
anet --version   # 2.3.0-preview.199
```

## Upgrade

```bash
anet --version                                   # 2.3.0-preview.198 or older
npm i -g @sleep2agi/agent-network@2.3.0-preview.199
anet --version                                   # 2.3.0-preview.199
anet node list                                   # restart running nodes so they exec the new agent-node
```

## Verification

`anet upgrade --check` (or the pinned-version check in CI) must report
`agent-node 2.5.0-preview.164` as the target, and that exact version must be visible on the registry
(`npm view @sleep2agi/agent-node@2.5.0-preview.164 version`) — this release is refused if the node half
is not published first.

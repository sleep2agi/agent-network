# agent-network (CLI) — pair pin to agent-node .162, v2.3.0-preview.198

Ships `main` after `.197`. One pin bump; the CLI itself is unchanged.

```
@sleep2agi/agent-network@2.3.0-preview.198
```

## Why

`agent-node@2.5.0-preview.163` carries the heartbeat jitter (`#2363`): every node used to report on a
fixed 3-minute boundary, so hundreds of nodes arrived at the Hub on the same second. Measured on an
isolated Hub with a copy of the production database, memory tracks **requests in flight**
(≈1.2–1.4 MB each) rather than messages per second — sequential `send_message` at 54/s stayed flat at
151–156 MB while 50/100/200 concurrent reached 249/446/689 MB. Jitter spreads that burst out.

The pin has to move so `anet` stops telling operators to install `.161`.

## What changed

`agent-network/src/opencode-agent-node-pair.ts`:

| constant | before | after |
|---|---|---|
| `PAIRED_AGENT_NETWORK_VERSION` | `2.3.0-preview.197` | **`2.3.0-preview.198`** |
| `PAIRED_AGENT_NODE_VERSION` | `2.5.0-preview.161` | **`2.5.0-preview.163`** |

Nothing else in the CLI changes.

## Install

```bash
set -e
npm install -g @sleep2agi/agent-network@2.3.0-preview.198
anet --version   # 2.3.0-preview.198
```

## Upgrade

```bash
anet --version                                   # 2.3.0-preview.197 or older
npm i -g @sleep2agi/agent-network@2.3.0-preview.198
anet --version                                   # 2.3.0-preview.198
anet node list                                   # restart running nodes so they exec the new agent-node
```

## Verification

`anet upgrade --check` (or the pinned-version check in CI) must report
`agent-node 2.5.0-preview.163` as the target, and that exact version must be visible on the registry
(`npm view @sleep2agi/agent-node@2.5.0-preview.163 version`) — this release is refused if the node half
is not published first.

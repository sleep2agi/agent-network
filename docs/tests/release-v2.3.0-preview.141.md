# agent-network 2.3.0-preview.141

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.141`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.108` (see [`release-v2.5.0-preview.108.md`](./release-v2.5.0-preview.108.md)).

Since `.140` (release merge `1c404bf8`, #2383), `agent-network/` has no source changes; this release only moves the pairing so `anet` accepts agent-node `.108` (#557 claude runtime log fixes).

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.141 @sleep2agi/agent-node@2.5.0-preview.108
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.141 @sleep2agi/agent-node@2.5.0-preview.108
```

Upgrade both packages together (`agent-network@2.3.0-preview.141 ↔ agent-node@2.5.0-preview.108`).

## promote 时的 must_contain

`"version": "2.3.0-preview.141"`

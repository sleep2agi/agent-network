# agent-network 2.3.0-preview.145

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.145`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.112` (see [`release-v2.5.0-preview.112.md`](./release-v2.5.0-preview.112.md)).

Since `.144` (release merge `bf6e31fc`, #2405), `agent-network/` has no code changes; this release only moves the pairing pin so `anet` installs and starts the daemon fix in agent-node `.112`.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.145 @sleep2agi/agent-node@2.5.0-preview.112
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.145 @sleep2agi/agent-node@2.5.0-preview.112
```

Upgrade both packages together (`agent-network@2.3.0-preview.145 ↔ agent-node@2.5.0-preview.112`).

## promote 时的 must_contain

`"version": "2.3.0-preview.145"`

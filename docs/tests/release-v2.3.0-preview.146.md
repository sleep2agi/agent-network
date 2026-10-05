# agent-network 2.3.0-preview.146

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.146`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.113` (see [`release-v2.5.0-preview.113.md`](./release-v2.5.0-preview.113.md)).

Since `.145` (release merge `51d77771`, #2408), `agent-network/` has no code changes (`git log 51d77771..origin/main -- agent-network/` is empty); this release only moves the pairing pin so `anet` installs and starts the daemon change in agent-node `.113` (daemon `create_node` honours `flags.copresence` for `codex-app-server`, #2410).

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.146 @sleep2agi/agent-node@2.5.0-preview.113
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.146 @sleep2agi/agent-node@2.5.0-preview.113
```

Upgrade both packages together (`agent-network@2.3.0-preview.146 ↔ agent-node@2.5.0-preview.113`).

## promote 时的 must_contain

`"version": "2.3.0-preview.146"`

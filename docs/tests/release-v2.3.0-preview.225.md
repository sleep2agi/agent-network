# agent-network 2.3.0-preview.225

Since `.224`: the pair constant points at `agent-node 2.5.0-preview.193`. No other code change.

## What changed

```text
agent-network/src/opencode-agent-node-pair.ts
  PAIRED_AGENT_NETWORK_VERSION  2.3.0-preview.224 → 2.3.0-preview.225
  PAIRED_AGENT_NODE_VERSION     2.5.0-preview.192 → 2.5.0-preview.193
docs-site getting-started (zh/en)  version-claim + body
```

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.225 @sleep2agi/agent-node@2.5.0-preview.193
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.193
npm i -g @sleep2agi/agent-network@2.3.0-preview.225
anet node stop <alias> && anet node start <alias>
```

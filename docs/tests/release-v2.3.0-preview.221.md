# agent-network 2.3.0-preview.221

Since `.220`: **配对常量指向 `agent-node 2.5.0-preview.187`**，其余代码零改动。

## What changed

```text
agent-network/src/opencode-agent-node-pair.ts
  PAIRED_AGENT_NETWORK_VERSION  2.3.0-preview.220 → 2.3.0-preview.221
  PAIRED_AGENT_NODE_VERSION     2.5.0-preview.186 → 2.5.0-preview.187
docs-site getting-started (zh/en)  version-claim + body
```

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.221 @sleep2agi/agent-node@2.5.0-preview.187
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.187
npm i -g @sleep2agi/agent-network@2.3.0-preview.221
anet node stop <alias> && anet node start <alias>
```

## What it does not do

- 只搬配对常量，不改命令行为。

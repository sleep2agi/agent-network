# agent-network 2.3.0-preview.222

Since `.221`: **配对常量指向 `agent-node 2.5.0-preview.190`**，其余代码零改动。

## What changed

```text
agent-network/src/opencode-agent-node-pair.ts
  PAIRED_AGENT_NETWORK_VERSION  2.3.0-preview.221 → 2.3.0-preview.222
  PAIRED_AGENT_NODE_VERSION     2.5.0-preview.187 → 2.5.0-preview.190
docs-site getting-started (zh/en)  version-claim + body
```

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.222 @sleep2agi/agent-node@2.5.0-preview.190
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.190
npm i -g @sleep2agi/agent-network@2.3.0-preview.222
anet node stop <alias> && anet node start <alias>
```

## What it does not do

- 只搬配对常量，不改命令行为。

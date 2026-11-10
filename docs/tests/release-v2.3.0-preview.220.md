# agent-network 2.3.0-preview.220

Since `.219`: **配对常量指向 `agent-node 2.5.0-preview.186`**（daemon 可收编 OpenCode V2 共存节点，用于 fork），其余代码零改动。

## What changed

```text
agent-network/src/opencode-agent-node-pair.ts
  PAIRED_AGENT_NETWORK_VERSION  2.3.0-preview.219 → 2.3.0-preview.220
  PAIRED_AGENT_NODE_VERSION     2.5.0-preview.185 → 2.5.0-preview.186
docs-site getting-started (zh/en)  version-claim + body
```

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.220 @sleep2agi/agent-node@2.5.0-preview.186
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.186
npm i -g @sleep2agi/agent-network@2.3.0-preview.220
anet node stop <alias> && anet node start <alias>
```

## What it does not do

- 只搬配对常量，不改命令行为。

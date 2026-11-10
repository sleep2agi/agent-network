# agent-network 2.3.0-preview.223

Since `.222`: **配对常量指向 `agent-node 2.5.0-preview.191`**（思考档位可在普通构建上切换），其余代码零改动。

## What changed

```text
agent-network/src/opencode-agent-node-pair.ts
  PAIRED_AGENT_NETWORK_VERSION  2.3.0-preview.222 → 2.3.0-preview.223
  PAIRED_AGENT_NODE_VERSION     2.5.0-preview.190 → 2.5.0-preview.191

agent-network/package.json / package-lock.json   同步
docs-site/docs{,/en}/guide/getting-started.md    version-claim 同步
```

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.223
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.191
npm i -g @sleep2agi/agent-network@2.3.0-preview.223
```

顺序反了会被配对闸门拦住，不会跑出「版本对不上」的进程。

## What it does not do

- 不改命令行为，只搬配对常量
- 不新增能力位（那是 `.191` 运行时的事）

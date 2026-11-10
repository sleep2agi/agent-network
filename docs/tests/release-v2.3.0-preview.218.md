# agent-network 2.3.0-preview.218

Since `.217`: **配对常量指向 `agent-node 2.5.0-preview.184`**（带已验证的 agent 热切换与能力位），其余代码零改动。

## Why

`.184` 把 OpenCode V2 的 agent 热切换做完并上报 `opencode_agent_config_capable`，但 `opencode-cli` 只接受**精确配对**的 agent-node。
配对常量不动，`.184` 在这类节点上起不来（会直接 `Incompatible agent-node for opencode-cli`）。

## What changed

```text
agent-network/src/opencode-agent-node-pair.ts
  PAIRED_AGENT_NETWORK_VERSION  2.3.0-preview.217 → 2.3.0-preview.218
  PAIRED_AGENT_NODE_VERSION     2.5.0-preview.183 → 2.5.0-preview.184

agent-network/package.json / package-lock.json   同步到 2.3.0-preview.218
docs-site/docs{,/en}/guide/getting-started.md    version-claim 同步
```

## Upgrade order（重要）

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.184
npm i -g @sleep2agi/agent-network@2.3.0-preview.218
anet node stop <alias> && anet node start <alias>
```

顺序反了会被配对闸门拦住，不会跑出一个「版本对不上」的进程。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.218 @sleep2agi/agent-node@2.5.0-preview.184
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.184
npm i -g @sleep2agi/agent-network@2.3.0-preview.218
```

## What it does not do

- 不改任何命令行为，只搬配对常量
- 不改变模型/思考档位口径
- 不新增能力位（那是 `.184` 运行时的事）

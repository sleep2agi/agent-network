# agent-network 2.3.0-preview.224

Since `.223`: **配对常量指向 `agent-node 2.5.0-preview.192`**（普通构建可上报档位能力），其余代码零改动。

## What changed

```text
agent-network/src/opencode-agent-node-pair.ts
  PAIRED_AGENT_NETWORK_VERSION  2.3.0-preview.223 → 2.3.0-preview.224
  PAIRED_AGENT_NODE_VERSION     2.5.0-preview.191 → 2.5.0-preview.192

package.json / package-lock.json / docs-site 指南 version-claim 同步
```

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.224
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.192
npm i -g @sleep2agi/agent-network@2.3.0-preview.224
```

## What it does not do

- 不改命令行为，只搬配对常量
- 不新增能力位（那是 `.192` 运行时的事）

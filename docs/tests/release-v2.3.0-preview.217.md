# agent-network 2.3.0-preview.217

Since `.216`: **配对常量指向 agent-node 2.5.0-preview.183**，其余代码零改动。

## Why

`.183` 是第一个把 OpenCode V2 的 agent 数据上报给 Hub 的运行时，但 `opencode-cli` 运行时只接受
**精确配对**的 agent-node。实测把全局升到 `.183` 后 `anet node start` 直接拒绝启动：

```text
[anet] Incompatible agent-node for opencode-cli.
[anet] No exact trusted global @sleep2agi/agent-node@2.5.0-preview.182 is available ...
```

也就是说常量不动，`.183` 在 opencode-cli 节点上永远跑不起来（这正是本轮节点一度离线的直接原因）。

## What changed

```text
agent-network/src/opencode-agent-node-pair.ts
  PAIRED_AGENT_NETWORK_VERSION  2.3.0-preview.216 → 2.3.0-preview.217
  PAIRED_AGENT_NODE_VERSION     2.5.0-preview.182 → 2.5.0-preview.183

agent-network/package.json / package-lock.json   版本同步到 2.3.0-preview.217
docs-site/docs{,/en}/guide/getting-started.md   version-claim 同步 + 说明这一版只改配对
```

## Upgrade order（重要）

先装 agent-node，再装 agent-network，最后重启节点：

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.183
npm i -g @sleep2agi/agent-network@2.3.0-preview.217
anet node stop <alias> && anet node start <alias>
```

顺序反了会被配对闸门拦住，不会跑出一个「版本对不上」的进程。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.217 @sleep2agi/agent-node@2.5.0-preview.183
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.183
npm i -g @sleep2agi/agent-network@2.3.0-preview.217
```

重启节点后才有意义：agent 列表与当前会话 agent 是节点启动后按周期上报的。

## What it does not do

- 不改任何命令行为，只搬配对常量
- 不做 agent 切换（客户端仍只读）
- 不改变模型目录 `opencode_catalog` 的口径

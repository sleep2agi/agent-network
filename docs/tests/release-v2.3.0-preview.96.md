# `@sleep2agi/agent-network@2.3.0-preview.96`

## 为什么发这一版:配对 agent-node .72(#1912 opencode 共存回件所有权)

`.95` 之后 `agent-network/bin|src` **没有**功能提交;本版只把配对常量升到 `2.5.0-preview.72`(`src/opencode-agent-node-pair.ts`),否则 published-pins 门会在 agent-node .72 发出后每天红(agent-node 与 anet 必须同日配对发)。

| PR | 内容 |
|---|---|
| #1912(agent-node 侧) | opencode-cli 共存回件所有权按 parent 链验证 + 拒绝时保留回答原文(#1910);本包只带配对号 |

## 这一版带给用户什么

- 新装 / `anet node create --runtime opencode-cli` 默认拉 agent-node .72;`.95` 配 `.71` 的机器升级后 opencode 节点才会用上 #1912。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.96
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.96 @sleep2agi/agent-node@2.5.0-preview.72
anet node stop <name> && anet node start <name> --copresence   # opencode 共存节点重启才加载 .72
```

## 边界

- `agent-network` 自身行为与 `.95` 逐字相同;只有配对常量与文档版本戳变化。

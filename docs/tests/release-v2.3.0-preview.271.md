# agent-network (CLI) 2.3.0-preview.271

与 `@sleep2agi/agent-node` **2.5.0-preview.235** 精确配对。配套 Hub `0.9.0-preview.305`。

## Why

- **只更新配对常量**：`PAIRED_AGENT_NODE_VERSION` 指到 `2.5.0-preview.235`，让新装用户拿到的 CLI 自带会回 `interrupted` 的 node（`#3914`）—— 否则 App 点「停止」仍可能卡「已发送，节点未确认（可能仍在跑）」，直到超时。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.271 @sleep2agi/agent-node@2.5.0-preview.235
```

## Upgrade

```bash
anet pair     # 应显示 2.3.0-preview.271 / 2.5.0-preview.235
anet upgrade
```

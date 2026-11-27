# agent-network (CLI) 2.3.0-preview.272

与 `@sleep2agi/agent-node` **2.5.0-preview.236** 精确配对。配套 Hub `0.9.0-preview.306`。

## Why

- **只更新配对常量**：`PAIRED_AGENT_NODE_VERSION` 指到 `2.5.0-preview.236`，让新装用户拿到的 CLI 自带「停止后回『已按要求停止。』」的 node（`#5392`），并且 ACP 取消只绑定在飞的 prompt（`#3922`）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.272 @sleep2agi/agent-node@2.5.0-preview.236
```

## Upgrade

```bash
anet pair     # 应显示 2.3.0-preview.272 / 2.5.0-preview.236
anet upgrade
```

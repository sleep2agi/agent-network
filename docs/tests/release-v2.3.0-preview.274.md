# agent-network (CLI) 2.3.0-preview.274

与 `@sleep2agi/agent-node` **2.5.0-preview.238** 精确配对。配套 Hub `0.9.0-preview.311`+。

## Why

- **只更新配对常量**：`PAIRED_AGENT_NODE_VERSION` 指到 `2.5.0-preview.238`（`claude-code` 通道直传 + 下载流式写盘，`#3954`）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.274 @sleep2agi/agent-node@2.5.0-preview.238
```

## Upgrade

```bash
anet pair     # 应显示 2.3.0-preview.274 / 2.5.0-preview.238
anet upgrade
```

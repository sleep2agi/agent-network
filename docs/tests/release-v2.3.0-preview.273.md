# agent-network (CLI) 2.3.0-preview.273

与 `@sleep2agi/agent-node` **2.5.0-preview.237** 精确配对。配套 Hub `0.9.0-preview.307`。

## Why

- **只更新配对常量**：`PAIRED_AGENT_NODE_VERSION` 指到 `2.5.0-preview.237`，让新装用户拿到的 CLI 自带密钥热生效（`#5675` PR-3 Phase-1）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.273 @sleep2agi/agent-node@2.5.0-preview.237
```

## Upgrade

```bash
anet pair     # 应显示 2.3.0-preview.273 / 2.5.0-preview.237
anet upgrade
```

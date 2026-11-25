# @sleep2agi/agent-network (CLI) 2.3.0-preview.270

与 `@sleep2agi/agent-node` **2.5.0-preview.234** 精确配对（`PAIRED_AGENT_NODE_VERSION`）。本版 CLI 自身无改动，只更新配对；配套 Hub `0.9.0-preview.301`。

## Why

- **配对更新**：指向 `agent-node@2.5.0-preview.234`，包含：
  - **Antigravity 节点换模型不再重启（`#3889`）**：只改模型时节点就地切换，不掉线、会话保留。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.270 @sleep2agi/agent-node@2.5.0-preview.234
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.234
anet upgrade
```

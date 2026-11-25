# @sleep2agi/agent-network (CLI) 2.3.0-preview.264

与 `@sleep2agi/agent-node` **2.5.0-preview.230** 精确配对（`PAIRED_AGENT_NODE_VERSION`）。

## Why

- **配对更新**：指向 `agent-node@2.5.0-preview.230`（含 `#3869` agy models Tab 解析修复与 `#3871` 心跳 `secret_keys` 读取 `node-secrets.json` 键名）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.264 @sleep2agi/agent-node@2.5.0-preview.230
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.230
anet upgrade
```

# @sleep2agi/agent-network (CLI) 2.3.0-preview.258

与 `@sleep2agi/agent-node` **2.5.0-preview.224** 精确配对（`PAIRED_AGENT_NODE_VERSION`）。

## Why

CLI 本版无功能改动；升号是为了让 `anet pair` 装出 `.224` 节点（配对钉在 `agent-network/src/opencode-agent-node-pair.ts`）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.258 @sleep2agi/agent-node@2.5.0-preview.224
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.224
anet upgrade
```

# @sleep2agi/agent-network (CLI) 2.3.0-preview.268

与 `@sleep2agi/agent-node` **2.5.0-preview.233** 精确配对（`PAIRED_AGENT_NODE_VERSION`）。本版 CLI 自身无改动，只更新配对；Hub 仍为 `0.9.0-preview.299`。

## Why

- **配对更新**：指向 `agent-node@2.5.0-preview.233`，包含：
  - **会话交接时说清 OpenCode 为什么被拒（`#3890`）**：节点日志写明 CLI 给出的拒绝原因（`[source-resume] child refused because: …`），不再只有 `source_resume_cli_version_refused`。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.268 @sleep2agi/agent-node@2.5.0-preview.233
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.233
anet upgrade
```

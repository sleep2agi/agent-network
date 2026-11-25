# @sleep2agi/agent-network (CLI) 2.3.0-preview.266

与 `@sleep2agi/agent-node` **2.5.0-preview.232** 精确配对（`PAIRED_AGENT_NODE_VERSION`）。

## Why

- **OpenCode 共存节点密钥安全卡片规则对齐（`#3882`）**：OpenCode 共存节点（`renderOpenCodeCommhubInstructions`）与 Claude 路径一致，索要密钥必须走安全卡片 `request_secret`，不让用户把密钥写进文件。
- **配对更新**：指向 `agent-node@2.5.0-preview.232`，包含：
  - **同机同名节点防双开（`#3879`）**：通过 `agent-node.lock` 拦截重复启动并给出持有 PID 与 `anet node stop` 指引；崩溃遗留锁自动回收；Windows 符号链接 fail-closed。
  - **密钥安全卡片引导（`#3880`）**：所有 AI 索要密钥必须走 `request_secret` 卡片，不再要求用户把密钥写进文件。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.266 @sleep2agi/agent-node@2.5.0-preview.232
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.232
anet upgrade
```

# agent-node 2.5.0-preview.232

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.266** 精确配对。

## Why

- **同机同名节点防双开（`#3879`）**：引入 `agent-node.lock`（Layer 1），同一台机器上对同一节点第二次启动直接拒绝，并明确提示持有锁的 PID 与 `anet node stop` 处理方式；崩溃遗留锁自动回收；Windows 上符号链接 fail-closed。
- **密钥收集统一走卡片 `request_secret`（`#3880` / `#3882`）**：在节点提示词中明确要求所有 AI 运行时索要密钥必须通过安全卡片 `request_secret`，不许让用户把密钥粘贴或写进文件（配对 CLI `.266` 同步让 OpenCode 共存节点与 Claude 路径一致，索要密钥必须走安全卡片）。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.232 @sleep2agi/agent-network@2.3.0-preview.266
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.232
anet upgrade
```

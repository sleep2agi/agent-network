# agent-node 2.5.0-preview.231

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.265** 精确配对。

## Why

- **修复 Antigravity 节点上报 `session_id` 滞后（`#3873`）**：`register()` 与 `reportStatus()` 通过 `resolveReportedSessionId` 对 `antigravity` 上报实时进程内 `agySessionId`，不再停留在启动时的旧 `SESSION_ID`。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.231 @sleep2agi/agent-network@2.3.0-preview.265
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.231
anet upgrade
```

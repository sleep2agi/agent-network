# @sleep2agi/agent-network (CLI) 2.3.0-preview.267

与 `@sleep2agi/agent-node` **2.5.0-preview.232** 精确配对（`PAIRED_AGENT_NODE_VERSION`，未变）。本版只发 CLI：自 `.266` 以来 `server/`、`agent-node/` 无改动，Hub 仍为 `0.9.0-preview.299`。

## Why

- **OpenCode 节点「新开对话」生效（`#3886`）**：`anet node start <名字> --new-session` 以前在 OpenCode 共存节点上被静默丢掉，节点照样恢复旧会话；现在真的开新对话。
- **停止提示不再误报（`#3887`）**：`anet node stop` 停掉 OpenCode 共存节点后，打印「Stopped …」，不再显示「not running locally」。只改提示，停止行为不变。
- **测试二进制被拒时说明原因（`#3878`）**：source resume 的 OpenCode 测试二进制被拒时，日志写明是哪一项检查（平台 / 路径 / sha256 / 版本）没过。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.267 @sleep2agi/agent-node@2.5.0-preview.232
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.232
anet upgrade
```

# agent-node 2.5.0-preview.235

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.270** 配对；CLI `2.3.0-preview.271` 起精确配对到本版本。配套 Hub `0.9.0-preview.305`。

## Why

- **停止按钮能被 App 认账（`#3914`）**：所有 runtime 的打断回执都带上 `interrupted: true/false`（Antigravity / Grok ACP 看 `active-turn.ts`、Claude 看 `cli.ts`、Codex App-Server 看 `codex-app-server-bridge.ts`），与 OpenCode 回执和 App 的 `replyProvesInterrupted` 判定对齐。以前只有 OpenCode 带这个字段，其它 runtime 点「停止」后 App 分不清「已停」和「节点还在跑」，只能等超时并提示「已发送，节点未确认（可能仍在跑）」。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.235 @sleep2agi/agent-network@2.3.0-preview.270
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.235
anet upgrade
```

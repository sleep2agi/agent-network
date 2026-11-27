# agent-node 2.5.0-preview.236

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.271** 配对；CLI `2.3.0-preview.272` 起精确配对到本版本。配套 Hub `0.9.0-preview.306`。

## Why

- **用户点停止后不再显示成模型错误（`#5392`）**：凡是因为我们自己的停止请求中止的那一轮，统一回「已按要求停止。」（有部分文本就附上「停止前已产出：…」），不再按错误上报；超时（`TimeoutError` / `opencode_copresence_timeout`）与上游断开仍按错误报。所有 runtime 通用：OpenCode、Codex App-Server、Claude、Antigravity ACP、Grok ACP。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.236 @sleep2agi/agent-network@2.3.0-preview.271
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.236
anet upgrade
```

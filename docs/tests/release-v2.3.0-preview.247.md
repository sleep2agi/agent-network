# agent-network (CLI) 2.3.0-preview.247

与 `@sleep2agi/agent-node` **2.5.0-preview.213** 精确配对。

## Why

只改配对常量：指向 agent-node `2.5.0-preview.213`（该运行时接了 `#4821` 的 daemon 侧会话列表 bridge）。
CLI 本体与 `.246` 一致（`anet pair` 的 Node 版本提示已在 `.246` 收口）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.247 @sleep2agi/agent-node@2.5.0-preview.213
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

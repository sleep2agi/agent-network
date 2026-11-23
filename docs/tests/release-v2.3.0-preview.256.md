# agent-network (CLI) 2.3.0-preview.256

与 `@sleep2agi/agent-node` **2.5.0-preview.222** 精确配对。

## Why

只改配对常量：指向 agent-node `2.5.0-preview.222`（claude / codex-app-server / ACP 三类运行时的「停止」与能力位）。CLI 本体与 `.255` 一致。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.256 @sleep2agi/agent-node@2.5.0-preview.222
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

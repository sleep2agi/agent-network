# agent-network (CLI) 2.3.0-preview.255

与 `@sleep2agi/agent-node` **2.5.0-preview.221** 精确配对。

## Why

只改配对常量：指向 agent-node `2.5.0-preview.221`（回合控制能力位 + agy 98KB 重放修复）。CLI 本体与 `.254` 一致。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.255 @sleep2agi/agent-node@2.5.0-preview.221
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

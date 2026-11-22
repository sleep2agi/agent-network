# agent-network (CLI) 2.3.0-preview.251

与 `@sleep2agi/agent-node` **2.5.0-preview.217** 精确配对。

## Why

只改配对常量：指向 agent-node `2.5.0-preview.217`（节点开始上报 workdir）。CLI 本体与 `.250` 一致。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.251 @sleep2agi/agent-node@2.5.0-preview.217
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

# agent-network (CLI) 2.3.0-preview.250

与 `@sleep2agi/agent-node` **2.5.0-preview.216** 精确配对。

## Why

只改配对常量：指向 agent-node `2.5.0-preview.216`（浏览器能力修正版：`get text body`、参数每条都带、不再主动 close）。CLI 本体与 `.249` 一致。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.250 @sleep2agi/agent-node@2.5.0-preview.216
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

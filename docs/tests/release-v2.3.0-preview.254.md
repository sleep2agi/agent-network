# agent-network (CLI) 2.3.0-preview.254

与 `@sleep2agi/agent-node` **2.5.0-preview.220** 精确配对。

## Why

只改配对常量：指向 agent-node `2.5.0-preview.220`（agy 上报模型清单与登录状态）。CLI 本体与 `.253` 一致。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.254 @sleep2agi/agent-node@2.5.0-preview.220
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

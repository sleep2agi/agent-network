# agent-network (CLI) 2.3.0-preview.252

与 `@sleep2agi/agent-node` **2.5.0-preview.218** 精确配对。

## Why

只改配对常量：指向 agent-node `2.5.0-preview.218`（OpenCode V2 思考档位持久化，`#5123`）。CLI 本体与 `.251` 一致。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.252 @sleep2agi/agent-node@2.5.0-preview.218
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

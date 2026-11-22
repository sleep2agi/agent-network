# agent-network (CLI) 2.3.0-preview.248

与 `@sleep2agi/agent-node` **2.5.0-preview.214** 精确配对。

## Why

只改配对常量：指向 agent-node `2.5.0-preview.214`（agy 版本按建议处理不再 throw + 会话回放去前缀）。CLI 本体与 `.247` 一致。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.248 @sleep2agi/agent-node@2.5.0-preview.214
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

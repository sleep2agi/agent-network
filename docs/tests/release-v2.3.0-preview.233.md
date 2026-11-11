# agent-network 2.3.0-preview.233

Since `.232`: 只改配对常量，指向 agent-node `2.5.0-preview.201`（fork 到新目录：OpenCode 共享 serve 节点修复）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.233 @sleep2agi/agent-node@2.5.0-preview.201
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-node `2.5.0-preview.201` 精确配对。

## What it does not do

- CLI 侧没有任何行为变化，只改配对常量

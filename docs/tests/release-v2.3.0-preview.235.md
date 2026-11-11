# agent-network 2.3.0-preview.235

Since `.234`: 指向 agent-node `2.5.0-preview.203`；`anet node start` 等 OpenCode 共存 bridge 就绪的时限 30s → 90s。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.235 @sleep2agi/agent-node@2.5.0-preview.203
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-node `2.5.0-preview.203` 精确配对。

## What it does not do

- 不改节点配置；只放宽启动等待时限

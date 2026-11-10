# agent-network 2.3.0-preview.231

Since `.230`: 只改配对常量，指向 agent-node `2.5.0-preview.199`（daemon 接管按凭证证明同一 Hub，#3488）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.231 @sleep2agi/agent-node@2.5.0-preview.199
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-node `2.5.0-preview.199` 精确配对。

## What it does not do

- CLI 侧没有任何行为变化，只改配对常量

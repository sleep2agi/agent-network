# @sleep2agi/agent-network 2.3.0-preview.209

Since `.208`: 配对常量指向 agent-node `2.5.0-preview.177`（飞书队列的 /q /cancel /prio）。

## What changed

- `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.177`
- 无其它行为改动（`.208` 已带桥侧的队列提示与上下文渲染）

## Verification

```text
feishu 目录 45 pass · bun build bin/cli.ts 通过
```

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.209
```

## Upgrade

```bash
anet upgrade
anet node restart <name>
```

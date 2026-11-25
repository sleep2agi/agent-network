# @sleep2agi/agent-network (CLI) 2.3.0-preview.269

与 `@sleep2agi/agent-node` **2.5.0-preview.233** 精确配对（`PAIRED_AGENT_NODE_VERSION`，未变）。配套 Hub `0.9.0-preview.300`。

## Why

- **「叫醒式回复」不再被误报（`#3893`）**：对方节点收不了原子回复时，频道会用一条叫醒任务把回复送达并关闭原任务。现在这条叫醒任务带上 `meta.peer_reply_wake`，配合 Hub `.300`，发送方不会再在一小时后收到「任务可能没人收尾」的误报。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.269 @sleep2agi/agent-node@2.5.0-preview.233
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.233
anet upgrade
```

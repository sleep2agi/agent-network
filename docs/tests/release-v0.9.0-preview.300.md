# commhub-server 0.9.0-preview.300

Since `.299`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.300
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.300
```

## What changed

```text
#3893：孤儿巡检不再误报「叫醒式回复」。对方节点收不了原子回复时，回复会以一条叫醒任务送达
（meta.peer_reply_wake），这条任务没人欠回话；巡检仍记一条事件（不会反复进入批次），但不再提醒发送方
「任务可能没人收尾」。与 agent-network@2.3.0-preview.269 / agent-node@2.5.0-preview.233 同步发版。
```

## Verified

```text
server/src/task-orphan-http.test.ts 新增用例：旧巡检 8/9、修复后 9/9；#3893 合入 main c832147b，68 项检查全绿。
```

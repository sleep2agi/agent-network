# agent-node 2.5.0-preview.206

Since `.205`：修好 **control 消息的唤醒**。`.205` 已经能处理 `inbox.type=control`，但 copresence 的
SSE 分派只唤醒「信息通道」（只排空 `type=message`），工作通道又只在 `new_task`/`broadcast` 时唤醒
⇒ control 行两条 lane 都不收（实测：节点回合进行中发出，回合结束后仍 `acked=0`，节点再没取过）。
现在带 `control` 的 `new_message` 也会唤醒工作通道。

## Why

停止一个正在跑的回合，需要一条「不吃任务生命周期」的指令通道。用 inbox 是因为 ack / 重投 / SSE
都已经在；缺的只是让这条 control 行进得去工作通道。实测两次失败都在这里，不是内核不支持
（内核 `POST /api/session/<id>/interrupt` 返回 `{"interrupted":true|false}`）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.238 @sleep2agi/agent-node@2.5.0-preview.206
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-network `2.3.0-preview.238` 精确配对。

## 判据

- 节点在跑长回合时 `send_message(alias, control="interrupt")` → control 行**数秒内被 ack**；
- 节点回执 `{ok:true, interrupted:true}`，该轮输出被截断（不再跑完整任务）；
- 无在飞回合时 → `interrupted:false`（不算错误，也不重放）。

## What it does not do

- 不改已有节点的配置、不重启已运行节点；
- 不做「无缝插话（steering）」——内核在这个 API 面上不支持运行中注入，实测运行中发的 prompt
  只是排队到下一轮；现实版是「先 interrupt 再以新指令开新一轮」。

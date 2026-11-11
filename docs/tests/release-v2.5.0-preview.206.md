# agent-node 2.5.0-preview.206

Since `.205`：**修好 control 消息的唤醒**。`.205` 已经能处理 `inbox.type=control`，
但 copresence 的 SSE 分派只唤醒「信息通道」（只排空 `type=message`），工作通道又只在
`new_task`/`broadcast` 时唤醒 ⇒ control 行两条 lane 都不收（实测：回合进行中发出，
回合结束后仍 `acked=0`，节点再没取过）。现在带 `control` 的 `new_message` 也会唤醒工作通道。

安装（精确配对）：

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.238 @sleep2agi/agent-node@2.5.0-preview.206
```

⚠️ 与 CLI `2.3.0-preview.238` 精确配对（`anet pair` 为权威）。

判据：
- 节点在跑长回合时 `send_message(alias, control="interrupt")` → control 行**数秒内被 ack**；
- 节点回执 `{ok:true, interrupted:true}`，该轮输出被截断（不再跑完整任务）；
- 无在飞回合时 → `interrupted:false`（不算错误）。

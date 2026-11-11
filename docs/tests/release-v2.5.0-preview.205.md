# agent-node 2.5.0-preview.205

Since `.204`：**新增 `control` 控制消息**——Hub 发来 `inbox.type=control` 且 `content={"op":"interrupt"}`
时，节点调内核 `POST /api/session/<sid>/interrupt` 并把 `{ok, interrupted, reason}` 作为回执发回，
**不会**把这条消息当成任务跑一轮；未知 op 记日志并 ack。这是「停止当前轮」的节点侧那一半。

安装（精确配对）：

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.237 @sleep2agi/agent-node@2.5.0-preview.205
```

⚠️ 与 CLI `2.3.0-preview.237` 精确配对（`anet pair` 为权威）。

判据：
- 节点在跑长回合时，Hub 侧 `send_message(alias, control="interrupt")` → 节点回执 `{ok:true, interrupted:true}`；
- 无在飞回合时同一调用 → `interrupted:false`（不算错误）；
- 未知 op（例如以后加别的控制）→ 只记日志 + ack，绝不开始回合。

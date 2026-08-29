# @sleep2agi/commhub-server 0.9.0-preview.40 — release notes

这一版是 daemon batch 的 hub 侧三条，主题是**「报告的状态要等于真实发生的事」**。

- **#1448 f1 — stop/start/delete 门铃加 SSE 重连补偿**（PR #1450）。门铃是纯 live 扇出：
  daemon 在重连窗口里错过的门铃事件此前无从补投。现在按 pending-unacked 补投，
  daemon 重连后能拿到窗口期内错过的指令。
- **start_node 加 stale-starting reaper**（PR #1456）。此前卡在 `starting` 的节点行没有
  收敛路径，会一直占着状态；现在与 config-apply 对齐，超时后回收。
- **`send_desktop_message` 不再谎报成功**（PR #1460）。它只写 `audit_log`、不写 inbox，
  而 `pushUserEvent` 在用户没有订阅者时静默返回，`/api/messages` 又只读 inbox ——
  用户 dashboard 关着时消息永久丢，调用方却拿到 `ok:true`。
  现在返回值带 `delivered`（取自订阅者注册表，不是假设），为 false 时附
  `reason: "no_live_subscriber"`。

🔴 **本版只让丢失可见，没让它不发生。** desktop message 的持久化 + 重连补投（按 `user_id`
寻址的新收件表）是下一步，见 #1459。`reason` 取的是**观测到的事实**而不是它的后果，
所以持久化落地后同一个字段可以细分（lost vs queued），不必改写历史响应的含义。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.64 @sleep2agi/agent-node@2.5.0-preview.49
anet hub start
```

hub 自己由 `anet` 按 `PINNED_SERVER_VERSION` 拉起（本版 `0.9.0-preview.40`），
通常不需要单独装 `@sleep2agi/commhub-server@0.9.0-preview.40`。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.64
anet hub restart
curl -fsS http://127.0.0.1:9200/health
```

🔴 别只看进程起来了 —— `/health` 返回才证明它在响应。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1450 | #1448 f1 | stop/start/delete 门铃 SSE 重连补偿 |
| #1456 | — | start_node stale-starting reaper，对齐 config-apply |
| #1460 | #1459 | `send_desktop_message` 返回真实投递态 |

未包含：#1464（#1448 findings 4-6）在本版切版时尚未合入 main，走 fast-follow。

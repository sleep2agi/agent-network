# Agent 怎么回复才能显示在 Dashboard 聊天窗口

你从 Dashboard 给节点发消息后，节点的回复**只有触发 `new_reply` SSE 事件**才会出现在
Dashboard 聊天窗口。**会不会触发取决于 status**——交互式/协调型 session 最容易在这栽跟头。

## 规则

用 **`commhub_reply(task_id, text, status="completed")`** 回——status 必须是**终态**。

| status | 内部走的调用 | `new_reply` SSE | Dashboard 聊天显示 |
|---|---|---|---|
| `completed` / `failed` / `cancelled`（终态） | `send_reply` | ✅ 发 | ✅ 实时显示 |
| `in_progress` / `blocked` / `error`（非终态） | `report_status` | ❌ 不发 | ❌ 不显示 |

也就是说：用 `status="in_progress"` 发进度，**Dashboard 聊天里静默看不见**——它只更新会话状态行，即使调用返回 ok。

## 按 runtime 分

- **claude-code-cli / claude-agent-sdk / codex-sdk / grok-build-acp / opencode-cli**：
  agent-node 在任务完成时自动用终态回（`send_reply`），Dashboard 自动能看到。
- **codex-app-server**（RFC-030）：用 `send_task` 回（立即 SSE 唤醒），同样能显示。
- **交互式 / 协调型 session**（claude CLI 或 codex TUI 直接驱动 CommHub）：**必须手动**用
  `commhub_reply` + `status="completed"` 才能回进 Dashboard。用非终态会走 `report_status`，
  回复永远不显示——哪怕调用返回 ok。

## 推广：想让任何一方「立刻看到」你的消息

不止 Dashboard——**给协调者/其他 agent 会话发消息**也是同一套语义。实测（2026-07-16）：
- `send_task` → **推送**，对方会话立刻收到 ✅
- `commhub_reply` + 终态 status → 推送（见上表）✅
- `send_ack` / `send_message` / 非终态 reply → **不推送**——调用返回 ok、任务状态也变了，但对方**看不到**，
  只能事后 poll。真实翻车：执行者用 send_ack 应答派工，协调者两轮催单误判其"无响应"。

**一句话规则：要对方立刻看到 = send_task 或终态 commhub_reply，其余一律当作"只写库不通知"。**

补充（同日多次实测）：**commhub_reply 的 task_id 窗口会过期**——回复稍晚就报 `reply_task_not_found`（600s 窗口关闭）。遇到别重试 reply，**直接 send_task 补发**；耗时长的任务从一开始就用 send_task 回。

## 「任务超时（600s 内无最终回复）」自动回复 ≠ 节点死了

busy 节点（如 codex-app-server 单线程 turn）收到新任务会**排队**（日志：`queued (a turn is in flight)`），排满 600s 就自动回一条「codex-app-server 错误: 任务超时」。**这条超时经常只是排队溢出**——节点可能正健康地跑着一个几小时的大 turn。真实翻车（2026-07-16）：协调者据此差点重启一个正在跑关键任务的节点，capture-pane 才发现它活得好好的。

**判死活标准动作**：先 `tmux capture-pane` 看终端实况 + 查 hub 心跳（updated_at 新鲜=活），**别只凭超时消息下结论**。改进方向（候选）：hub/runtime 把"排队中"与"真超时"区分回复。

### Codex TUI 共存节点的 Dashboard 消息

服务端鉴权为用户的 Dashboard chat 在人类 TUI 已有 active turn 时，会通过
`turn/steer(expectedTurnId)` 追加到该 turn；普通 agent 任务仍在 FIFO 等待，不会注入人的 turn。
同一 active turn 内快速发送的多条 Dashboard 消息共享该 turn 的最终答案。

桥的 inbox admission 最多同时保留 20 个 Codex handler（等于一个 `get_inbox` 页面）。第 21 条及以后
不会丢弃：先在本地 FIFO 等待，任一 handler 结束后自动继续，并重新读取 Hub 以越过前 20 条未 ack
记录。这个并发只表示“同时进入桥的仲裁”，**不表示向同一 Codex thread 并发发多个 `turn/start`**：
bridge 的同步 `turnClaimed` 和 FIFO 仍保证普通 network task 一次只启动一个 turn。只有已由实时事件证明
属于人类的 active turn，鉴权 Dashboard chat 才会走 `turn/steer`。

因此要区分两种“收到”：人类 TUI turn 中的 Dashboard chat 会立即 `turn/steer` 进当前轮；bridge 自己
已有 network task turn 时，新 task 会被立即从 Hub 取走、进入 bridge FIFO，但仍须等前一轮 terminal
后才能 `turn/start`。本修复消灭的是“后续 SSE 根本不再读取、白等首轮 600 秒”，不是把 Codex 的单
turn FIFO 变成并行推理。当前 600 秒任务计时仍包含排队时间；前一轮本身超过该窗口时，后续 FIFO task
仍可能以超时结束，这是独立的 queue-deadline 语义，不应把日志里出现 `processing` 单独当成回复闭环。

多条 Dashboard chat steer 到同一个人类 turn 时，它们共同取得该 turn 的最终答案，不是多条独立模型
请求；在 terminal 与 steer 回执竞态下，各 task 的回复落库先后不作保证。若业务依赖严格逐条顺序和独立
答案，应等当前 turn 结束后逐条发送，让它们走 FIFO turn。

可靠回复队列目前也和 Codex active handler 共用安全门：只要仍有 handler 在 bridge FIFO/turn 中等待，
durable pending reply 暂不 drain，以避免和该 handler 的直接 send/clear 重复发送。进程重启仍会恢复
该队列；将它拆成独立 singleflight lane 是后续优化，不属于“Dashboard 入站未读取”的修复。

这是“同一个用户、同一个会话”的即时补充能力，不是独立并行对话：如果人正在 TUI 里处理另一件事，
Dashboard 补充内容会和当前上下文一起影响最终答案。需要完全隔离时，应等当前 turn 结束再发送。
Hub 只信服务端依据 token 写入的 `auth_origin`；客户端自填 `auth_origin=user` 不会获得 steer 权限。
升级前已入库、没有该服务端标记的消息按普通 FIFO 处理，不用 `from_session=admin` 猜测身份。
桥重连时会从 `thread/read` 恢复 active turn；只有首条持久化 user input 能证明是人类 turn 才可 steer，
旧 bridge 启动的 network turn 或来源不明的 active turn 一律 FIFO。
Codex 0.133 实测 active history 可能不含 `userMessage`；这种重连不会猜测为人类，需等当前 turn
结束。桥保持在线后，下一次实时 `turn/started` 会恢复正常即时 steer。

这里的“无 `[Agent Network/…]` 前缀 = 当作人类”只是默认行为，不是身份识别能力。不要声称桥能识别
任意旧版或外部创建、且没有该前缀的 network turn；当前安全性依赖 Phase 0A 以来本桥始终添加该前缀，
不是 Codex app-server 协议提供的来源保证。

## 用了终态还是不显示？

那通常是**生产层传输**问题（浏览器侧 HTTP/2、或 SSE 代理被 buffer/掐掉），不是回复本身。
hub 发 `new_reply` 是毫秒级的；先确认浏览器对 `/api/hub/events` 有活的 SSE 连接。

## 代码依据

- `server/src/tools.ts` —— `send_reply` 处理器发 `pushEvent(alias, { type: "new_reply", in_reply_to, status }, ...)`。
- `agent-network/src/node-server.ts` —— `commhub_reply` 工具：终态 → `send_reply`，非终态 → `report_status`。
- Dashboard `TaskChatPanel` —— `useSSE({ url: '/api/hub/events' })`，收到 `type === 'new_reply'` 按 `in_reply_to` 刷新任务。

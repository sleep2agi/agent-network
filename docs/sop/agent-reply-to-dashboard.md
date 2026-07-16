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

## 用了终态还是不显示？

那通常是**生产层传输**问题（浏览器侧 HTTP/2、或 SSE 代理被 buffer/掐掉），不是回复本身。
hub 发 `new_reply` 是毫秒级的；先确认浏览器对 `/api/hub/events` 有活的 SSE 连接。

## 代码依据

- `server/src/tools.ts` —— `send_reply` 处理器发 `pushEvent(alias, { type: "new_reply", in_reply_to, status }, ...)`。
- `agent-network/src/node-server.ts` —— `commhub_reply` 工具：终态 → `send_reply`，非终态 → `report_status`。
- Dashboard `TaskChatPanel` —— `useSSE({ url: '/api/hub/events' })`，收到 `type === 'new_reply'` 按 `in_reply_to` 刷新任务。

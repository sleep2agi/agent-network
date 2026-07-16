# How agents reply so it shows in the Dashboard chat

When you send a message to a node from the Dashboard, the node's reply only appears
in the Dashboard chat window if it triggers a `new_reply` SSE event. **Whether it
does is status-dependent** — this trips up interactive/coordinator sessions.

## The rule

Reply with **`commhub_reply(task_id, text, status="completed")`** — a *terminal* status.

| status | internal call | `new_reply` SSE | shows in Dashboard chat |
|---|---|---|---|
| `completed` / `failed` / `cancelled` (terminal) | `send_reply` | ✅ emitted | ✅ yes (real-time) |
| `in_progress` / `blocked` / `error` (non-terminal) | `report_status` | ❌ not emitted | ❌ no |

So a progress update sent as `status="in_progress"` will **silently not appear** in
the Dashboard chat — it only updates the session status row.

## Per-runtime

- **claude-code-cli / claude-agent-sdk / codex-sdk / grok-build-acp / opencode-cli**:
  agent-node auto-replies with a terminal status (`send_reply`) when the task finishes,
  so replies surface in the Dashboard automatically.
- **codex-app-server** (RFC-030): replies via `send_task` (immediate SSE wake), which
  also surfaces.
- **Interactive / coordinator sessions** (a claude CLI or codex TUI session driving
  CommHub directly): you must use `commhub_reply` with `status="completed"` to reply
  into the Dashboard. A non-terminal status routes to `report_status` and the reply
  never shows — even though the call returns `ok`.

## If replies still don't show

If you use a terminal status and the reply still doesn't appear, the cause is usually
**transport** at the prod layer (HTTP/2 to the browser, or the SSE proxy being
buffered/stripped), not the reply itself. The hub emits `new_reply` in milliseconds;
confirm the browser has a live SSE connection to `/api/hub/events`.

## Verified against

- `server/src/tools.ts` — the `send_reply` handler emits `pushEvent(alias, { type: "new_reply", in_reply_to, status }, ...)`.
- `agent-network/src/node-server.ts` — the `commhub_reply` tool routes terminal status → `send_reply`, non-terminal → `report_status`.
- Dashboard `TaskChatPanel` — `useSSE({ url: '/api/hub/events' })` refetches the task on `type === 'new_reply'` keyed by `in_reply_to`.

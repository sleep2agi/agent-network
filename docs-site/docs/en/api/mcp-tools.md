# MCP Tools Reference

CommHub Server registers ~40 MCP Tools in total; this page documents the 17 core tools agents use most for day-to-day collaboration (the rest are node-management, provider-config, and other ops tools). All are called via the `POST /mcp` (Streamable HTTP) endpoint.

## Tool Categories

| Group | Count | Purpose |
|------|------|------|
| Agent-side tools | 4 | Status reporting, message retrieval |
| Task management tools | 7 | Send tasks, reply, retry, cancel, reassign |
| Query tools | 5 | Query task detail, task list, status, completions |
| Broadcast tools | 1 | Broadcast to all agents |

---

## Agent-Side Tools

### report_status

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L88)

Report agent status. Also serves as a heartbeat (recommended every 3 minutes).

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `resume_id` | string | &check; | Session unique identifier (max 200 chars) |
| `alias` | string | &check; | Display name (max 200 chars) |
| `status` | enum | &check; | `working` / `idle` / `blocked` / `error` / `waiting_input` / `offline` |
| `task` | string | | Current task description (max 10000 chars) |
| `output` | string | | Recent output (max 50000 chars, storage truncated to 4000) |
| `score` | number | | Self-rating **0-10** (doc previously said 1-10; schema is actually `.min(0).max(10)`) |
| `progress` | number | | Progress 0-100 |
| `server` | string | | Server identifier |
| `hostname` | string | | Hostname |
| `agent` | string | | Agent type (free-form string for audit; agent-node actually sends `agent-node:<runtime>` — e.g. `agent-node:claude-agent-sdk` / `agent-node:codex-sdk` / `agent-node:claude-code-cli`; the Claude Code MCP wrapper sends `claude-code`; other clients fill freely) |
| `project_dir` | string | | Working directory |
| `version` | string | | Agent version |
| `tmux_name` | string | | tmux session name |
| `node_id` | string | | Stable node identifier. **Note**: passing `node_id` is required to upsert `model` / `node_name` / `runtime` (parsed from the `agent` field) into the `nodes` table ([`tools.ts:168-188`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L168)). The `model` parameter itself does **not** depend on `node_id` — `report_status`'s `sessions` upsert unconditionally writes `sessions.model = COALESCE(model, old)` ([`tools.ts:129` INSERT + `tools.ts:141` ON CONFLICT](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L129)); only `node_name` has no `sessions` column and must go through the `nodes` table via `node_id`. |
| `session_id` | string | | Runtime session/thread ID |
| `config_path` | string | | Config file path |
| `channels` | string | | Channel list (JSON array string) |
| `model` | string | | AI model name (written to `nodes.model` only when `node_id` is also passed) |
| `node_name` | string | | Node display name (written to `nodes.node_name` only when `node_id` is also passed) |
| `network_id` | string | | Network ID |

**Response**:

```json
{
  "ok": true,
  "resume_id": "sdk-n_a1b2c3d4",
  "alias": "coder-1",
  "inbox_count": 3
}
```

**Example**:

```typescript
report_status({
  resume_id: "sdk-n_a1b2c3d4",
  alias: "coder-1",
  status: "working",
  task: "Writing sorting algorithm",
  progress: 50,
  model: "your-model-id",
  agent: "agent-node:codex"
})
```

::: warning Authentication required
This tool only accepts a **`ntok_` (network-scoped) token**. Calling with `utok_` (user-scoped) returns `{ok: false, error: "network_token_required"}` ([`tools.ts:116-118`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L116)). This is a hard constraint after RFC-001 in v0.8 — agent heartbeats must be bound to a network.

Side effects beyond the `sessions` table:
- Automatically DELETEs any older session row with the same network + alias + a different `resume_id` ([`tools.ts:127`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L127); cleans up orphans across agent restarts)
- When `status="working"` with a `task`, transitions the corresponding `tasks` row from `delivered`/`acked` to `running` ([`tools.ts:150-153`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L150); see [Task lifecycle](/en/concepts/task-lifecycle#state-machine))
- When `node_id` is passed, upserts the `nodes` table (including `model` / `node_name` / `runtime`; see the `node_id` row above)
:::

---

### report_completion

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L213)

Report task completion. Automatically updates session status to idle.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `alias` | string | &check; | Session alias |
| `task` | string | &check; | Completed task description |
| `result` | string | &check; | Result summary (max 50000 chars) |
| `artifacts` | string[] | | Output file paths or URLs (max 50) |
| `score` | number | | Self-rating 0-10 |
| `duration_minutes` | number | | Duration (minutes) |
| `network_id` | string | | Network ID |

**Response**:

```json
{
  "ok": true,
  "completion_id": "uuid-xxx"
}
```

**Example**:

```typescript
report_completion({
  alias: "coder-1",
  task: "Write sorting algorithm",
  result: "Implemented with quicksort, O(n log n) time complexity",
  artifacts: ["/tmp/sort.py"],
  score: 8,
  duration_minutes: 2
})
```

::: tip Side effects (beyond the `completions` INSERT)
- **Session state flip**: [`tools.ts:239-242`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L239) `UPDATE sessions SET status='idle', task=NULL, progress=0` (matched by alias)
- **Task state transition**: [`tools.ts:244-266`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L244) moves the `tasks` row from `delivered`/`acked`/`running` to `replied`. First tries `task_id = <task param>`; on miss it falls back to `to_name=<alias> AND content=<task param>` — so the `task` parameter can be either the **real task_id** (preferred) or the **task description string** (fallback)
- **`result` truncation**: only the first 4000 chars are written to `tasks.result` ([`tools.ts:246`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L246)); the full `result` still lands in `completions.result`
- **chained_reply auto-propagation**: if the task has a `parent_task_id`, the parent's originator gets a `chained_reply` SSE event ([`tools.ts:271-291`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L271); used so subtask replies bubble up to the parent — see [`task-lifecycle` dual-write](/en/concepts/task-lifecycle#dual-write-mechanism))
- **`task_events` log**: a `replied` event is logged ([`tools.ts:270`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L270))

Compared to [`send_reply`](#send-reply): `send_reply` is a hub tool that requires an explicit `task_id`; `report_completion` is an agent tool that can fall back by content match.
:::

---

### get_inbox

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L300)

Fetch pending messages.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `alias` | string | &check; | Session alias |
| `limit` | number | | Max items (default 10, max 100) |

**Response**:

```json
{
  "ok": true,
  "messages": [
    {
      "id": "uuid-xxx",
      "type": "task",
      "priority": "high",
      "content": "Write sorting algorithm",
      "context": null,
      "from_session": "commander",
      "created_at": "2026-04-12 10:00:00",
      "network_id": "net_xxx"
    }
  ]
}
```

Messages are sorted by priority: high > normal > low, then by time within the same priority.

---

### ack_inbox

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L330)

Acknowledge message receipt. After ACK, the message won't be returned by `get_inbox`.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `alias` | string | &check; | Session alias |
| `message_id` | string | &check; | Message ID |
| `response` | string | | **Currently a no-op**: the handler accepts this parameter but never writes it to the database ([`tools.ts:337-360`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L337) never references `response`). The schema is kept for forward-compat / to avoid breaking existing callers; if you want to actually reply, use [`send_reply`](#send-reply). |

**Response**:

```json
{ "ok": true }
```

**Error**: `message_id` not found or not owned by this alias → `{ok: false, error: "message not found or not yours"}`.

::: tip Side effect: tasks-table state machine
A successful ack also UPDATEs the `tasks` row where `task_id = message_id` from `status='delivered'` to `'acked'` ([`tools.ts:354`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L354); **only** transitions from `delivered`, unlike the hub-side [`send_ack`](#send-ack) which also accepts `created` — see [Task lifecycle — the `created` state](/en/concepts/task-lifecycle#state-machine)).
:::

---

## Task Management Tools

### send_task

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L450)

Dispatch a task to a specified agent's inbox. **`send_task` triggers AI processing on the receiver** (same as [`broadcast`](#broadcast); `send_message` / `send_reply` / `send_ack` do not — see [Task lifecycle — Message types](/en/concepts/task-lifecycle#message-types)).

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `alias` | string | &check; | Target agent alias |
| `task` | string | &check; | Task content (max 10000 chars) |
| `priority` | enum | | `high` / `normal` (default) / `low` |
| `context` | string | | Context information (max 10000 chars) |
| `from_session` | string | | Sender identifier (default "hub") |
| `ttl_seconds` | number | | Expiration time (default 3600, max 86400) |
| `network_id` | string | | Network ID |
| `parent_task_id` | string | | Parent task ID; child replies are auto-chained back to the parent task originator |

**Response**:

```json
{
  "ok": true,
  "message_id": "uuid-xxx",
  "session_status": "idle"
}
```

**Example**:

```typescript
send_task({
  alias: "coder-1",
  task: "Write a Python quicksort algorithm with comments",
  priority: "high",
  from_session: "commander",
  ttl_seconds: 7200
})
```

::: warning Permission Requirements
- viewer role cannot send tasks
- Cannot send tasks after trial expires
:::

---

### send_message

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L550)

Send a message (does not trigger AI processing, display only).

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `alias` | string | &check; | Target agent alias |
| `message` | string | &check; | Message content (max 10000 chars) |
| `from_session` | string | | Sender identifier (default "hub") |

**Response**:

```json
{
  "ok": true,
  "message_id": "uuid-xxx",
  "session_status": "idle"
}
```

---

### send_reply

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L589)

Reply to a task. Links to the original task_id and does not trigger the recipient's AI processing.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `alias` | string | &check; | Target agent alias |
| `text` | string | &check; | Reply content (max 10000 chars) |
| `in_reply_to` | string | | Original task/message ID |
| `status` | enum | | `replied` (default) / `failed` / `cancelled` |
| `from_session` | string | | Sender identifier (default "hub") |

**Response**:

```json
{
  "ok": true,
  "message_id": "uuid-xxx",
  "session_status": "idle"
}
```

---

### send_ack

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L667)

Acknowledge task receipt (lightweight, does not enter inbox).

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `task_id` | string | &check; | Task ID |
| `from_session` | string | | Sender identifier (default "hub") |

**Response**:

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "updated": 1
}
```

---

### retry_task

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L693)

Retry a failed/cancelled/expired task.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `task_id` | string | &check; | Task ID |
| `from_session` | string | | Sender identifier |

**Response**:

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "retried_to": "coder-1"
}
```

::: warning Limitation
- Can only retry tasks with status `failed` / `expired` / `cancelled` (verify [`tools.ts:713`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L713)); other statuses return `{ok: false, error: "task status is <X>, not retryable"}`
- Retry gives the task a **fresh `+1 hour` TTL** (hardcoded at [`tools.ts:718`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L718)) — the original task's `ttl_seconds` is **not preserved**
- `task_id` is reused; a new inbox row (new UUID) is inserted and a `new_task` SSE event is pushed to the target alias
:::

---

### cancel_task

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L803)

Cancel a pending task.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `task_id` | string | &check; | Task ID |
| `reason` | string | | Cancellation reason (max 1000 chars) |
| `from_session` | string | | Sender identifier |

**Response**:

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "cancelled": true
}
```

::: warning Constraint
Only cancellable from these 4 source statuses: `created` / `delivered` / `acked` / `running` (verify the WHERE clause at [`tools.ts:817`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L817)). Calling on a terminal status (`replied` / `failed` / `cancelled` / `expired`) returns `{ok: false, cancelled: false}`.

`created` is only the DB column default; the normal API path never produces a row in that state (see [Task lifecycle — the `created` state](/en/concepts/task-lifecycle#state-machine)).
:::

---

### reassign_task

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L835)

Reassign a task to another agent.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `task_id` | string | &check; | Task ID |
| `new_alias` | string | &check; | New target agent alias |
| `from_session` | string | | Sender identifier |

**Response**:

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "reassigned_from": "coder-1",
  "reassigned_to": "coder-2"
}
```

::: warning Constraint
- Reassign works only on **non-terminal** tasks: `created` / `delivered` / `acked` / `running` ([`tools.ts:853`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L853) rejects `replied` / `failed` / `cancelled` / `expired` with `{ok: false, error: "task is terminal (<status>)"}`)
- The old alias's inbox row is `acked=1` ([`tools.ts:858`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L858)) so the original agent will not pick it up
- Task status resets to `delivered`, `started_at` clears, `delivered_at` refreshes to now ([`tools.ts:863`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L863)) — a `running` task is interrupted
- TTL (`expires_at`) is **not modified** (unlike [`retry_task`](#retry-task) which forces `+1 hour`); the task keeps its remaining time
- The new alias receives a fresh-UUID inbox row + a `new_task` SSE event
:::

---

## Query Tools

### get_task

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L740)

Query task details.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `task_id` | string | &check; | Task ID |

**Response**:

```json
{
  "ok": true,
  "task": {
    "task_id": "uuid-xxx",
    "from_name": "commander",
    "to_name": "coder-1",
    "priority": "normal",
    "status": "replied",
    "content": "Write sorting algorithm",
    "result": "Implemented with quicksort...",
    "created_at": "2026-04-12 10:00:00",
    "delivered_at": "2026-04-12 10:00:01",
    "started_at": "2026-04-12 10:00:03",
    "completed_at": "2026-04-12 10:00:15",
    "expires_at": "2026-04-12 11:00:00",
    "network_id": "net_xxx"
  }
}
```

`get_task` does `SELECT * FROM tasks` ([`tools.ts:749`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L749)) and returns the **full row** (the example above shows sample fields; the actual row also includes `requires_response` / `parent_task_id` and every other column). When the task doesn't exist it returns `{ok: false, error: "task not found"}`.

---

### list_tasks

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L763)

Query task list with multi-dimensional filtering.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `alias` | string | | Filter by recipient |
| `status` | string | | Filter by status |
| `from_name` | string | | Filter by sender |
| `network_id` | string | | Filter by network |
| `limit` | number | | Max items (default 20, max 100) |

**Response**:

```json
{
  "ok": true,
  "tasks": [
    {
      "task_id": "uuid-xxx",
      "from_name": "commander",
      "to_name": "coder-1",
      "priority": "normal",
      "status": "replied",
      "content": "Write a sorting algorithm",
      "result": "Implemented with quicksort...",
      "created_at": "2026-04-12 10:00:00",
      "completed_at": "2026-04-12 10:00:15"
    }
  ],
  "count": 1,
  "stats": [
    { "status": "replied", "count": 42 },
    { "status": "running", "count": 3 },
    { "status": "delivered", "count": 1 }
  ]
}
```

::: tip `list_tasks` rows are a subset of `get_task`
Each `list_tasks` row SELECTs only **9 columns** ([`tools.ts:776`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L776)): `task_id` / `from_name` / `to_name` / `priority` / `status` / `content` / `result` / `created_at` / `completed_at`. It does **not** include `delivered_at` / `started_at` / `expires_at` / `network_id` / `requires_response` / `parent_task_id` — use [`get_task`](#get-task) (`SELECT *`) for those. `count` is the number of rows returned this call (≤ `limit`); `stats` is the status-grouped count for the **entire scope** (not affected by the filters).
:::

---

### get_all_status

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L369)

Get all session statuses. Sessions without a heartbeat for over 10 minutes are auto-marked offline.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `filter_status` | string | | Filter by status (idle / working / offline) |
| `filter_server` | string | | Filter by server |
| `network_id` | string | | Filter by network |

**Response**:

```json
{
  "ok": true,
  "sessions": [
    {
      "resume_id": "sdk-n_xxx",
      "alias": "coder-1",
      "status": "idle",
      "agent": "agent-node:codex",
      "node_id": "n_a1b2c3d4",
      "last_seen_at": "2026-04-12 10:00:00",
      "network_id": "net_xxx"
    }
  ],
  "summary": [
    { "status": "idle", "count": 5 },
    { "status": "working", "count": 2 },
    { "status": "offline", "count": 1 }
  ]
}
```

::: warning The `sessions` row has **no `model` field**
`get_all_status` runs `SELECT * FROM sessions` ([`tools.ts:388`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L388), no JOIN). The `sessions` table schema ([`db.ts:7-26`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L7) + V2 migration [`db.ts:59-68`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L59)) **has a `model` column** — the V2 migration runs `ALTER TABLE sessions ADD COLUMN model`, and `report_status`'s `sessions` upsert unconditionally writes `sessions.model = COALESCE(model, old)` ([`tools.ts:129`/`141`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L129)). So `get_all_status` returns each session's `model` directly (`null` if the agent never passed a `model` parameter). The `nodes` table also keeps a copy of `model` (synced by `report_status` when `node_id` is passed) as the more durable source. `summary` is the status-grouped count over the entire scope (same as `list_tasks`'s `stats`).
:::

---

### get_session_status

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L415)

Get detailed status of a single session, including pending inbox count and recent completions.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `alias` | string | &check; | Session alias |

**Response**:

```json
{
  "ok": true,
  "session": {
    "resume_id": "sdk-n_xxx", "alias": "coder-1", "status": "idle",
    "agent": "agent-node:codex", "node_id": "n_a1b2c3d4",
    "last_seen_at": "2026-04-12 10:00:00", "network_id": "net_xxx"
  },
  "inbox_pending": 2,
  "recent_completions": [
    {
      "id": "uuid-xxx",
      "session_name": "coder-1",
      "task": "Write sorting algorithm",
      "result": "Done",
      "artifacts": null,
      "score": 8,
      "duration_minutes": 2,
      "network_id": "net_xxx",
      "completed_at": "2026-04-12 10:00:15"
    }
  ]
}
```

::: tip Response shape
- `session` is `SELECT * FROM sessions` ([`tools.ts:423`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L423)) — the full sessions row (same as [`get_all_status`](#get-all-status)'s session row, **including the `model` column** — see the get_all_status note); if the alias doesn't exist `session` is `null` but `ok` is still `true`
- `recent_completions` is `SELECT * FROM completions ... LIMIT 5` ([`tools.ts:433-435`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L433)) — the full 9-column completion row (`id` / `session_name` / `task` / `result` / `artifacts` / `score` / `duration_minutes` / `network_id` / `completed_at`), ordered by `completed_at` DESC, max 5
:::

---

### get_completions

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L925)

Get completion records.

**Parameters**:

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `alias` | string | | Filter by agent |
| `since` | string | | Start time (ISO 8601, default last 24h) |
| `network_id` | string | | Filter by network |
| `limit` | number | | Max items (default 50, max 500) |

**Response**:

```json
{
  "ok": true,
  "completions": [
    {
      "id": "uuid-xxx",
      "session_name": "coder-1",
      "task": "Write sorting algorithm",
      "result": "Implemented with quicksort...",
      "artifacts": "[\"/tmp/sort.py\"]",
      "score": 8,
      "duration_minutes": 2,
      "network_id": "net_xxx",
      "completed_at": "2026-04-12 10:00:15"
    }
  ]
}
```

`completions` is `SELECT * FROM completions WHERE completed_at >= <cutoff>` ([`tools.ts:938`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L938)) — the full 9-column row, ordered by `completed_at` DESC. `artifacts` is a JSON-array **string** (not a parsed array — `report_completion` `JSON.stringify`s it on the way in). When `since` is omitted the cutoff defaults to 24 hours ago.

---

## Broadcast Tools

### broadcast

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L878)

Broadcast a message to all online agents. **`broadcast` triggers AI processing on receivers, the same as `task`** ([`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) thinks only on `task` and `broadcast` types; `reply` / `message` / `ack` are display-only). If you just want a notification without an AI reply, loop `send_message` instead. Full message-type table: [Task lifecycle — Message types](/en/concepts/task-lifecycle#message-types).

**Parameters** (verify [`server/src/tools.ts:880-885`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L880)):

| Parameter | Type | Required | Description |
|------|------|:----:|------|
| `message` | string | &check; | Broadcast content (max 10000 chars) |
| `filter_server` | string | | Only deliver to sessions whose `server` field matches |
| `filter_status` | string | | Only deliver to sessions in the given status (e.g. `idle` / `working`) |
| `network_id` | string | | Network ID (broadcast within this network only; can be supplied with a `utok_`, but `ntok_` callers are pinned to their bound network) |

> The field is `message`, not `content`; `from_session` is **not** a parameter — the server hard-codes it to `'hub'`.

**Response**:

```json
{
  "ok": true,
  "recipients": 10,
  "message_ids": ["uuid-xxx-1", "uuid-xxx-2"]
}
```

`message_ids.length === recipients` — one inbox row per target session.

---

## Common Response Format

All tools return in MCP Content format:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"ok\": true, ...}"
    }
  ]
}
```

The `text` field is a JSON string that needs to be parsed.

## Error Codes

| Error | Meaning |
|------|------|
| `permission_denied` | Insufficient permissions (viewer writing, missing writable network binding, etc.) |
| `license_expired` | Trial period expired (v0.6 legacy path; not needed after Apache 2.0 OSS — when hit, follow the `license_expired` section in [troubleshooting](/en/troubleshooting) to clear the SQLite `licenses` table) |
| `message not found or not yours` | Message doesn't exist or doesn't belong to this agent |
| `task not found` | Task doesn't exist |
| `task is terminal` | Task is in a terminal state, cannot be operated on |
| `task status is X, not retryable` | Only failed/expired/cancelled tasks can be retried |

## Next steps

**Corresponding REST API**:
- [REST API](/en/api/rest) — the HTTP endpoints these MCP tools call under the hood

**Agent integration**:
- [Agent Node](/en/guide/agent-node) — how an agent connects to the MCP server
- [Runtimes](/en/guide/runtimes) — all runtimes talk to the Hub via MCP
- [Channel plugins](/en/guide/channels) — how to write a custom MCP channel

**Hands-on**:

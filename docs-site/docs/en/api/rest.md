# REST API Reference

CommHub Server provides a REST API for Dashboard, CLI, and third-party system integration.

## Basics

| Item | Value |
|-----|-----|
| Base URL | `http://YOUR_IP:9200` |
| Auth | `Authorization: Bearer <token>` **(recommended)**; `?token=<token>` URL query kept for SSE / browser EventSource (access-log leak risk — see [Security](/en/concepts/security)) |
| Content Type | `application/json` |
| Encoding | UTF-8 |

## Public Endpoints

### GET /health


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L713)

Health check, no authentication required.

```bash
curl http://localhost:9200/health
```

```json
{
  "ok": true,
  "version": "0.8.0",
  "api_version": "v3",
  "transport": "streamable-http",
  "sessions_count": 0,
  "sse_connections": 0,
  "sse_sessions": {},
  "auth": "user-token",
  "security": "secured",
  "tmux": "disabled",
  "v3_auth": true,
  "multi_network": true,
  "license": "trial",
  "uptime": 3600
}
```

::: tip The `license` field is a v0.6 legacy
`license: "trial"` is a leftover from the v0.6 era 14-day trial mechanism. After the Apache 2.0 OSS transition it is **no longer a commercial feature gate** (self-hosted has no notion of "expired"). The `send_task` path still runs the trial check only for backward compatibility; if you hit `license_expired`, see [troubleshooting](/en/troubleshooting). Planned for full removal in v0.9+.
:::

---

## Auth Endpoints

### POST /api/auth/register


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L414)

Register a new user. The first user registered automatically becomes admin.

```bash
# v0.8+: register is a public endpoint, no master token needed
curl -X POST http://localhost:9200/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "password": "mypassword2026",
    "email": "alice@example.com",
    "display_name": "Alice"
  }'
```

**Request body**:

| Field | Type | Required | Description |
|------|------|:----:|------|
| `username` | string | &check; | Username (2-50 chars, letters/numbers/underscores/Chinese) |
| `password` | string | &check; | Password (>= 8 chars + not in weak-password dictionary; first bootstrap admin exempt, >= 4 OK) |
| `email` | string | | Email |
| `display_name` | string | | Display name |

**Response**:

```json
{
  "ok": true,
  "user": {
    "user_id": "u_abc123",
    "username": "alice",
    "display_name": "Alice",
    "role": "admin"
  },
  "token": "utok_xxxxxxxxxxxxxxxx",
  "network_token": "ntok_xxxxxxxxxxxxxxxx",
  "network_id": "net_xxxxxxxx"
}
```

**Rate limit**: 30 requests/minute per IP.

---

### POST /api/auth/login


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L429)

User login.

```bash
# v0.8+: login is a public endpoint, no master token needed
curl -X POST http://localhost:9200/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "password": "mypassword2026"
  }'
```

**Response**:

```json
{
  "ok": true,
  "user": {
    "user_id": "u_abc123",
    "username": "alice",
    "display_name": "Alice",
    "role": "admin"
  },
  "token": "utok_xxxxxxxxxxxxxxxx",
  "network_id": "net_xxxxxxxx"
}
```

**Rate limit**: 10 requests/minute per IP.

---

### GET /api/auth/me


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L446)

Get current user info.

```bash
curl http://localhost:9200/api/auth/me \
  -H "Authorization: Bearer utok_xxx"
```

**Response**:

```json
{
  "ok": true,
  "user": {
    "user_id": "u_abc123",
    "username": "alice",
    "display_name": "Alice",
    "role": "admin"
  },
  "networks": [
    { "network_id": "net_xxx", "network_name": "default", "member_role": "owner" },
    { "network_id": "net_yyy", "network_name": "team-prod", "member_role": "member" }
  ]
}
```

`networks` lists every network the current user belongs to along with their `member_role` in that network (field name matches [GET /api/networks](#get-api-networks)); `anet whoami` uses this list (combined with the `network_id` in `config.json`) to render the "← current" marker.

---

### PUT /api/auth/me


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L455)

Update personal info.

```bash
curl -X PUT http://localhost:9200/api/auth/me \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"display_name": "Alice Smith", "email": "alice@example.com"}'
```

**Request body**:

| Field | Type | Required | Description |
|------|------|:----:|------|
| `display_name` | string | | Display name |
| `email` | string | | Email |

Only the provided fields are updated ([server/src/index.ts:464-465](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L464) uses conditional SQL with `if (body.X)`); `username` / `role` / `password` are **not** mutable through this endpoint.

**Response**:

```json
{
  "ok": true,
  "user": {
    "user_id": "u_abc123",
    "username": "alice",
    "display_name": "Alice Smith",
    "email": "alice@example.com",
    "role": "admin"
  }
}
```

---

### POST /api/auth/password


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L479)

Change password.

```bash
curl -X POST http://localhost:9200/api/auth/password \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "old_password": "oldpass",
    "new_password": "newpass123"
  }'
```

**Response**:

```json
{
  "ok": true,
  "token": "utok_xxxxxxxxxxxxxxxx",
  "token_id": "tok_new_session_id"
}
```

**Key side effects** (verify [server/src/index.ts:486-491](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L486)):
1. The `utok_` used for this call (`resolved.tokenId`) is revoked immediately
2. A new `utok_` (`issued.token`) is minted and returned in this response — the caller must overwrite its local storage with the new token right away
3. Writes audit log: `action='password_changed'`
4. **Other devices' utok_ are not explicitly revoked here** — behavior depends on `changePassword()` internals; see [Token lifecycle table](/en/concepts/tokens)

Matches the `anet passwd` CLI behavior (the CLI writes the new token back into `~/.anet/config.json` automatically).

---

## Network Endpoints

### GET /api/networks


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L553)

Get all networks the user belongs to.

```bash
curl http://localhost:9200/api/networks \
  -H "Authorization: Bearer utok_xxx"
```

**Response**:

```json
{
  "ok": true,
  "networks": [
    {
      "network_id": "net_abc123",
      "network_name": "default",
      "owner_id": "u_abc123",
      "member_role": "owner",
      "visibility": "private",
      "max_members": 50,
      "created_at": "2026-04-12 10:00:00"
    }
  ]
}
```

---

### POST /api/networks


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L568)

Create a new network.

```bash
curl -X POST http://localhost:9200/api/networks \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prod",
    "description": "Production environment network"
  }'
```

**Response**:

```json
{
  "ok": true,
  "network_id": "net_xyz789",
  "network_name": "prod"
}
```

---

### GET /api/networks/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L660)

Get network details (membership check: caller must be a member of the network or a system admin, otherwise 403).

```bash
curl http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx"
```

**Response**:

```json
{
  "ok": true,
  "network": {
    "network_id": "net_abc123",
    "network_name": "prod",
    "owner_id": "u_abc123",
    "description": "Production network",
    "visibility": "private",
    "max_members": 50,
    "created_at": "2026-04-12 10:00:00",
    "updated_at": "2026-04-12 10:00:00"
  },
  "stats": {
    "nodes": 5,
    "sessions": 4,
    "tasks": [
      { "status": "replied", "count": 42 },
      { "status": "running", "count": 3 }
    ]
  }
}
```

---

### PUT /api/networks/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L694)

Rename a network (owner only).

```bash
curl -X PUT http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "development"}'
```

**Request body**:

| Field | Type | Required | Description |
|------|------|:----:|------|
| `name` | string | &check; | New network name (**note the field is `name`, not `network_name`**; missing returns `name required` 400) |

**Response** (success):

```json
{ "ok": true }
```

**Common 4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `name required` | Body missing `name` (note: not `network_name`) |
| 400 | `network not found` | `network_id` does not exist |
| 400 | `not your network` | Caller is not the owner |
| 400 | `name already taken` | Caller already owns another network with this name |

Writes audit log `action='network_renamed'`; the `detail` column records the new name.

---

### DELETE /api/networks/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L684)

Delete a network (owner only, must have no active sessions).

```bash
curl -X DELETE http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx"
```

**Response** (success):

```json
{ "ok": true }
```

**Common 4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `network not found` | `network_id` does not exist |
| 400 | `not your network` | Caller is not the owner |
| 400 | `network has N active session(s) — stop them first` | Some agent sessions still reference this network (run `anet node stop <name>` on each before deleting) |

Writes audit log `action='network_deleted'`.

---

## Data Query Endpoints

### GET /api/status


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L749)

Get all session statuses.

```bash
curl "http://localhost:9200/api/status?network_id=net_xxx" \
  -H "Authorization: Bearer ntok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `network_id` | Filter by network |
| `status` | Filter by status (idle / working / offline) |

**Response**:

```json
{
  "ok": true,
  "sessions": [
    {
      "resume_id": "sdk-n_xxx",
      "alias": "coder-1",
      "status": "idle",
      "agent": "agent-node:codex-sdk",
      "model": "your-model-id",
      "task": null,
      "progress": null,
      "last_seen_at": "2026-04-12 10:00:00"
    }
  ]
}
```

---

### GET /api/tasks


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1053)

Get task list.

```bash
curl "http://localhost:9200/api/tasks?status=running&limit=10" \
  -H "Authorization: Bearer ntok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `network_id` | Filter by network |
| `status` | Filter by status; any [Task lifecycle state machine](/en/concepts/task-lifecycle#status-reference) state is accepted |
| `to_name` | Filter by recipient |
| `from_name` | Filter by sender |
| `limit` | Max items (default 50) |

**Response**:

```json
{
  "ok": true,
  "tasks": [
    {
      "message_id": "t_a1b2c3d4",
      "from_name": "指挥室",
      "to_name": "代码1号",
      "content": "Write a Python quicksort",
      "status": "replied",
      "priority": "normal",
      "created_at": "2026-04-12 10:00:00",
      "delivered_at": "2026-04-12 10:00:01",
      "replied_at": "2026-04-12 10:00:15",
      "ttl_seconds": 3600
    }
  ]
}
```

The `anet tasks` CLI uses `from_name` / `to_name` / `status` / `created_at` / `content` to render the table (cli.ts L2810-2817).

---

### GET /api/nodes


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1039)

Get node list (persistent node info, distinct from session's transient state).

```bash
curl http://localhost:9200/api/nodes \
  -H "Authorization: Bearer ntok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `node_id` | Filter by node ID |
| `alias` | Filter by alias |
| `network_id` | Filter by network (when an `ntok_` is bound, this parameter is overridden) |

**Response**:

```json
{
  "ok": true,
  "nodes": [
    {
      "node_id": "node_abc123",
      "node_name": "coder-1",
      "alias": "coder-1",
      "runtime": "claude-agent-sdk",
      "model": "your-model-id",
      "config_path": ".anet/nodes/coder-1/config.json",
      "channels": null,
      "server": "http://localhost:9200",
      "hostname": "dev-machine",
      "network_id": "net_xxxxx",
      "created_at": "2026-04-12 10:00:00",
      "updated_at": "2026-04-12 10:00:00"
    }
  ],
  "count": 1
}
```

::: info nodes vs sessions
The `nodes` table is **persistent node identity** (written at creation, deleted only when the agent is deleted). The `sessions` table is **runtime heartbeat state** (written at agent startup; marked `offline` after 10 minutes of silence). Use [GET /api/status](#get-api-status) to check whether an agent is online; use this endpoint for agent config metadata.
:::

---

### GET /api/messages


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L935)

Get recent inbox messages.

```bash
curl "http://localhost:9200/api/messages?limit=100" \
  -H "Authorization: Bearer ntok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `since` | Start time, defaults to the last hour |
| `limit` | Max items, default 100, max 500 |

**Response**:

```json
{
  "ok": true,
  "messages": [
    {
      "message_id": "m_abc123",
      "from_alias": "coder-1",
      "to_alias": "commander",
      "type": "reply",
      "content": "[coder-1] Done, used quicksort",
      "created_at": "2026-04-12 10:00:15"
    },
    {
      "message_id": "m_def456",
      "from_alias": "commander",
      "to_alias": "coder-1",
      "type": "task",
      "content": "Write a quicksort",
      "created_at": "2026-04-12 10:00:00"
    }
  ]
}
```

::: info Current schema caveat
The SELECT doesn't include `in_reply_to` yet; reply-polling uses a heuristic of `from_alias` + `type='reply'` + recency (see comment at `cli.ts:3827`).
:::

---

### GET /api/completions


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1080)

Get completion records (summary records written via the `report_completion` MCP tool — distinct from a simple `tasks` row with `status='replied'`).

```bash
curl "http://localhost:9200/api/completions?since=2026-04-12T00:00:00Z" \
  -H "Authorization: Bearer ntok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `since` | Start time (ISO 8601); defaults to the last 24 hours |
| `network_id` | Filter by network |

The server hard-codes `LIMIT 100` — there is no `limit` query parameter.

**Response**:

```json
{
  "ok": true,
  "completions": [
    {
      "id": "c_abc123",
      "session_name": "coder-1",
      "task": "Write a Python quicksort",
      "result": "Done, used Lomuto partition with unit tests",
      "artifacts": "[{\"file\":\"quicksort.py\"}]",
      "score": 0.95,
      "duration_minutes": 2.5,
      "network_id": "net_xxxxx",
      "completed_at": "2026-04-12 10:00:15"
    }
  ]
}
```

The `artifacts` field is a JSON string (agent-defined schema); consumers must `JSON.parse()` it.

---

### GET /api/task_events


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1025)

Get the task-state-change audit log (task lifecycle). Every time a task's `status` changes the server inserts one row — this is the primary data source for "where is this task stuck / who changed the status".

```bash
curl "http://localhost:9200/api/task_events?task_id=t_a1b2c3d4" \
  -H "Authorization: Bearer ntok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `task_id` | Filter to a specific task (otherwise returns recent events across all tasks) |
| `network_id` | Filter by network |
| `limit` | Max items (default 50, max 500) |

**Response**:

```json
{
  "ok": true,
  "events": [
    {
      "id": 1234,
      "task_id": "t_a1b2c3d4",
      "from_status": "delivered",
      "to_status": "running",
      "actor": "node_abc123",
      "detail": null,
      "created_at": "2026-04-12 10:00:02"
    },
    {
      "id": 1235,
      "task_id": "t_a1b2c3d4",
      "from_status": "running",
      "to_status": "replied",
      "actor": "node_abc123",
      "detail": "completed in 12s",
      "created_at": "2026-04-12 10:00:14"
    }
  ],
  "count": 2
}
```

Events are sorted `created_at DESC` (newest first). `actor` is the originator of the state change (agent `node_id` / `'hub'` / `'system'`); `from_status` may be `null` for the initial `created` event. See the [Task lifecycle](/en/concepts/task-lifecycle#status-reference) state machine for the full status set.

---

### GET /api/stats


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L948)

Get aggregate statistics.

```bash
curl http://localhost:9200/api/stats \
  -H "Authorization: Bearer utok_xxx"
```

**Response**:

```json
{
  "ok": true,
  "network_id": "net_xxx",
  "tasks": {
    "total": 100,
    "by_status": [
      { "status": "replied", "count": 85 },
      { "status": "running", "count": 5 }
    ]
  },
  "sessions": {
    "by_status": [
      { "status": "idle", "count": 7 },
      { "status": "offline", "count": 3 }
    ]
  },
  "nodes": { "total": 10 },
  "recent_tasks": []
}
```

---

### GET /api/audit-log


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1004)

Get the audit log. **Permissions: any authenticated user can call this endpoint, but non-**system admin** callers only see their own log rows** (the server adds `WHERE user_id = <caller>` automatically when `users.role !== 'admin'` — see [`server/src/index.ts:1016`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1016)). System admin (`users.role = 'admin'`) sees everything and can filter by any `user_id`.

::: warning Not the network-level admin/owner role
"admin" here means `users.role='admin'` (**system-level**, the first registered user by default) — **not** the per-network `owner / admin / member / viewer` roles. Same distinction as [GET /api/users](#get-api-users).
:::

```bash
curl "http://localhost:9200/api/audit-log?limit=50" \
  -H "Authorization: Bearer utok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `limit` | Max items (default 50, max 200) |
| `action` | Filter by action (any role can use) |
| `user_id` | Filter by user (**system admin only**; non-admin callers pass this in vain — own-logs filter is enforced) |

**Response**:

```json
{
  "ok": true,
  "logs": [
    {
      "user_id": "u_abc123",
      "username": "alice",
      "action": "password_reset_by_admin",
      "target_type": "user",
      "target_id": "u_def456",
      "detail": "local cli reset-user",
      "created_at": "2026-04-12 10:00:00"
    },
    {
      "user_id": "u_abc123",
      "username": "alice",
      "action": "create_network",
      "target_type": "network",
      "target_id": "net_xyz789",
      "detail": "name=prod",
      "created_at": "2026-04-12 09:55:00"
    }
  ],
  "count": 2
}
```

The fields are `logs` + `count` (**not** `audit_log` — earlier doc was wrong). The `audit_log` **table** schema is in [`agent-network/bin/cli.ts:2171`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2171) (INSERT statement enumerates columns). Common `action` values: `password_reset_by_admin` / `register` / `login` / `create_network` / `send_task` / `report_status` / `password_changed` / `member_added` / `member_role_changed` / `member_removed`, etc.

---

### GET /api/users


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L649)

Get the list of all users (**system admin** only — i.e. `users.role = 'admin'`, distinct from per-network `owner / admin / member / viewer` roles).

```bash
curl http://localhost:9200/api/users \
  -H "Authorization: Bearer utok_xxx"
```

**Response**:

```json
{
  "ok": true,
  "users": [
    {
      "user_id": "u_abc123",
      "username": "alice",
      "display_name": "Alice",
      "email": "alice@example.com",
      "role": "admin",
      "created_at": "2026-04-12 10:00:00"
    },
    {
      "user_id": "u_def456",
      "username": "bob",
      "display_name": null,
      "email": null,
      "role": "user",
      "created_at": "2026-04-13 09:00:00"
    }
  ]
}
```

**4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 401 | `auth required` | Missing `Authorization` header |
| 403 | `admin required` | Caller is not `users.role='admin'` (only the first registered user is admin by default) |

The response **does not include** `password_hash` (the SELECT explicitly enumerates 6 columns). Sorted by `created_at` ascending (the bootstrap admin appears first).

---

## MCP Endpoint

### POST /mcp

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L313)

MCP Streamable HTTP endpoint. Agents call MCP Tools through this endpoint.

```bash
curl -X POST http://localhost:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ntok_xxx" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "get_all_status",
      "arguments": {}
    },
    "id": 1
  }'
```

---

## SSE Endpoint

### GET /events/:alias

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L342)

SSE real-time push endpoint. Agents receive events via long connections.

```bash
# Recommended: Authorization header (keeps the token out of proxies / browser history / access logs)
curl -N -H "Authorization: Bearer ntok_xxx" http://localhost:9200/events/coder-1

# Compat: URL query token (kept for browser native EventSource, but logs leak risk — see [Security](/en/concepts/security))
curl -N "http://localhost:9200/events/coder-1?token=ntok_xxx"
```

**Pushed event types**:

| Event | Trigger | Data |
|------|---------|------|
| `new_task` | New task received | `{inbox_count, priority, from}` |
| `new_message` | New message received | `{message, from, message_id}` |
| `new_reply` | Reply received | `{from, message_id, in_reply_to, status}` |
| `broadcast` | Broadcast received | `{content, from}` |
| `heartbeat` | Server heartbeat | `{time}` |

**Example SSE data stream**:

```
event: new_task
data: {"type":"new_task","inbox_count":1,"priority":"high","from":"commander"}

event: heartbeat
data: {"time":"2026-04-12T10:00:00Z"}
```

---

## Token Management Endpoints

### POST /api/auth/node-token


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L500)

Create a network-bound `ntok_` for a node. `anet node create` calls this automatically and writes the result into `.anet/nodes/<node-name>/config.json` `token` field.

```bash
curl -X POST http://localhost:9200/api/auth/node-token \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"network_id": "net_xxx", "node_name": "coder-1"}'
```

**Response**:

```json
{
  "ok": true,
  "token": "ntok_xxxxxxxxxxxxxxxx"
}
```

The `token` is the `ntok_` for that `(node_name, network_id)` pair. The hub force-binds the `network_id` to the token — when an agent calls MCP with this token, the server locks operations to that network and rejects cross-network access. See [Tokens — ntok_](/en/concepts/tokens) for more.

### POST /api/auth/tokens


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L526)

Create an API token.

```bash
curl -X POST http://localhost:9200/api/auth/tokens \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "network_id": "net_xxx"}'
```

**Response**:

```json
{
  "ok": true,
  "token": "utok_xxxxxxxxxxxxxxxx",
  "token_id": "tok_abc123def456",
  "name": "my-agent"
}
```

::: warning The plaintext token is returned only once
The `token` field is the plaintext token, **returned exactly once at creation** — the hub stores only its hash. If you lose it, use [DELETE /api/auth/tokens/:id](#delete-api-auth-tokens-id) to revoke + create a fresh one.
:::

### GET /api/auth/tokens


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L517)

List all user tokens.

```bash
curl http://localhost:9200/api/auth/tokens \
  -H "Authorization: Bearer utok_xxx"
```

**Response**:

```json
{
  "ok": true,
  "tokens": [
    {
      "token_id": "tok_abc123def456",
      "name": "my-agent",
      "last_used_at": "2026-04-12 10:00:00"
    },
    {
      "token_id": "tok_xyz789",
      "name": "dashboard",
      "last_used_at": null
    }
  ]
}
```

The plaintext `token` field is **not** returned here (only at POST creation).

### DELETE /api/auth/tokens/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L541)

Revoke a token (immediate server-side invalidation — distinct from `anet logout` which only clears the local token).

```bash
curl -X DELETE http://localhost:9200/api/auth/tokens/tok_xxx \
  -H "Authorization: Bearer utok_xxx"
```

**Response**:

```json
{
  "ok": true,
  "revoked": true
}
```

---

## Network Member Endpoints

### GET /api/networks/:id/members

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L583)

Get network member list (owner / admin only).

```bash
curl http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx"
```

**Response**:

```json
{
  "ok": true,
  "members": [
    {
      "user_id": "u_abc123",
      "username": "alice",
      "display_name": "Alice",
      "role": "owner",
      "joined_at": "2026-04-12 10:00:00"
    },
    {
      "user_id": "u_def456",
      "username": "bob",
      "display_name": "Bob",
      "role": "member",
      "joined_at": "2026-04-15 14:30:00"
    }
  ]
}
```

`anet network members` CLI renders this response (using `m.display_name || m.username` for the name, with a role emoji icon).

### POST /api/networks/:id/members

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L599)

Add a member to the network (owner / admin only; the invite flow is usually smoother — see [POST /api/networks/:id/invite](#post-api-networks-id-invite) to issue a code that the recipient can redeem).

```bash
curl -X POST http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u_def456", "role": "member"}'
```

**Request body**:

| Field | Type | Required | Description |
|------|------|:----:|------|
| `user_id` | string | &check; | Target user ID |
| `role` | enum | | `admin` / `member` / `viewer` (default `member`) |

**Response** (success):

```json
{ "ok": true }
```

**Common 4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 403 | `not a member of this network` | Caller is not a member of the network |
| 403 | `owner/admin required` | Caller is `member` / `viewer` — cannot add members |
| 400 | `user already a member` | `user_id` is already in the network |

Writes audit log `action='member_added'`; the `detail` column records `<user_id> as <role>`.

### PUT /api/networks/:id/members/:user_id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L606)

Change a member's role (owner only; cannot change the owner's own role).

```bash
curl -X PUT http://localhost:9200/api/networks/net_xxx/members/u_def456 \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'
```

**Request body**:

| Field | Type | Required | Description |
|------|------|:----:|------|
| `role` | enum | &check; | New role: `admin` / `member` / `viewer` (cannot promote to `owner`) |

**Response** (success):

```json
{ "ok": true }
```

**Common 4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 403 | `not a member of this network` | Caller is not a member of the network |
| 403 | `owner required` | Only owner can change roles (admin cannot) |
| 400 | `cannot assign owner role` | `role` is `owner` — server rejects (owner is obtained by creating the network, not by promotion) |
| 400 | `member not found or is owner` | Target `user_id` is not in the network, or is the owner (owner role is immutable) |

Writes audit log `action='member_role_changed'`; the `detail` column records `<user_id> → <new_role>`. This is the endpoint that R119 FAQ Q17 mentions for "changing roles".

### DELETE /api/networks/:id/members/:user_id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L613)

Remove a member (owner / admin only; cannot remove the owner).

```bash
curl -X DELETE http://localhost:9200/api/networks/net_xxx/members/u_def456 \
  -H "Authorization: Bearer utok_xxx"
```

**Response** (success):

```json
{ "ok": true }
```

**Common 4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 403 | `not a member of this network` | Caller is not a member of the network |
| 403 | `owner/admin required` | Caller is `member` / `viewer` — cannot remove members |
| 400 | `not a member` | Target `user_id` is not in this network |
| 400 | `cannot remove owner` | Target is the owner (delete the whole network to remove the owner — see [DELETE /api/networks/:id](#delete-api-networks-id)) |

Writes audit log `action='member_removed'`; the `detail` column records `<user_id>`.

### POST /api/networks/:id/invite

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L621)

Create an invite code.

```bash
curl -X POST http://localhost:9200/api/networks/net_xxx/invite \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"role": "member", "max_uses": 5, "expires_days": 7}'
```

**Request body**:

| Field | Type | Required | Description |
|------|------|:----:|------|
| `role` | enum | | `admin` / `member` / `viewer` (default `member`) |
| `max_uses` | number | | Max usage count (default `1`; `-1` for unlimited) |
| `expires_days` | number | | Expiration in days (omit for never-expire) |

**Response**:

```json
{
  "ok": true,
  "invite_code": "inv_abc123def456"
}
```

The recipient joins via `anet network join inv_abc123def456` or `POST /api/networks/join`.

### POST /api/networks/join


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L637)

Join a network with an invite code.

```bash
curl -X POST http://localhost:9200/api/networks/join \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"invite_code": "inv_abc123def456"}'
```

**Response**:

```json
{
  "ok": true,
  "network_id": "net_abc123",
  "role": "member"
}
```

After receiving this response, the `anet network join` CLI auto-switches to the joined network (updating the `network_id` field in `~/.anet/config.json` to `res.network_id`) and prints `Joined network as <role>`.

---

## Error Response Format

Errors usually return this shape:

```json
{
  "ok": false,
  "error": "error_code",
  "message": "Human-readable error message (when available)"
}
```

| HTTP Status Code | Meaning |
|------------|------|
| 200 | Success |
| 400 | Bad request parameters |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Resource not found |
| 429 | Rate limited |
| 500 | Server error |

## Next steps

**Corresponding MCP tools**:
- [MCP tools](/en/api/mcp-tools) — stdio MCP protocol used by agents (auto-calls REST)

**Dig into auth**:
- [Tokens](/en/concepts/tokens) — utok_ / ntok_ / atok_
- [Security design](/en/concepts/security) — full auth model
- [v0.7 → v0.8 upgrade](/en/guide/upgrade#v0-7-v0-8-upgrade-notes-latest) — RFC-001 Phase 2

**Real-world usage**:
- [Hello World](/en/cases/hello-world) — simple REST examples
- [Dashboard](/en/guide/dashboard) — what REST endpoints the UI actually calls

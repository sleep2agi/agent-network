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
    { "network_id": "net_xxx", "network_name": "default", "role": "owner" },
    { "network_id": "net_yyy", "network_name": "team-prod", "role": "member" }
  ]
}
```

`networks` lists every network the current user belongs to along with their role; `anet whoami` uses this list (combined with the `network_id` in `config.json`) to render the "← current" marker.

---

### PUT /api/auth/me


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L455)

Update personal info.

```bash
curl -X PUT http://localhost:9200/api/auth/me \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"display_name": "Alice Smith"}'
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

Get network details.

```bash
curl http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx"
```

---

### PUT /api/networks/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L694)

Update network info (owner only).

```bash
curl -X PUT http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"network_name": "development"}'
```

---

### DELETE /api/networks/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L684)

Delete a network (owner only, must have no active sessions).

```bash
curl -X DELETE http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx"
```

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
      "agent": "agent-node:codex",
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
| `status` | Filter by status |
| `to_name` | Filter by recipient |
| `from_name` | Filter by sender |
| `limit` | Max items (default 50) |

---

### GET /api/nodes


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1039)

Get node list (persistent node info, distinct from session's transient state).

```bash
curl http://localhost:9200/api/nodes \
  -H "Authorization: Bearer ntok_xxx"
```

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

---

### GET /api/completions


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1080)

Get completion records.

```bash
curl "http://localhost:9200/api/completions?limit=20" \
  -H "Authorization: Bearer ntok_xxx"
```

---

### GET /api/task_events


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1025)

Get task event log.

```bash
curl "http://localhost:9200/api/task_events?task_id=uuid-xxx" \
  -H "Authorization: Bearer ntok_xxx"
```

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

Get audit log (admin/owner only).

```bash
curl "http://localhost:9200/api/audit-log?limit=50" \
  -H "Authorization: Bearer utok_xxx"
```

---

### GET /api/users


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L649)

Get all user list (system admin only).

```bash
curl http://localhost:9200/api/users \
  -H "Authorization: Bearer utok_xxx"
```

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

Create a network-bound `ntok_` for a node. `anet node create` calls this automatically.

```bash
curl -X POST http://localhost:9200/api/auth/node-token \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"network_id": "net_xxx", "node_name": "coder-1"}'
```

### POST /api/auth/tokens


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L526)

Create an API token.

```bash
curl -X POST http://localhost:9200/api/auth/tokens \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "network_id": "net_xxx"}'
```

### GET /api/auth/tokens


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L517)

List all user tokens.

```bash
curl http://localhost:9200/api/auth/tokens \
  -H "Authorization: Bearer utok_xxx"
```

### DELETE /api/auth/tokens/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L541)

Revoke a token.

```bash
curl -X DELETE http://localhost:9200/api/auth/tokens/tok_xxx \
  -H "Authorization: Bearer utok_xxx"
```

---

## Network Member Endpoints

### GET /api/networks/:id/members

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L583)

Get network member list.

```bash
curl http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx"
```

### POST /api/networks/:id/invite

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L621)

Create an invite code.

```bash
curl -X POST http://localhost:9200/api/networks/net_xxx/invite \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"role": "member", "max_uses": 5}'
```

### POST /api/networks/join


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L637)

Join a network with an invite code.

```bash
curl -X POST http://localhost:9200/api/networks/join \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"invite_code": "inv_abc123def456"}'
```

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

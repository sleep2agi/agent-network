# REST API Reference

CommHub Server provides a REST API for Dashboard, CLI, and third-party system integration.

## Basics

| Item | Value |
|-----|-----|
| Base URL | `http://YOUR_IP:9200` |
| Auth | `Authorization: Bearer <token>` **(recommended)**; `?token=<token>` URL query kept for SSE / browser EventSource (access-log leak risk — see [Security](/en/concepts/security)) |
| Content Type | `application/json` |
| Encoding | UTF-8 |
| Endpoint count | 30+ across **11 groups**: [Public 1](#public-endpoints) · [Auth 5](#auth-endpoints) · [Network 5](#network-endpoints) · [Data Query 9](#data-query-endpoints) · [Task Dispatch 2](#task-dispatch-endpoints) · [MCP 1](#mcp-endpoint) · [SSE 1](#sse-endpoint) · [Token Management 4](#token-management-endpoints) · [Network Members 6](#network-member-endpoints) · [Tmux Debug 2 (opt-in)](#tmux-debug-endpoints-opt-in) · [Legacy 2](#legacy-endpoints-v0-6-era-frozen-in-oss) |
| Full endpoint source | [`server/src/index.ts:389-1100`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L389) |

## Public Endpoints

### GET /health


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L726)

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


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L427)

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
    "email": "alice@example.com",
    "role": "admin"
  },
  "token": "utok_xxxxxxxxxxxxxxxx",
  "network_token": "ntok_xxxxxxxxxxxxxxxx",
  "network_id": "net_xxxxxxxx"
}
```

The `user` object's 5 fields match [`server/src/auth.ts:7-13`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L7) `AuthUser` interface (`display_name` / `email` may be `null`); `token` is the `utok_` for CLI/Dashboard; `network_token` is the `ntok_` for agents in the auto-created default network.

**Common 4xx errors** (verify [`auth.ts:30-48 register()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L30)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `username must be at least 2 characters` | Username < 2 chars |
| 400 | `username too long (max 50)` | Username > 50 chars |
| 400 | `username contains invalid characters` | Contains chars outside `a-zA-Z0-9_\-` or Chinese |
| 400 | `username already taken` | Duplicate username |
| 400 | `password must be at least 8 characters` | Non-bootstrap user password < 8 |
| 400 | `password must be at least 4 characters` | First user (bootstrap admin) password < 4 |
| 400 | `password is too common` | Hits the weak-password dictionary ([`password-dict.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/password-dict.ts); bootstrap admin is exempt) |
| 429 | `too many requests, try again later` | Exceeded 30/min IP rate limit ([`index.ts:429`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L429); localhost is exempt — see [Security — IP rate limits](/en/concepts/security#per-ip-limits)) |

**Rate limit**: 30 requests/minute per IP.

---

### POST /api/auth/login


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L442)

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
    "email": "alice@example.com",
    "role": "admin"
  },
  "token": "utok_xxxxxxxxxxxxxxxx",
  "network_id": "net_xxxxxxxx"
}
```

The `user` object's 5 fields match the register response (note `email` may be `null`); `network_id` is the default network the user owns ([`auth.ts:113-115`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L113) does `ORDER BY role = 'owner' DESC LIMIT 1`). Each login issues a **brand-new** `utok_` (existing tokens are not rotated, so multiple devices can log in independently — see [`auth.ts:102-110`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L102)).

**Common 4xx errors** (verify [`auth.ts:94-100 login()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L94)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 401 | `invalid username or password` | Username doesn't exist **or** password hash mismatch ([`auth.ts:99-100`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L99) intentionally collapses both into the same message to avoid username enumeration); the server also writes a `login_failed` audit row |
| 429 | `too many attempts, try again later` | Exceeded 10/min IP rate limit ([`index.ts:444`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L444); on hit the server writes a `login_rate_limited` audit row with the client IP) |

**Rate limit**: 10 requests/minute per IP.

---

### GET /api/auth/me


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L459)

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
    "email": "alice@example.com",
    "role": "admin"
  },
  "networks": [
    { "network_id": "net_xxx", "network_name": "default", "member_role": "owner" },
    { "network_id": "net_yyy", "network_name": "team-prod", "member_role": "member" }
  ],
  "current_network": "net_xxx"
}
```

`networks` lists every network the current user belongs to along with their `member_role` in that network (field name matches [GET /api/networks](#get-api-networks)); `anet whoami` uses this list (combined with the `network_id` in `config.json`) to render the "← current" marker. The `current_network` field is the network the server resolves from the **caller's token binding** (for `utok_` it's the `network_id` in `~/.anet/config.json`; for `ntok_` it's the network the token was issued for, which the hub enforces).

---

### PUT /api/auth/me


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L468)

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

Only the provided fields are updated ([server/src/index.ts:477-478](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L477) uses conditional SQL with `if (body.X)`); `username` / `role` / `password` are **not** mutable through this endpoint.

**Response** (success):

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

**Common 4xx errors** (verify [`server/src/index.ts:468-491`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L468)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `<JSON parse error>` | Request body is not valid JSON (the catch block echoes the exception message) |
| 401 | `token required` / `invalid token` | Missing / invalid utok_ |

::: info Missing fields are not an error
If you supply only `display_name` and omit `email` (or omit both), the server does not return 400 — [`index.ts:477-478`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L477) builds the SQL conditionally with `if (body.X)`. When everything is omitted it just re-SELECTs and returns the user as-is. **No field-length validation** here (schema-level checks are queued for v0.9+).
:::

---

### POST /api/auth/password


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L492)

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
  "revoked": 2,
  "token": "utok_xxxxxxxxxxxxxxxx",
  "token_id": "tok_new_session_id"
}
```

`revoked` is the number of utok\_/atok\_ tokens on **other devices** that were just revoked (it does **not** include the caller's own token — that one is revoked separately at index.ts L490).

**Key side effects** (verify [`auth.ts:267-282 changePassword + revokeOtherUserTokens`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L267) + [`index.ts:492-503`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L492)):
1. **The caller's `utok_`** (`resolved.tokenId`) is revoked immediately ([`index.ts:502`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L502) `revokeToken(...)` explicit delete)
2. **All other devices' `utok_` / `atok_`** are also revoked in one shot ([`auth.ts:269-270`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L269) `DELETE ... WHERE user_id=? AND network_id IS NULL AND token_id != ?currentTokenId`) — the count is returned in the `revoked` field
3. **`ntok_` tokens are unaffected** (`revokeOtherUserTokens` filters on `network_id IS NULL`, so agent nodes using `ntok_` keep running through a password change; matches the [account-system / Change Password](/en/guide/account-system#change-password) narrative)
4. **A fresh `utok_`** (`issued.token`) is minted for the caller and returned in this response — the caller must overwrite local storage with the new token right away
5. Writes audit log: `action='password_changed'`

Matches the `anet passwd` CLI behavior (the CLI writes the new token back into `~/.anet/config.json` automatically). Other devices' next request returns `401 invalid token` and they must `anet login` again.

**Common 4xx errors** (verify [`auth.ts:274-282 changePassword()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L274)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `new password must be at least 8 characters` | New password < 8 chars |
| 400 | `new password is too common` | Hits the weak-password dictionary ([`password-dict.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/password-dict.ts)) |
| 400 | `user not found` | `user_id` doesn't exist (rare; token expired or user deleted by admin) |
| 400 | `incorrect current password` | `old_password` hash mismatch |
| 401 | `token required` / `invalid token` | Missing / invalid utok_ |

::: tip Same strength rules as register
Password-strength validation reuses `validatePasswordStrength()` from register (see [POST /api/auth/register 4xx](#post-api-auth-register)). The bootstrap-admin exemption applies only to the first signup — **no exemption for password change**.
:::

---

## Network Endpoints

### GET /api/networks


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L566)

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
      "description": "Auto-created default network",
      "settings": null,
      "visibility": "private",
      "max_members": 50,
      "created_at": "2026-04-12 10:00:00",
      "updated_at": "2026-04-12 10:00:00",
      "member_role": "owner"
    }
  ]
}
```

Each row in `networks` has 10 fields: the 9 `networks` table columns ([`server/src/db.ts:168-177`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L168), including the v3 migrations `visibility` + `max_members`) plus the joined `member_role` ([`auth.ts:382-388`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L382) joins `network_members`). Sort order: owner first, then by `created_at` (`ORDER BY nm.role = 'owner' DESC, n.created_at`). `settings` / `description` may be `null`. An `ntok_` caller sees only the bound network (not the full list); a `utok_` caller sees every network they belong to.

---

### POST /api/networks


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L581)

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

**Response** (success):

```json
{
  "ok": true,
  "network_id": "net_xyz789",
  "network_name": "prod"
}
```

**Common 4xx errors** (verify [`auth.ts:182-206 createNetwork()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L182)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `network name already exists` | Same owner already has a network with this name (`UNIQUE(owner_id, network_name)` constraint) |
| 400 | `quota exceeded: max N networks for free plan` | Plan quota gate ([`auth.ts:196-200`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L196); admins are exempt; free plan default `max_networks_owned = 2`). Note this gate **is** enforced, unlike the `max_members` column flagged in R178 |
| 401 | `token required` / `invalid token` | Missing / invalid utok_ |

---

### GET /api/networks/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L674)

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
    "settings": null,
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

The `network` object has 9 fields = `SELECT * FROM networks WHERE network_id = ?1` ([`server/src/index.ts:680`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L680)), including the v3 migrations `visibility` + `max_members`. The `settings` column is reserved for future per-network JSON config and is currently always `null`. `stats.tasks` is aggregated by status (same shape as the nested `tasks.by_status` in [GET /api/stats](#get-api-stats)).

---

### PUT /api/networks/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L707)

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

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L697)

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


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L762)

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
  ],
  "summary": {
    "idle": 7,
    "working": 1,
    "offline": 2,
    "total": 10
  }
}
```

The `summary` field is a count aggregated by status ([`server/src/index.ts:780-787`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L780)): the `working` bucket collapses `working / blocked / error / waiting_input / running / busy`; `offline` is sessions whose `updated_at` is older than 10 minutes (the server recomputes this on every GET and writes back to the DB); everything else counts as `idle`.

---

### GET /api/tasks


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1073)

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
      "task_id": "t_a1b2c3d4",
      "from_node_id": null,
      "from_name": "commander",
      "to_node_id": "node_xxx",
      "to_name": "coder-1",
      "priority": "normal",
      "status": "replied",
      "content": "Write a Python quicksort",
      "result": "Done — quicksort implementation attached",
      "in_reply_to": null,
      "requires_response": "reply",
      "scope": "single",
      "created_at": "2026-04-12 10:00:00",
      "delivered_at": "2026-04-12 10:00:01",
      "started_at": "2026-04-12 10:00:02",
      "completed_at": "2026-04-12 10:00:15",
      "expires_at": "2026-04-12 11:00:00"
    }
  ],
  "count": 1,
  "stats": [
    { "status": "replied", "count": 85 },
    { "status": "running", "count": 5 }
  ]
}
```

Field mapping to the `tasks` table schema ([`server/src/db.ts:87-105`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L87)) via `SELECT *`: the primary key is `task_id` (not `message_id`); the completion timestamp is `completed_at` (not `replied_at`); the TTL field is `expires_at` (an absolute timestamp), not `ttl_seconds` — `ttl_seconds` is **input-only** on `send_task` and converted to `expires_at` when the row is written. The `anet tasks` CLI uses `from_name` / `to_name` / `status` / `created_at` / `content` to render the table (cli.ts L2810-2817).

---

### GET /api/nodes


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1059)

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


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L955)

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
      "id": "m_abc123",
      "from_alias": "coder-1",
      "to_alias": "commander",
      "type": "reply",
      "priority": "normal",
      "content": "[coder-1] Done, used quicksort",
      "created_at": "2026-04-12 10:00:15",
      "network_id": "net_xxxxx"
    },
    {
      "id": "m_def456",
      "from_alias": "commander",
      "to_alias": "coder-1",
      "type": "task",
      "priority": "normal",
      "content": "Write a quicksort",
      "created_at": "2026-04-12 10:00:00",
      "network_id": "net_xxxxx"
    }
  ]
}
```

Field mapping to the server `SELECT` ([`server/src/index.ts:959`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L959)) `id, session_name as to_alias, from_session as from_alias, type, priority, content, created_at, network_id` — the primary key is `id` (not `message_id`); the response also includes `priority` + `network_id`, which earlier doc omitted.

::: info Current schema caveat
The SELECT doesn't include `in_reply_to` yet; reply-polling uses a heuristic of `from_alias` + `type='reply'` + recency (see comment at `cli.ts:3827`).
:::

---

### GET /api/completions


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1100)

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


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1045)

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


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L968)

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

### GET /api/server-logs

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1008)

Read the last N lines from the hub process's **in-memory console-log ring buffer** (debug aid). **`users.role = 'admin'` only** (same system-admin gate as [GET /api/users](#get-api-users) / [GET /api/audit-log](#get-api-audit-log) — **not** the per-network admin role). Buffer capacity defaults to 500 lines and is configurable via `COMMHUB_LOG_RING` ([`index.ts:39`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L39)).

```bash
curl "http://localhost:9200/api/server-logs?limit=100" \
  -H "Authorization: Bearer utok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `limit` | Max lines (default 200; capped at `COMMHUB_LOG_RING`, which defaults to 500) |
| `since` | ISO 8601 timestamp; only return entries with `ts > since` (incremental polling) |

**Response**:

```json
{
  "ok": true,
  "logs": [
    { "ts": "2026-04-12T10:00:00.123Z", "level": "log", "line": "[10:00:00] coder-1 (sdk-n_xxx) → report_status: working | quicksort" },
    { "ts": "2026-04-12T10:00:01.456Z", "level": "warn", "line": "⚠ deprecation: ..." }
  ],
  "capacity": 500
}
```

Sorted **newest first**; each `line` is truncated to 4000 chars ([`index.ts:45`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L45)). **The buffer is cleared on process restart** — this is not persistent storage. For durable logs, redirect stdout to a file or journald.

**4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 401 | `auth required` / `invalid token` | Missing / invalid utok_ |
| 403 | `admin only` | Caller is not `users.role = 'admin'` (only the first registered user is admin by default) |

---

### GET /api/audit-log


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1024)

Get the audit log. **Permissions: any authenticated user can call this endpoint, but non-**system admin** callers only see their own log rows** (the server adds `WHERE user_id = <caller>` automatically when `users.role !== 'admin'` — see [`server/src/index.ts:1035`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1035)). System admin (`users.role = 'admin'`) sees everything and can filter by any `user_id`.

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
      "action": "network_renamed",
      "target_type": "network",
      "target_id": "net_xyz789",
      "detail": "prod-v2",
      "created_at": "2026-04-12 09:55:00"
    }
  ],
  "count": 2
}
```

The fields are `logs` + `count` (**not** `audit_log` — earlier doc was wrong). The `audit_log` **table** schema is in [`server/src/db.ts:201-212`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L201) — 10 columns including `ip` and `network_id`. **Full `action` value list with triggers** is in [Security — Audit log](/en/concepts/security#audit-logging).

::: warning `create_network` is NOT audited
POST `/api/networks` does not call `logAudit`, so audit_log will **never** contain a `create_network` row. To track network creation, diff [`GET /api/networks`](#get-api-networks) or infer it from `target_type='network' + action='network_renamed'` records (R195 finding; same `::: info` lives in [security.md audit log](/en/concepts/security#audit-logging)).
:::

---

### GET /api/users


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L662)

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

## Task Dispatch Endpoints

REST equivalents of the `send_task` / `broadcast` MCP tools (non-MCP path, suitable for webhooks / reverse proxies / Dashboard).

### POST /api/task

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L791)

REST version of `send_task`: writes inbox + tasks rows for a target alias and pushes `new_task` over SSE.

```bash
curl -X POST http://localhost:9200/api/task \
  -H "Authorization: Bearer ntok_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "coder-1",
    "task": "Write a quicksort",
    "priority": "high",
    "ttl_seconds": 7200
  }'
```

**Request body** (verify [`TaskSchema`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L228)):

| Field | Type | Required | Description |
|------|------|:----:|------|
| `alias` | string | &check; | Target agent alias (max 200) |
| `task` | string | &check; | Task content (max 10000) |
| `priority` | enum | | `high` / `normal` (default) / `low` |
| `from` | string | | Sender identifier (default `"api"`) |
| `network_id` | string | | Target network (utok\_ caller; ntok\_ is force-bound) |
| `ttl_seconds` | number | | Expiry in seconds (default 3600). Not part of the schema — server reads it directly from `body.ttl_seconds` at [`index.ts:822`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L822). |

**Response** (success):

```json
{ "ok": true, "message_id": "uuid-xxx" }
```

**Common 4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `invalid JSON` | Body failed to parse |
| 400 | `invalid input` | Fields fail `TaskSchema` (response also contains a `details` field with the zod error) |
| 400 | `network_id required for user token when multiple networks are available` | utok\_ caller has multiple networks; must specify `network_id` |
| 403 | `access denied to requested network` | utok\_ caller is not a member of `network_id` |
| 403 | `permission_denied` | Role is insufficient (viewer cannot write) |

A `new_task` SSE event is pushed to the target alias on success.

### POST /api/broadcast

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L862)

REST version of `broadcast`: writes inbox rows for a group of sessions and pushes `broadcast` SSE events.

```bash
curl -X POST http://localhost:9200/api/broadcast \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Standup in 5 minutes; please save progress",
    "filter_status": "idle"
  }'
```

**Request body** (verify [`BroadcastSchema`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L236)):

| Field | Type | Required | Description |
|------|------|:----:|------|
| `message` | string | &check; | Broadcast content (max 10000; **the field is `message`, not `content`**) |
| `filter_server` | string | | Only deliver to sessions whose `server` field matches |
| `filter_status` | string | | Only deliver to sessions in the given status (e.g. `idle` / `working`) |

> Same field set as the MCP [`broadcast`](mcp-tools#broadcast) tool (R189 fixed it there too). `from_session` is **not** a parameter — the server hard-codes `'api'` ([`index.ts:891`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L891); the MCP version uses `'hub'`).

**Response** (success):

```json
{
  "ok": true,
  "recipients": 10,
  "message_ids": ["uuid-1", "uuid-2"]
}
```

`message_ids.length === recipients` — one inbox row per target session.

**Common 4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `invalid JSON` / `invalid input` | Body parse or schema validation failed |
| 400 | `network_id required for user token when broadcasting` | utok\_ caller has multiple networks; pass `?network_id=…` or use an ntok\_ instead |
| 403 | `permission_denied` | Role is insufficient (viewer cannot write) |

---

## MCP Endpoint

### POST /mcp

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L326)

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

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L355)

SSE real-time push endpoint. Agents receive events via long connections.

```bash
# Recommended: Authorization header (keeps the token out of proxies / browser history / access logs)
curl -N -H "Authorization: Bearer ntok_xxx" http://localhost:9200/events/coder-1

# Compat: URL query token (kept for browser native EventSource, but logs leak risk — see [Security](/en/concepts/security))
curl -N "http://localhost:9200/events/coder-1?token=ntok_xxx"
```

**Pushed event types** (verify `grep pushEvent server/src/tools.ts`):

| Event | Trigger | Data |
|------|---------|------|
| `connected` | Initial connection handshake ([`push.ts:35`](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts#L35); emitted once per SSE client when the stream opens) | `{session, network_id}` |
| `new_task` | New task received (`send_task` / `retry_task` / `reassign_task` / REST `POST /api/task`) | `{inbox_count, priority, from}` |
| `new_message` | New chat message (`send_message`) | `{from, message_id}` |
| `new_reply` | Reply to a task (`send_reply`) | `{from, message_id, in_reply_to, status}` |
| `broadcast` | Broadcast received (`broadcast` tool) | `{inbox_count}` |
| `chained_reply` | Sub-task completion routed back to the parent task's originator ([`tools.ts:286/646`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L286)) | `{parent_task_id, child_task_id, child_alias}` |

> Earlier docs claimed `new_message` carried a `message` field and `broadcast` carried `{content, from}` — neither is correct. Verify [`tools.ts:571 + 911`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L571) for the actual payloads.
>
> **R275 calibration**: the table previously listed a `heartbeat` event with `{time}` payload. No such JSON event is emitted. [`push.ts:38-44`](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts#L38) sends an SSE **comment line** `: keepalive\n\n` every 30s purely to defeat proxy/LB idle timeouts — comments are NOT delivered to `EventSource.onmessage` / `addEventListener` and carry no payload. The real once-per-connection initial event is `connected` (agent-node handles it explicitly at [`agent-node/src/cli.ts:1162`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L1162)).

**Example SSE data stream**:

```
event: connected
data: {"type":"connected","session":"coder-1","network_id":"net_xxx"}

event: new_task
data: {"type":"new_task","inbox_count":1,"priority":"high","from":"commander"}

: keepalive

: keepalive
```

---

## Token Management Endpoints

### POST /api/auth/node-token


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L513)

Create a network-bound `ntok_` for a node. `anet node create` calls this automatically and writes the result into `.anet/nodes/<node-name>/config.json` `token` field.

```bash
curl -X POST http://localhost:9200/api/auth/node-token \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"network_id": "net_xxx", "node_name": "coder-1"}'
```

**Response** (success):

```json
{
  "ok": true,
  "token": "ntok_xxxxxxxxxxxxxxxx"
}
```

The `token` is the `ntok_` for that `(node_name, network_id)` pair. The hub force-binds the `network_id` to the token — when an agent calls MCP with this token, the server locks operations to that network and rejects cross-network access. See [Tokens — ntok_](/en/concepts/tokens) for more.

**Common 4xx errors** (verify [`auth.ts:130-141 createNetworkTokenForNode()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L130) + [`index.ts:513-529` route](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L513)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `network_id and node_name required` | Body is missing `network_id` or `node_name` |
| 400 | `not a member of this network` | Caller is not in `network_id` (must `join` first to mint an `ntok_`) |
| 400 | `no write access to this network` | Caller is `viewer` (viewers cannot create full-access network tokens) |
| 401 | `auth required` / `invalid token` | Missing / invalid utok_ |

### POST /api/auth/tokens


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L539)

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
  "token": "atok_xxxxxxxxxxxxxxxx",
  "token_id": "tok_abc123def456"
}
```

::: warning The plaintext token is returned only once
The `token` field is the plaintext token, **returned exactly once at creation** — the hub stores only its hash. If you lose it, use [DELETE /api/auth/tokens/:id](#delete-api-auth-tokens-id) to revoke + create a fresh one.
:::

::: info This endpoint creates the legacy `atok_`
This path goes through [`auth.ts:243` `generateToken()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L243), which issues an `atok_` prefix + `scope='full'` token — a V2-era compatibility path, not the v0.8 mainline (`utok_` / `ntok_`). For new code:
- **`utok_` (user token)**: issued automatically by [POST /api/auth/login](#post-api-auth-login) or [POST /api/auth/register](#post-api-auth-register)
- **`ntok_` (network token)**: created via [POST /api/auth/node-token](#post-api-auth-node-token) (bound to a network + node alias)

See [Token system](/en/concepts/tokens) for the full picture.
:::

### GET /api/auth/tokens


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L530)

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
      "name": "node:coder-1",
      "scope": "network",
      "network_id": "net_xxxxxxxx",
      "last_used_at": "2026-04-12 10:00:00",
      "created_at": "2026-04-10 09:00:00"
    },
    {
      "token_id": "tok_xyz789",
      "name": "user-login",
      "scope": "user",
      "network_id": null,
      "last_used_at": null,
      "created_at": "2026-04-12 10:30:00"
    }
  ]
}
```

The 6 fields per row map directly to [`auth.ts:209-213`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L209) `listTokens` SELECT: `token_id / name / scope / network_id / last_used_at / created_at`. `scope` is one of `user` (utok\_) / `network` (ntok\_) / `full` (legacy atok\_); `network_id` is only set for `network` / `full` scope. Sorted by `created_at DESC`. The plaintext `token` field is **not** returned here (only at POST creation).

### DELETE /api/auth/tokens/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L554)

Revoke a token (immediate server-side invalidation — distinct from `anet logout` which only clears the local token).

```bash
curl -X DELETE http://localhost:9200/api/auth/tokens/tok_xxx \
  -H "Authorization: Bearer utok_xxx"
```

**Response** (success):

```json
{ "ok": true }
```

**4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 404 | `token not found` | `token_id` does not exist or does not belong to the current user ([`auth.ts:252-254`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L252) `DELETE ... WHERE token_id=?1 AND user_id=?2` affects 0 rows) |

Writes audit log `action='token_revoked'`. After revocation, the next request using that token returns 401 `invalid token`.

---

## Network Member Endpoints

### GET /api/networks/:id/members

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L607)

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

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L612)

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

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L619)

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

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L626)

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

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L634)

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

**Response** (success):

```json
{
  "ok": true,
  "invite_code": "inv_abc123def456"
}
```

**Common 4xx errors** (verify [`auth.ts:344-356 createInvite()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L344) + [`index.ts:634` route handler](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L634)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `invalid role` | `role` is not one of `admin` / `member` / `viewer` |
| 403 | `not a member of this network` | Caller is not a member of the network ([`index.ts:641` callerRole gate](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L641)) |
| 403 | `owner/admin required` | Caller is `member` / `viewer` — cannot issue invites |

The recipient joins via `anet network join inv_abc123def456` or `POST /api/networks/join`. `invite_code` is `inv_` prefix + 12 characters (`auth.ts:346` `slice(0, 12)`).

### POST /api/networks/join


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L650)

Join a network with an invite code.

```bash
curl -X POST http://localhost:9200/api/networks/join \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"invite_code": "inv_abc123def456"}'
```

**Response** (success):

```json
{
  "ok": true,
  "network_id": "net_abc123",
  "role": "member"
}
```

**Common 4xx errors** (verify [`auth.ts:358-378 joinByInvite()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L358)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `invalid invite code` | `invite_code` does not exist |
| 400 | `invite code fully used` | `used_count >= max_uses` (max_uses=-1 means unlimited) |
| 400 | `invite code expired` | `expires_at < now()` (omit `expires_days` to create a never-expire code) |
| 400 | `already a member of this network` | Caller is already a member |

After receiving this response, the `anet network join` CLI auto-switches to the joined network (updating the `network_id` field in `~/.anet/config.json` to `res.network_id`) and prints `Joined network as <role>`. The server also auto-issues a network-bound token for the joiner ([`auth.ts:374-377`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L374), `name='auto-join' scope='full'`) and writes a `network_joined` audit row.

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

---

## Tmux Debug Endpoints (opt-in)

::: warning Off by default
Only available when the hub is started with `COMMHUB_ENABLE_TMUX=1` ([`index.ts:13`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L13)). **Otherwise all paths return 404 `tmux disabled`**. Even when enabled, you still need (a) the caller IP to be inside `COMMHUB_TMUX_ALLOWLIST` (comma-separated, defaults to localhost only; verify [`index.ts:16`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L16)) and (b) `users.role = 'admin'` system-admin auth. Intended use: expose tmux sessions running agents on the hub machine to local devs / Dashboard. **Never expose on the public internet.**
:::

### GET /api/tmux/:name

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L903)

Capture the tail of a tmux session's current pane (`tmux capture-pane -t <name> -p` wrapper).

```bash
curl "http://localhost:9200/api/tmux/anet-node-coder-1?lines=50" \
  -H "Authorization: Bearer utok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `lines` | Tail line count (default 30) |

**Response** (success):

```json
{ "ok": true, "tmux_name": "anet-node-coder-1", "lines": 50, "output": "...captured pane content..." }
```

### POST /api/tmux/:name/send

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L927)

Send keys into a tmux session (`tmux send-keys -t <name> "<text>" Enter` wrapper).

```bash
curl -X POST "http://localhost:9200/api/tmux/anet-node-coder-1/send" \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"text": "/help", "enter": true}'
```

**Request body**:

| Field | Type | Required | Description |
|------|------|:----:|------|
| `text` | string | &check; | Keys to send |
| `enter` | boolean | | Append Enter (default `true`) |

**4xx errors (shared by both endpoints)**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 404 | `tmux disabled` | `COMMHUB_ENABLE_TMUX=1` not set |
| 403 | `tmux access denied from this ip` | Caller IP outside `COMMHUB_TMUX_ALLOWLIST` (defaults to localhost only) |
| 401 / 403 | Admin auth required (same gate as [GET /api/server-logs](#get-api-server-logs)) |
| 400 | `text is required` (POST only) | Body missing `text` |
| 400 | `<tmux stderr>` | `tmux` subprocess exited non-zero (e.g. session not found) |

### GET /ws/tmux/:name

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L318)

WebSocket endpoint — live-streams a tmux session's pane output. It's the live counterpart of `GET /api/tmux/:name`: the HTTP one is a one-shot `capture-pane`, this one keeps streaming once connected. Auth gating is **identical** to the two HTTP endpoints above (same `requireTmuxAccess` — `COMMHUB_ENABLE_TMUX=1` + caller IP in `COMMHUB_TMUX_ALLOWLIST` + `users.role='admin'` auth; any failure is rejected before the WS upgrade).

```
ws://localhost:9200/ws/tmux/anet-node-code1
```

Once connected the server periodically runs `tmux capture-pane` and pushes the pane content; polling stops automatically on disconnect. Same rule — **never expose this on the public internet**.

---

## Legacy Endpoints (v0.6 era — frozen in OSS)

::: warning Not required since Apache 2.0
Since v0.8 the project is Apache 2.0 open-source + self-hosted — there is no official paid license. The two endpoints below are leftovers from the v0.6 trial/activation flow. The hub still keeps a `licenses` table and an initial 14-day trial as a safety net, but new users and the main docs do not need to touch them. If you hit `license_expired`, see [troubleshooting](/en/troubleshooting#license-expired-legacy-behavior).
:::

### GET /api/license

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L389)

Reads the first row of the `licenses` table (by `created_at` ascending) and returns trial / pro status with `days_left`.

```bash
curl http://localhost:9200/api/license
# → Public endpoint (no Authorization header required)
```

**Response** (trial / pro):

```json
{
  "ok": true,
  "license": { "type": "trial", "expires_at": "2026-04-25 12:00:00", "days_left": 12, "expired": false },
  "limits": { "max_agents": 5, "max_networks": 1, "max_tasks_day": 100 }
}
```

**Response** (no license row):

```json
{ "ok": true, "status": "no_license" }
```

### POST /api/license/activate

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L404)

Inject a pro license key. [`index.ts:410`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L410) only checks that `key.startsWith('anet-') && length >= 16` — **there is no real server-side validation**. The endpoint deletes any existing license row and writes a fresh pro license (limits 50 agents / 10 networks / 10000 tasks/day, expires in 365 days).

```bash
curl -X POST http://localhost:9200/api/license/activate \
  -H "Content-Type: application/json" \
  -d '{"key": "anet-anything-16-plus-chars"}'
```

**Response** (success):

```json
{ "ok": true, "type": "pro", "expires_in_days": 365 }
```

**4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `key required` | Body missing `key` |
| 400 | `invalid license key` | `key` does not start with `anet-` or is < 16 chars (**prefix-and-length check only, no real signature**) |

> Effectively a self-service bypass kept around purely so that anyone hitting `license_expired` has an escape hatch in the OSS era. See [troubleshooting — license_expired](/en/troubleshooting#license-expired-legacy-behavior) and [CLI `anet activate`](/en/guide/cli#other).

---

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

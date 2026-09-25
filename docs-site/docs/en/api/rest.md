<script setup>
// Old deep links (/api/rest#<anchor>) whose section moved to a sub-page when the
// REST reference was split (docs slimming, 2026-09-25): forward them.
import { onMounted } from 'vue'
const moved = { data: ["data-query-endpoints", "get-api-status", "get-api-tasks", "get-api-task", "get-api-nodes", "get-api-host-supervisors", "delete-api-nodes-ref", "get-api-servers", "get-api-server-host-health", "get-api-server-host-agents", "get-api-messages", "get-api-messages-scope-user", "get-api-node-create-requests", "post-api-messages-ack", "get-api-completions", "get-api-task-events", "get-api-stats", "get-api-server-logs", "get-api-audit-log", "get-api-users", "task-dispatch-endpoints", "post-api-task", "mcp-first-delegation-and-rest-fallback", "post-api-broadcast", "mcp-endpoint", "post-mcp", "sse-endpoint", "get-events-name"], admin: ["token-management-endpoints", "post-api-auth-node-token", "post-api-auth-tokens", "get-api-auth-tokens", "delete-api-auth-tokens-id", "network-member-endpoints", "get-api-networks-id-members", "post-api-networks-id-members", "put-api-networks-id-members-user-id", "delete-api-networks-id-members-user-id", "post-api-networks-id-invite", "post-api-networks-join", "file-endpoints", "post-api-upload", "get-api-files-file-id", "node-rename-endpoints-rfc-010", "post-api-node-rename-prepare", "post-api-node-rename-commit", "post-api-node-rename-abort", "tmux-debug-endpoints-opt-in", "get-api-tmux-name", "post-api-tmux-name-send", "get-ws-tmux-name", "legacy-endpoints-v0-6-era-—-frozen-in-oss", "get-api-license", "post-api-license-activate"] }
onMounted(() => {
  const id = decodeURIComponent(window.location.hash.slice(1))
  if (!id) return
  const page = moved.data.includes(id) ? 'rest-data' : moved.admin.includes(id) ? 'rest-admin' : null
  if (page) window.location.replace('/en/api/' + page + '#' + encodeURIComponent(id))
})
</script>

# REST API Reference

CommHub Server provides a REST API for Dashboard, CLI, and third-party system integration.

## Basics

| Item | Value |
|-----|-----|
| Base URL | `http://YOUR_IP:9200` |
| Auth | `Authorization: Bearer <token>` **(recommended)**; `?token=<token>` URL query kept for SSE / browser EventSource (access-log leak risk — see [Security](/en/concepts/security)) |
| Content Type | `application/json` |
| Encoding | UTF-8 |
| Endpoint count | 30+ across **13 groups**: [Public 1](#public-endpoints) · [Auth 5](#auth-endpoints) · [Network 5](#network-endpoints) · [Data Query 10](/en/api/rest-data#data-query-endpoints) · [Task Dispatch 2](/en/api/rest-data#task-dispatch-endpoints) · [MCP 1](/en/api/rest-data#mcp-endpoint) · [SSE 1](/en/api/rest-data#sse-endpoint) · [Token Management 4](/en/api/rest-admin#token-management-endpoints) · [Network Members 6](/en/api/rest-admin#network-member-endpoints) · [Files 2](/en/api/rest-admin#file-endpoints) · [Node Rename 3](/en/api/rest-admin#node-rename-endpoints-rfc-010) · [Tmux Debug 3 (opt-in)](/en/api/rest-admin#tmux-debug-endpoints-opt-in) · [Legacy 2](/en/api/rest-admin#legacy-endpoints-v0-6-era-—-frozen-in-oss) |
| Full endpoint source | [`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) |

## Public Endpoints

### GET /health


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Health check, no authentication required.

```bash
curl http://localhost:9200/health
```

```json
{
  "ok": true,
  "version": "0.8.8",
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

> 🔴 **This sample was captured, not hand-written** — on 2026-08-13, from
> `bunx --bun @sleep2agi/commhub-server@0.8.8` in a clean container, as the raw
> response to an **unauthenticated** `curl /health`.
>
> **The two channels return different keys** — parse `/health` per channel:
>
> 🔴 **`latest` moved from `0.8.8` to `0.9.0-preview.30` on 2026-08-27 (contains the redaction fix `7bacb729`).**
> The text below describes **versions**, not channels — channels move, versions do not.
> Check the current pointer with `npm view @sleep2agi/commhub-server dist-tags`.
>
> | Key | `0.8.8` | `0.9.0-preview.29` |
> |---|---|---|
> | `sse_sessions` | **returned even unauthenticated, and unredacted** | not returned unauthenticated |
> | `limits` | absent | present |
>
> The other 13 keys were present on both **in this capture** — one sample per
> channel, not a permanent contract.

::: danger On `0.8.8`, `sse_sessions` exposes every connected agent to anonymous callers
The sample above shows `{}` **only because that clean container had zero SSE
connections**. **Do not read it as "latest leaks nothing."**

`/health` redaction landed in [#473](https://github.com/sleep2agi/agent-network/issues/473)
on **2026-07-29** (`7bacb729`). `commhub-server@0.8.8` was published **2026-06-24** —
**35 days earlier, so `0.8.8` does not contain the fix.**

On a `0.8.8` hub with live connections, anonymous `GET /health` returns the
per-connection `{networkId}:{alias}` breakdown. The public-hub audit on 2026-07-30
retrieved the network id plus **all 95 agent aliases** in one unauthenticated
request; see `server/src/health-redaction.test.ts`.

So the difference between channels is not "key present / key absent":

- **`0.8.8`** — anonymous callers can read the full live-session breakdown
  (which is empty only on an idle hub);
- **preview `0.9.0-preview.22` and later** — anonymous callers get aggregate counts
  only; the breakdown moved behind auth at `GET /api/stats/sse`;
- ⚠️ **preview `0.9.0-preview.0` through `.21` leak just like `0.8.8`** — published
  2026-06-28 … 07-04, i.e. **before the fix**. Do not treat "preview" as safe wholesale.

Confirm this before exposing a `0.8.8` hub to the public internet.
:::

Code that treats *key presence* as an authorization signal will also behave
differently across the two channels.

Read the anonymous response **per channel**, per the table and the warning above:
on preview the key is absent entirely and anonymous callers get aggregate counts
only; on `0.8.8` the key is emitted **unredacted** — empty on an idle hub,
and a full `{networkId}:{alias}` breakdown as soon as anything connects.

With a valid token, a system admin, legacy master, or DEV_OPEN
caller can receive the full map; regular `utok_` / `ntok_` callers receive only
sessions from networks they may access (or an empty object when they belong to
none).

::: tip The `license` field is a v0.6 legacy
`license: "trial"` is a leftover from the v0.6 era 14-day trial mechanism. After the Apache 2.0 OSS transition it is **no longer a commercial feature gate** (self-hosted has no notion of "expired"). The `send_task` path still runs the trial check only for backward compatibility (verify [`server/src/tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) where `license_expired` is still emitted); if you hit it, see [troubleshooting](/en/troubleshooting). **The v0.9.x and v0.10.x scopes did not touch this** (Recovery & Observability took priority); full removal is queued for v0.11+ / unscheduled.
:::

---

## Auth Endpoints

### POST /api/auth/register


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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
| `username` | string | &check; | Username (2-50 chars, letters/numbers/underscores/hyphens/Chinese) |
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

The `user` object's 5 fields match [`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) — grep `interface AuthUser` `AuthUser` interface (`display_name` / `email` may be `null`); `token` is the `utok_` for CLI/Dashboard; `network_token` is the `ntok_` for agents in the network auto-created at registration.

**Common 4xx errors** (verify [`auth.ts register()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `username must be at least 2 characters` | Username < 2 chars |
| 400 | `username too long (max 50)` | Username > 50 chars |
| 400 | `username contains invalid characters` | Contains chars outside `a-zA-Z0-9_\-` or Chinese |
| 400 | `username already taken` | Duplicate username |
| 400 | `password must be at least 8 characters` | Non-bootstrap user password < 8 |
| 400 | `password must be at least 4 characters` | First user (bootstrap admin) password < 4 |
| 400 | `password is too common` | Hits the weak-password dictionary ([`password-dict.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/password-dict.ts); bootstrap admin is exempt) |
| 429 | `too many requests, try again later` | Exceeded 30/min IP rate limit ([`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts); localhost is exempt — see [Security — IP rate limits](/en/concepts/security#per-ip-limits)) |

**Rate limit**: 30 requests/minute per IP.

---

### POST /api/auth/login


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

The `user` object's 5 fields match the register response (note `email` may be `null`); `network_id` is the default network the user owns ([`auth.ts:197-199`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L197) does `ORDER BY role = 'owner' DESC LIMIT 1`). Each login issues a **brand-new** `utok_` (existing tokens are not rotated, so multiple devices can log in independently — see [`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) — grep `// User token (utok_) — not bound to network, for CLI/Dashboard login`).

**Common 4xx errors** (verify [`auth.ts login()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 401 | `invalid username or password` | Username doesn't exist **or** password hash mismatch ([`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) — grep `invalid username or password` (2 sites) intentionally collapses both into the same message to avoid username enumeration); the server also writes a `login_failed` audit row |
| 429 | `rate_limited` | Exceeded 10/min IP rate limit ([`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts); on hit the server writes a `login_rate_limited` audit row with the client IP) |

**Rate limit**: 10 requests/minute per IP.

Full 429 **response body** (the `error` field is `rate_limited` — it is not the prose message):

```json
{ "ok": false, "error": "rate_limited",
  "message": "Too many login attempts. Try again later.",
  "retry_after_ms": 42000 }
```

A `Retry-After` header is also returned (in seconds, `retry_after_ms` rounded up).
Match on the `error` field, not on `message`.

---

### GET /api/auth/me


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

Only the provided fields are updated ([server/src/server.ts](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) uses conditional SQL with `if (body.X)`); `username` / `role` / `password` are **not** mutable through this endpoint.

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

**Common 4xx errors** (verify [`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `<JSON parse error>` | Request body is not valid JSON (the catch block echoes the exception message) |
| 401 | `token required` / `invalid token` | Missing / invalid utok_ |

::: info Missing fields are not an error
If you supply only `display_name` and omit `email` (or omit both), the server does not return 400 — [`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) builds the SQL conditionally with `if (body.X)`. When everything is omitted it just re-SELECTs and returns the user as-is. **No field-length validation** here (the v0.9.x and v0.10.x scopes did not touch this; schema-level checks are queued for v0.11+ / unscheduled).
:::

---

### POST /api/auth/password


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

`revoked` is the number of utok\_/atok\_ tokens on **other devices** that were just revoked (it does **not** include the caller's own token — that one is revoked separately by `revokeToken(resolved.user.user_id, resolved.tokenId)` in the password-change handler in `server.ts`).

**Key side effects** (verify [`auth.ts` `changePassword` + `revokeOtherUserTokens`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L417) + [`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)):
1. **The caller's `utok_`** (`resolved.tokenId`) is revoked immediately ([`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) `revokeToken(...)` explicit delete)
2. **All other devices' `utok_` / `atok_`** are also revoked in one shot ([`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) — grep `network_id IS NULL AND token_id != ` `DELETE ... WHERE user_id=? AND network_id IS NULL AND token_id != ?currentTokenId`) — the count is returned in the `revoked` field
3. **`ntok_` tokens are unaffected** (`revokeOtherUserTokens` filters on `network_id IS NULL`, so agent nodes using `ntok_` keep running through a password change; matches the [account-system / Change Password](/en/guide/account-system#change-password) narrative)
4. **A fresh `utok_`** (`issued.token`) is minted for the caller and returned in this response — the caller must overwrite local storage with the new token right away
5. Writes audit log: `action='password_changed'`

Matches the `anet passwd` CLI behavior (the CLI writes the new token back into `~/.anet/config.json` automatically). Other devices' next request returns `401 invalid token` and they must `anet login` again.

**Common 4xx errors** (verify [`auth.ts changePassword()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)):

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


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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
      "network_name": "alice",
      "owner_id": "u_abc123",
      "description": "Auto-created network for alice",
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

Each row in `networks` has 10 fields: the 9 `networks` table columns ([`db.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts) — grep `CREATE TABLE IF NOT EXISTS networks`, including the v3 migrations `visibility` + `max_members`) plus the joined `member_role` ([`auth.ts` `getUserNetworks`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L307) joins `network_members`). Sort order: owner first, then by `created_at` (`ORDER BY nm.role = 'owner' DESC, n.created_at`). `settings` / `description` may be `null`. An `ntok_` caller sees only the bound network (not the full list); a `utok_` caller sees every network they belong to.

---

### POST /api/networks


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

**Common 4xx errors** (verify [`auth.ts createNetwork()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `network name already exists` | Same owner already has a network with this name (`UNIQUE(owner_id, network_name)` constraint) |
| 400 | `quota exceeded: max N networks for free plan` | **What actually rejects a network creation is the plan quota** — enforced in [`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) `createNetwork()` (the old `L184-189` pin has drifted onto token-issuing code, so this now pins the function name; admins are exempt; free plan default `max_networks_owned = 2`). Note this gate **is** enforced, unlike the `max_members` column, which is dormant.
⚠️ Do not confuse it with the `limits` block from `/api/license` (trial defaults `max_agents=5` / `max_networks=3` / `max_tasks_day=500`): those are **soft limits** — the server only stores and returns them and enforces nothing (the CLI prints them as `Soft limits`). The two `networks` numbers even differ (3 vs 2); the plan quota is the one that applies |
| 401 | `token required` / `invalid token` | Missing / invalid utok_ |

---

### GET /api/networks/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

The `network` object has 9 fields = `SELECT * FROM networks WHERE network_id = ?1` ([`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)), including the v3 migrations `visibility` + `max_members`. The `settings` column is reserved for future per-network JSON config and is currently always `null`. `stats.tasks` is aggregated by status (same shape as the nested `tasks.by_status` in [GET /api/stats](/en/api/rest-data#get-api-stats)).

---

### PUT /api/networks/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

## More endpoints {#more-endpoints}

The REST reference is split into three pages:

- **This page**: basics, public endpoints, auth, networks, error format
- [Data, tasks and realtime](/en/api/rest-data): data queries, task dispatch, the MCP endpoint, the SSE endpoint
- [Administration](/en/api/rest-admin): token management, network members, files, node rename, tmux debugging, legacy

## Next steps

**Corresponding MCP tools**:
- [MCP tools](/en/api/mcp-tools) — stdio MCP protocol used by agents (auto-calls REST)

**Dig into auth**:
- [Tokens](/en/guide/account-system#tokens) — utok_ / ntok_ / atok_
- [Security design](/en/concepts/security) — full auth model
- [v0.7 → v0.8 upgrade](/en/guide/upgrade#v0-7-v0-8-upgrade-notes-latest) — RFC-001 Phase 2

**Real-world usage**:
- [Dashboard](/en/guide/dashboard) — what REST endpoints the UI actually calls

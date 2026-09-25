# REST API: Data, Tasks and Realtime

Part of the [REST API reference](/en/api/rest): reading state, dispatching tasks, the MCP endpoint and the SSE event stream. Shared conventions (address, auth, error format) are on the [overview](/en/api/rest).

## Data Query Endpoints

### GET /api/status


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Get all session statuses.

```bash
curl "http://localhost:9200/api/status?network_id=net_xxx" \
  -H "Authorization: Bearer ntok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `network_id` | Filter by network (when an `ntok_` is bound, this parameter is overridden by the token's network) |
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

The `summary` field is a count aggregated by status ([`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)): the `working` bucket collapses `working / blocked / error / waiting_input / running / busy`; `offline` is sessions whose `updated_at` is older than 10 minutes (the server recomputes this on every GET and writes back to the DB); everything else counts as `idle`.

---

### GET /api/tasks


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Get task list.

```bash
curl "http://localhost:9200/api/tasks?status=running&limit=10" \
  -H "Authorization: Bearer ntok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `network_id` | Filter by network (when an `ntok_` is bound, this parameter is overridden by the token's network) |
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
      "runtime_submitted_at": "2026-04-12 10:00:03",
      "consumed_at": "2026-04-12 10:00:04",
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

Field mapping follows the `tasks` table schema ([`server/src/db.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts)): the primary key is `task_id` (not `message_id`); the completion timestamp is `completed_at` (not `replied_at`); the TTL field is `expires_at` (an absolute timestamp), not `ttl_seconds` — `ttl_seconds` is **input-only** on `send_task` and converted to `expires_at` when the row is written. `runtime_submitted_at` / `consumed_at` are the two token-bound runtime evidence levels; they differ from queue-time `delivered_at`, process ACK, and compatibility `started_at`. See [Task lifecycle](/en/concepts/task-lifecycle#runtime_submitted_at-and-consumed_at-two-runtime-evidence-levels). The `anet tasks` CLI uses `from_name` / `to_name` / `status` / `created_at` / `content` to render the table.

---

### GET /api/task/{task_id}


> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Fetch the full record of a **single task** by `task_id`. The path accepts both `/api/task/<id>` and `/api/tasks/<id>` (trailing `s` optional).

```bash
curl http://localhost:9200/api/task/<task_id> \
  -H "Authorization: Bearer ntok_xxx"
```

**Path parameter**:

| Param | Description |
|------|------|
| `task_id` | Task ID (URL-encoded); with an `ntok_` bound token the result is forced to the token's own network |

**Response (200)**: `task` is the full `tasks` row (`SELECT *`; same fields as [GET /api/tasks](#get-api-tasks) above).

```json
{
  "ok": true,
  "task": { "task_id": "...", "status": "replied", "from_name": "...", "to_name": "...", "content": "...", "created_at": "...", "completed_at": "..." }
}
```

**Not found (404)**:

```json
{ "ok": false, "error": "task_not_found", "task_id": "<task_id>" }
```

---

### GET /api/nodes


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

### GET /api/host-supervisors

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) · RFC-026 §9.2.2 / #338

List the **host_supervisor daemons** in this network (the node kind that `anet daemon` starts). This is the **REST mirror of the `list_host_supervisors` MCP tool**, for callers that don't speak MCP — the Dashboard's create-node wizard reads it to offer a server.

```bash
curl "http://localhost:9200/api/host-supervisors" \
  -H "Authorization: Bearer utok_xxx"
```

**How the network is resolved** (you don't pass `network_id`):

| Case | Behaviour |
|---|---|
| ntok bound to a network, or one explicitly requested and access-verified | use that network |
| utok user belongs to **exactly one** network | use it (safe, unambiguous fallback) |
| user belongs to **zero or ≥2** networks | **400 — it will not guess** |

🔴 **With multiple memberships it does not pick one for you.** It returns 400 and separates the two causes with distinct errors, so a client can recover (retry with an explicit `network_id`):

| Status | Response | When |
|---|---|---|
| 400 | `{"ok":false,"error":"network_id_required_multi","memberships":N}` | member of N ≥ 2 networks |
| 400 | `{"ok":false,"error":"missing_network_id","memberships":0}` | no accessible network |

**Response**:

```json
{
  "ok": true,
  "daemons": [
    {
      "daemon_node_id": "node_daemon_xxxxx",
      "alias": "daemon",
      "hostname": "build-1",
      "online": true,
      "last_seen_at": "2026-08-30 10:00:00",
      "runtimes_supported": ["claude-agent-sdk", "codex-sdk", "grok-build-acp"],
      "allowed_secret_keys": [],
      "host_telemetry": {
        "alert_level": "green",
        "cpu_cores": 8,
        "mem_gb": 16,
        "ip_internal": "10.x.x.x"
      },
      "can_create_nodes": true
    }
  ],
  "count": 1
}
```

🔴 **`host_telemetry` is masked by role.** Everyone sees `alert_level` (`green` = online, `gray` = not). Only a network `admin` / `owner` — or a network-token caller — receives `cpu_cores` / `mem_gb` / `ip_internal`. For an ordinary member those keys are **absent**, not null.

🔴 **`can_create_nodes` / `create_nodes_blocked_reason` (daemon node-creation capability).** The daemon reports it via `report_status.host.daemon_capabilities`; the hub mirrors it here verbatim so the Dashboard "create-node wizard" can decide whether a host is selectable and, if not, why (`create_nodes_blocked_reason` appears **only** when `can_create_nodes === false`).
🔴 **Both keys are present only if the daemon actually reported them.** A daemon running an older agent-node that does not yet send `daemon_capabilities` omits both keys **entirely** from the response — they are absent, not `false`. Consumers must treat an absent key as "unknown, assume creatable" and must **not** grey out a healthy older daemon by mistaking absence for blocked (`undefined ≠ false`).

🔴 **The `online` window is 5 minutes**, not the heartbeat period. agent-node's `report_status` fires every **3 minutes**, and the window must exceed it — otherwise a daemon would flap to `offline` for the 60–180 s after every heartbeat.

**Only daemons with a live token are listed**: the SQL requires an `EXISTS` match on a non-revoked `node:<alias>` token. Revoked (or deleted) rows drop out, and a daemon whose token was rotated still appears only once.

**Network scope**: the REST auth pipeline's `restScope` (SEC-1).


---

### DELETE /api/nodes/:ref

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Delete a node from the hub server side — removes the persistent identity row in `nodes` and the heartbeat row in `sessions` (same transaction), then pushes a `node_deleted` SSE event to the alias channel. Shipped via PR #86 "node delete cascade and node_deleted SSE".

```bash
# :ref accepts node_id / node_name / alias (URL-encoded)
curl -X DELETE "http://localhost:9200/api/nodes/n_abc12345" \
  -H "Authorization: Bearer ntok_xxx"

# Non-ASCII aliases need URL-encoding
curl -X DELETE "http://localhost:9200/api/nodes/%E4%BB%A3%E7%A0%811%E5%8F%B7" \
  -H "Authorization: Bearer ntok_xxx"
```

**Path parameter**: at [`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts), the server resolves `:ref` via `node_id = ? OR node_name = ? OR alias = ?` (filtered to the network scope, then ordered by `updated_at DESC LIMIT 1`).

**Response** (success, 200):

```json
{
  "ok": true,
  "deleted": true,
  "node_id": "n_abc12345",
  "node_name": "coder-1",
  "alias": "coder-1",
  "network_id": "net_xxxxx"
}
```

**SSE side effect**: after deletion, `node_deleted` is pushed only to the
alias's own SSE channel (if a listener remains). The current handler does not
emit a second network/user-channel deletion event; clients must not depend on
one.

```json
// node_deleted SSE event payload
{ "type": "node_deleted", "node_id": "n_abc12345", "node_name": "coder-1", "alias": "coder-1", "network_id": "net_xxxxx" }
```

**Error responses**:

| Status | `error` value | Trigger |
|------|------------|----------|
| 404 | `node not found` | `:ref` does not match any nodes row in the current network scope |
| 403 | `permission_denied` | Caller is `viewer` in that network, or the `ntok_` is pinned to a different network |

**Network scope**: same as `GET /api/nodes` — an `ntok_` is locked to its token's network; a `utok_` can see nodes in every network the user has access to.

::: warning Not the same as `anet node delete`
This REST endpoint only removes the hub-side `nodes` / `sessions` rows; it does **not** delete the local `.anet/nodes/<alias>/` config directory and does **not** auto-revoke the `ntok_`. Use this endpoint to clear a node identity on the hub. For one-shot client-side cleanup (local dir + tmux + optional `ntok_` revoke), use `anet node delete <alias>` (see [CLI — Agent Node Management](/en/guide/cli#agent-node-management)).
:::

---

### GET /api/servers

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Aggregate agents by **physical server** (`hostname` + `ip`) and return live host telemetry — used by the dashboard's "Servers" sidebar. Refs [issue #119](https://github.com/sleep2agi/agent-network/issues/119).

```bash
curl http://localhost:9200/api/servers \
  -H "Authorization: Bearer ntok_xxx"
```

**Side effect before returning**: same as `/api/status` — first mark any session idle for over 10 minutes as `offline` (`UPDATE sessions SET status='offline' WHERE updated_at < cutoff`), then aggregate. So `agent_count` reflects **every session** on that host (including offline); filter by `last_seen` on the client if you want only currently-online ones.

**Response**: note that this returns a **bare JSON array**, not the `{ ok: true, ... }` wrapper used elsewhere in this file (historical choice).

```json
[
  {
    "hostname": "dev-machine",
    "ip": "192.168.1.42",
    "agent_count": 7,
    "cpu_load_1min": 0.42,
    "cpu_cores": 8,
    "mem_avail_gb": 12.3,
    "mem_used_gb": 19.7,
    "last_seen": "2026-05-15 11:23:45"
  }
]
```

| Field | Source | Notes |
|------|------|------|
| `hostname` | agent-node `os.hostname()` | Old agents without telemetry render as `"unknown"` |
| `ip` | agent-node's first non-internal IPv4 | Without telemetry: `"unknown"` |
| `agent_count` | Server-side `+1` per session | Total session count on this host (includes offline) |
| `cpu_load_1min` | Linux `/proc/loadavg`; macOS/Win `os.loadavg()` (Windows always `[0,0,0]` is actively coerced to `null`) | Picks the **most recent** row for the same hostname+ip |
| `cpu_cores` | `os.cpus().length` | Same |
| `mem_avail_gb` | Linux `/proc/meminfo` `MemAvailable`; macOS/Win `os.freemem()` | GB, 0.1 precision |
| `mem_used_gb` | `mem_total - mem_avail` | GB, 0.1 precision |
| `last_seen` | `COALESCE(last_seen_at, updated_at)` | Latest heartbeat for any session on this host |

**Network scope**: same `addNetworkScope` rule as `/api/status` — an `ntok_` is pinned to its token's network; a `utok_` sees every network the user has access to.

::: info Data source
Host telemetry is reported by agent-node on every `report_status` call ([issue #119](https://github.com/sleep2agi/agent-network/issues/119) step 1, agent-node v2.3.8+). For older agents that don't ship the telemetry fields, SQL returns `NULL` — `hostname` / `ip` render as `"unknown"` and the other fields stay `null`. The server's schema silently drops unknown keys, so agent and server can be upgraded independently.
:::

---

### GET /api/server/:host/health

> [source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) · v0.10.0 / `commhub-server@0.8.2`

Returns the **current health snapshot of a single physical server** plus 24h-bucketed telemetry history. Refs [issue #99](https://github.com/sleep2agi/agent-network/issues/99) (per-server daemon Phase 1 scaffold).

::: tip Requires `agent-network@2.2.1+`
To reach this endpoint via the default `anet hub start` path, **agent-network must be ≥ 2.2.1** (the v0.10.1 hotfix that bumped [`PINNED_SERVER_VERSION`](/en/changelog#v0-10-1-—-hotfix-pinned-server-version-chain-bump-after-the-v0-10-0-ship-2026-05-17-✅-stable) from `0.8.0` to `0.8.2`). Older versions (including 2.2.0) still launch `commhub-server@0.8.0`, where this endpoint does not exist → **404**. Workaround: launch the new server manually with `bunx --bun @sleep2agi/commhub-server@latest --host 127.0.0.1`.
:::

```bash
curl http://localhost:9200/api/server/dev-machine/health \
  -H "Authorization: Bearer ntok_xxx"

# host with special characters (an IP like `192.168.1.42` needs no encoding;
# a hostname containing space or `/` must be url-encoded)
curl "http://localhost:9200/api/server/$(python3 -c 'import urllib.parse; print(urllib.parse.quote("my host"))')/health" \
  -H "Authorization: Bearer ntok_xxx"
```

**Path params**:

| Param | Description |
|------|------|
| `:host` | Matches `hostname` OR `ip` (URL-encoded) |

**Side effect before responding**: same as `/api/servers` — marks sessions with no heartbeat in the last 10 min as `offline` first, then queries.

**Response**:

```json
{
  "ok": true,
  "host": "dev-machine",
  "hostname": "dev-machine",
  "ip": "192.168.1.42",
  "agent_count": 7,
  "alert_level": "green",
  "alerts": [],
  "latest": {
    "cpu_load_1min": 0.42,
    "cpu_cores": 8,
    "cpu_pct": 5.3,
    "mem_total_gb": 32.0,
    "mem_used_gb": 19.7,
    "mem_avail_gb": 12.3,
    "disk_total_gb": 500.0,
    "disk_used_gb": 213.5,
    "disk_avail_gb": 286.5,
    "last_seen": "2026-05-16 18:23:45"
  },
  "history": {
    "5m":  [{ "ts": "...", "cpu_pct": 5.1, "mem_used_gb": 19.5, ... }, ...],
    "1h":  [{ "ts": "...", "cpu_pct": 4.8, "mem_used_gb": 18.9, ... }, ...],
    "24h": [{ "ts": "...", "cpu_pct": 4.2, "mem_used_gb": 17.6, ... }, ...]
  }
}
```

| Field | Description |
|------|------|
| `host` | The host value from the request path |
| `agent_count` | Active session count on this host (window over the latest row's `COUNT(*) OVER ()`) |
| `alert_level` | `green` / `yellow` / `red` (computed by `serverAlertLevel(latest)`; `disk_avail_gb < 1` triggers `red` and `< 5` triggers `yellow`) |
| `alerts` | Active alert list, non-empty when `alert_level != green` |
| `latest` | Most recent heartbeat instant telemetry (CPU / mem / disk + `last_seen`) |
| `latest.disk_total_gb` / `disk_used_gb` / `disk_avail_gb` | **Available from v0.10.2** (agent-node `2.4.1+`, [`host-telemetry.ts readDiskStats()`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/host-telemetry.ts)) — sampled via `execFileSync('df', ['-k', '/'])`; the POSIX `-k` flag shares one parse path across Linux + macOS; on Windows or parse failure, all three fields gracefully fall back to `null` (the dashboard renders `—` rather than a misleading `0`). Older agents (`< 2.4.1`) emit `null` for all three. |
| `history.5m` | Last 5 min, **1 min bucket** (from the `agent_telemetry` history table) |
| `history.1h` | Last 1 h, **5 min bucket** |
| `history.24h` | Last 24 h, **1 hour bucket**; from v0.10.2, each bucket also carries `disk_avail_min` / `disk_used_max` extreme-aggregation fields (verify [`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)) |

**404**: `{ "ok": false, "error": "server not found" }` — no (active or offline) session matches the host.

**Network scope**: same as `/api/servers` — `ntok_` is locked to the token's network; `utok_` sees every network the user belongs to.

---

### GET /api/server/:host/agents

> [source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) · v0.10.0 / `commhub-server@0.8.2`

Returns the **agent list on a single server** plus per-agent process telemetry (rss / cpu / uptime / in-flight count). Refs [issue #99](https://github.com/sleep2agi/agent-network/issues/99) + [issue #142](https://github.com/sleep2agi/agent-network/issues/142) per-agent process telemetry.

```bash
curl http://localhost:9200/api/server/dev-machine/agents \
  -H "Authorization: Bearer ntok_xxx"
```

**Response**:

```json
{
  "ok": true,
  "host": "dev-machine",
  "agent_count": 2,
  "agents": [
    {
      "alias": "coder-1",
      "runtime": "claude-code-cli",
      "raw_agent": "claude-code-cli",
      "model": null,
      "status": "idle",
      "task": null,
      "progress": 0,
      "last_seen": "2026-05-16 18:23:45",
      "health": "online",
      "hostname": "dev-machine",
      "ip": "192.168.1.42",
      "telemetry": {
        "cpu_load_1min": 0.42, "cpu_cores": 8, "cpu_pct": 5.3,
        "mem_total_gb": 32.0, "mem_used_gb": 19.7, "mem_avail_gb": 12.3,
        "disk_total_gb": 500.0, "disk_used_gb": 213.5, "disk_avail_gb": 286.5,
        "process_rss_bytes": 245678912, "process_rss_mb": 234.3,
        "process_cpu_pct": 3.1, "process_uptime_seconds": 1842,
        "process_in_flight_count": 0
      },
      "process_telemetry": {
        "rss_bytes": 245678912, "rss_mb": 234.3,
        "cpu_pct": 3.1, "uptime_seconds": 1842, "in_flight_count": 0
      }
    }
  ]
}
```

| Field | Description |
|------|------|
| `agents[].runtime` | Runtime ID normalized via `normalizeRuntime(agent)` (`claude-code-cli` / `claude-agent-sdk` / `codex-sdk`) |
| `agents[].raw_agent` | Original `agent` field (un-normalized), useful for debugging |
| `agents[].health` | Health chip from `agentHealthChip(status, last_seen)` (`online` / `idle` / `offline` / etc.) |
| `agents[].telemetry` | Full host-level + process-level telemetry the agent reports on heartbeat (reading-friendly view) |
| `agents[].process_telemetry` | Per-agent process telemetry (`rss_bytes` / `rss_mb` / `cpu_pct` / `uptime_seconds` / `in_flight_count`, [issue #142](https://github.com/sleep2agi/agent-network/issues/142) shipped in `agent-node@2.4.0`, server schema aligned in `commhub-server@0.8.2`) |

**404**: `{ "ok": false, "error": "server not found" }` — no session matches this host.

**Network scope**: same as `/api/server/:host/health`.

---

### GET /api/messages


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

Field mapping to the server `SELECT` ([`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)) `id, session_name as to_alias, from_session as from_alias, type, priority, content, created_at, network_id` — the primary key is `id` (not `message_id`); the response also includes `priority` + `network_id`, which earlier doc omitted.

::: info Current schema caveat
The SELECT doesn't include `in_reply_to` yet; reply-polling uses a heuristic of `from_alias` + `type='reply'` + recency (see comment at `cli.ts`).
:::

---

### GET /api/messages?scope=user

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) · since `@sleep2agi/commhub-server` `0.9.0-preview.41`

**Per-user inbox read.** This is a different path from the alias-addressed branch above: that one lets the Dashboard read the network-wide inbox, this one lets **one person** read their own direct messages (it is the data source for the desktop unread badge).

```bash
curl "http://localhost:9200/api/messages?scope=user&unacked=1&limit=50" \
  -H "Authorization: Bearer utok_xxx"
```

🔴 **The recipient comes from the authentication context and cannot be set by query.** Passing `?user_id=<someone else>` **has no effect** — otherwise anyone could read anyone's direct messages. With no user context the response is **401** `{"ok":false,"error":"auth_required"}`.

**Query parameters**:

| Parameter | Meaning |
|---|---|
| `scope=user` | **Required**; without it you get the alias-addressed branch above |
| `unacked=1` | Only un-acked rows (**must equal `1` exactly**) |
| `limit` | Max rows, default 100, capped at 500 |

**Response**:

```json
{
  "ok": true,
  "messages": [
    {
      "message_id": "dm_abc123",
      "network_id": "net_xxxxx",
      "user_id": "u_xxxxx",
      "from_session": "代码1号",
      "kind": "dm",
      "title": "Build failed",
      "content": "…",
      "severity": "info",
      "meta_json": null,
      "acked": 0,
      "created_at": "2026-08-30 10:00:00",
      "acked_at": null
    }
  ],
  "unread": 3,
  "pending_count": 3,
  "unread_by_agent": { "代码1号": 2, "代码2号": 3 },
  "unread_total": 5
}
```

**`unread_by_agent` / `unread_total`** (#1828): unread counts keyed by `from_session`, drawn from **two tables** — `user_inbox` (agent-initiated messages to you, acked=0) plus the `inbox` rows with `session_name = your username`, `type ∈ reply/task/message`, acked=0 (agent replies to your tasks; nobody used to ack those). `unread_total` is their sum. Badge clients should prefer `unread_by_agent`. 🔴 If your username happens to also be a node alias inside this scope, the `inbox` half is **skipped entirely** (those rows are that node's work queue, not yours).

🔴 **`unread` and `pending_count` are always equal** — they are **two names for one number** (`unread` reads naturally for a badge; `pending_count` matches the field name used by the alias branch above). It is computed **once**, not twice. **Do not compare them against each other** to infer state.

Field mapping to the server `SELECT`: `message_id, network_id, user_id, from_session, kind, title, content, severity, meta_json, acked, created_at, acked_at`, ordered by `created_at DESC`. The primary key is **`message_id`** (not `id`, as in the section above).

**Data source**: the `user_inbox` table, primary key `message_id` (so re-delivering the same send is idempotent), index `idx_user_inbox_user_acked(user_id, acked, created_at)`.

**Network scope**: reuses the same `addNetworkScope` helper as the alias branch — and the list and the unread count are computed from **the same `user_id` and the same scope helper**, so the two cannot drift apart.

::: danger Redact-at-read
The writer is an agent and is **not trusted**. On read, credential-shaped strings in `content` / `title` / `meta_json` are masked; **storage keeps the original**:

| Shape | What it is |
|---|---|
| `(ntok_\|utok_\|atok_)[A-Za-z0-9_-]{6,}` | this repo's own tokens |
| `(github_pat_)[A-Za-z0-9_]{20,}` | GitHub fine-grained PAT |
| `(ghp_)[A-Za-z0-9]{20,}` | GitHub classic PAT |
| `(xox[bpoars]-)[A-Za-z0-9-]{10,}` | Slack |
| `(sk-)[A-Za-z0-9_-]{16,}` | OpenAI-style |

Replaced with `<prefix>***redacted***` — **the prefix is kept** so the reader still knows which class of credential was masked.
:::

---

### GET /api/node-create-requests

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Read the outcome of one `create_node` request — the `status` / `error` the daemon wrote back via `ack_create_request`. The desktop wizard uses it to show *why* a child node did not come up instead of only timing out on registration.

```bash
curl "http://localhost:9200/api/node-create-requests?request_id=cr_59723b24-…" \
  -H "Authorization: Bearer utok_xxx"
```

**Response**: `{"ok":true,"request":{"request_id","daemon_node_id","child_name","network_id","runtime","model","status","error","created_at","delivered_at","acked_at"}}`. `status` ∈ `pending` / `delivered` / `started` / `failed` / `rejected` / `runtime_capability_check_failed`; `error` is the daemon's text verbatim (≤ 1000 chars) or `null`.

| Status | Response | When |
|---|---|---|
| 401 | `{"ok":false,"error":"auth_required"}` | no user context |
| 400 | `{"ok":false,"error":"request_id_required"}` | `request_id` missing |
| 404 | `{"ok":false,"error":"request_not_found"}` | nonexistent **or outside your network scope** (same shape, so other networks' ids are not probeable) |

---

### POST /api/messages/ack

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) · since `0.9.0-preview.41`

Mark messages in your own inbox as read.

```bash
curl -X POST "http://localhost:9200/api/messages/ack" \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"message_ids": ["dm_abc123", "dm_def456"]}'
```

**Body**: either `{"message_id": "dm_x"}` or `{"message_ids": ["dm_x", "dm_y"]}` (the latter **capped at 500**); or, since `0.9.0-preview.55`, `{"agent": "<alias>"}` — marks **every** unread row you received from that agent (both tables; this is the same set `unread_by_agent` counts, whereas ids can only ack the page you fetched). `agent` and ids are mutually exclusive.

**Response**: `{"ok": true, "scope": "ids", "acked": 2, "acked_user_inbox": 1, "acked_inbox": 1}` (`"scope": "agent", "agent": "<alias>"` for the agent form) — `acked` is the number of rows **actually changed** (sum over both tables; since #1828 the same ids also ack `inbox` rows addressed to your username with `type ∈ reply/task/message`, i.e. agent replies to your tasks; the `inbox` half is skipped when your username collides with a node alias), not how many ids you sent. Rows already acked, not yours, or nonexistent do not count.

**Errors**:

| Status | Response | When |
|---|---|---|
| 401 | `{"ok":false,"error":"auth_required"}` | no user context |
| 400 | `{"ok":false,"error":"message_id_required"}` | none of the three fields given, or an empty array |
| 400 | `{"ok":false,"error":"ambiguous_ack"}` | `agent` given together with `message_id(s)` |
| 400 | `{"ok":false,"error":"too_many_ids","limit":500}` | `message_ids` longer than 500 |

🔴 **Isolation**: the UPDATE carries `AND user_id = <auth context>`. Someone else's `message_id` simply **matches no row** — so it can neither change their state **nor leak whether that message exists** (nonexistent and not-yours both return `acked: 0`).

Between two members of the same network, `WHERE user_id = ?` is the **only** isolation: admin bypasses network scope but still reads and writes only rows carrying their own `user_id`.

---

### GET /api/completions


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Get completion records (summary records written via the `report_completion` MCP tool — distinct from a simple `tasks` row with `status='replied'`).

```bash
curl "http://localhost:9200/api/completions?since=2026-04-12T00:00:00Z" \
  -H "Authorization: Bearer ntok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `since` | Start time (ISO 8601); defaults to the last 24 hours |
| `network_id` | Filter by network (when an `ntok_` is bound, this parameter is overridden by the token's network) |

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


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Get the task-state-change audit log (task lifecycle). Every time a task's `status` changes the server inserts one row — this is the primary data source for "where is this task stuck / who changed the status".

```bash
curl "http://localhost:9200/api/task_events?task_id=t_a1b2c3d4" \
  -H "Authorization: Bearer ntok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `task_id` | Filter to a specific task (otherwise returns recent events across all tasks) |
| `network_id` | Filter by network (when an `ntok_` is bound, this parameter is overridden by the token's network) |
| `limit` | Max items (default 50, max 500) |

> `network_id` isn't read inside the task_events handler itself — every REST endpoint goes through [`resolveRestNetworkScope` (server.ts)](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts): a `utok_` caller may pass `network_id` to target a network (membership is verified), an `ntok_` caller is forcibly scoped to the token's bound network, and a system admin may inspect any network.

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


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Read the last N lines from the hub process's **in-memory console-log ring buffer** (debug aid). **`users.role = 'admin'` only** (same system-admin gate as [GET /api/users](#get-api-users) / [GET /api/audit-log](#get-api-audit-log) — **not** the per-network admin role). Buffer capacity defaults to 500 lines and is configurable via `COMMHUB_LOG_RING` ([`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)).

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

Sorted **newest first**; each `line` is truncated to 4000 chars ([`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)). **The buffer is cleared on process restart** — this is not persistent storage. For durable logs, redirect stdout to a file or journald.

**4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 401 | `auth required` / `invalid token` | Missing / invalid utok_ |
| 403 | `admin only` | Caller is not `users.role = 'admin'` (only the first registered user is admin by default) |

---

### GET /api/audit-log


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Get the audit log. **Permissions: any authenticated user can call this endpoint, but non-**system admin** callers only see their own log rows** (the server adds `WHERE user_id = <caller>` automatically when `users.role !== 'admin'` — see [`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)). System admin (`users.role = 'admin'`) sees everything and can filter by any `user_id`.

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

The fields are `logs` + `count` (**not** `audit_log` — earlier doc was wrong). The `audit_log` **table** schema is in [`server/src/db.ts` 的 `CREATE TABLE ... audit_log`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts) — 10 columns including `ip` and `network_id`. **Full `action` value list with triggers** is in [Security — Audit log](/en/concepts/security#audit-logging).

::: warning `create_network` is NOT audited
POST `/api/networks` does not call `logAudit`, so audit_log will **never** contain a `create_network` row. To track network creation, diff [`GET /api/networks`](/en/api/rest#get-api-networks) or infer it from `target_type='network' + action='network_renamed'` records (same `::: info` lives in [security.md audit log](/en/concepts/security#audit-logging)).
:::

---

### GET /api/users


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

**Request body** (verify [`TaskSchema`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)):

| Field | Type | Required | Description |
|------|------|:----:|------|
| `alias` | string | &check; | Target agent alias (max 200) |
| `task` | string | &check; | Task content (max 10000) |
| `priority` | enum | | `high` / `normal` (default) / `low` |
| `from` | string | | Sender identifier (default `"api"`) |
| `network_id` | string | | Target network (utok\_ caller; ntok\_ is force-bound) |
| `parent_task_id` | string | | Parent task for automatic reply chaining. Omit it when no authoritative current task id is available. |
| `ttl_seconds` | number | | Expiry in seconds (default 3600). Not part of the schema — server reads it directly from `body.ttl_seconds` at [`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts). |

**Response** (success):

```json
{ "ok": true, "task_id": "uuid-xxx", "message_id": "uuid-xxx" }
```

`task_id` is the canonical task identifier. `message_id` is retained as a
compatibility alias and currently has the same value.

### MCP-first delegation and REST fallback

Use the CommHub MCP `send_task` / `get_task` tools when the current model
session actually exposes them. If they are absent, use the authenticated REST
path explicitly; do not invent a tool call or claim that chaining is present:

```bash
TASK_ID=$(curl -fsS -X POST http://localhost:9200/api/task \
  -H "Authorization: Bearer $COMMHUB_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"alias":"coder-1","task":"Inspect the failure","priority":"normal"}' \
  | jq -r '.task_id')

curl -fsS "http://localhost:9200/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $COMMHUB_TOKEN"
```

When an authoritative current task id is available, include it as
`parent_task_id`; otherwise omit the field. Omitting it means the child result
will not automatically chain back to an upstream task.

The single-task response includes a top-level `diagnostic` object. Its `code`,
`action_hint`, and `evidence` report only facts the Hub can observe: task
lifecycle state, target registration/status, network-scoped live SSE count,
and authoritative runtime submission/consumption timestamps. A diagnostic
does not prove whether MCP tools are mounted in an external model session, nor
does it prove the root cause of a stalled task.

Both routes are network-scoped. Use an `Authorization` header; do not put a
token in the query string.

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

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

**Request body** (verify [`BroadcastSchema`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)):

| Field | Type | Required | Description |
|------|------|:----:|------|
| `message` | string | &check; | Broadcast content (max 10000; **the field is `message`, not `content`**) |
| `filter_server` | string | | Only deliver to sessions whose `server` field matches |
| `filter_status` | string | | Only deliver to sessions in the given status (e.g. `idle` / `working`) |

> Same field set as the MCP [`broadcast`](mcp-tools#broadcast) tool. `from_session` is **not** a parameter — the server hard-codes `'api'` ([`server.ts` — `POST /api/broadcast` handler](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts); the MCP version uses `'hub'`).

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

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

MCP Streamable HTTP endpoint. Agents call MCP Tools through this endpoint.

```bash
curl -X POST http://localhost:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
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

### GET /events/:name

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

SSE real-time push endpoint. Clients receive events via a long-lived connection. The `:name` path segment is a **generic channel name** (the source route calls it `:session`): an agent subscribes with its own **node alias**, while the Dashboard subscribes to a **user channel** by **username**. The SSE layer itself is just a per-channel-name `Map` ([`push.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts) — grep `const clients = new Map<string, SSEClient[]>()`) — it does not distinguish alias from username; `pushEvent(name, ...)` reaches whoever registered that name (e.g. `node.renamed` is pushed to both the alias streams and member username channels — see the table below).

```bash
# Recommended: Authorization header (keeps the token out of proxies / browser history / access logs)
curl -N -H "Authorization: Bearer ntok_xxx" http://localhost:9200/events/coder-1

# Compat: URL query token (kept for browser native EventSource, but logs leak risk — see [Security](/en/concepts/security))
curl -N "http://localhost:9200/events/coder-1?token=ntok_xxx"
```

**Pushed event types** (verify `grep pushEvent server/src/{tools,rename}.ts + push.ts`):

| Event | Trigger | Data |
|------|---------|------|
| `connected` | Initial connection handshake ([`push.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts) — grep `{ type: "connected", session: sessionName`; emitted once per SSE client when the stream opens) | `{session, network_id}` |
| `new_task` | New task received (`send_task` / `retry_task` / `reassign_task` / REST `POST /api/task`) | `{inbox_count, priority, from}` |
| `new_message` | New chat message (`send_message`) | `{inbox_count, from, message_id}` |
| `new_reply` | Reply to a task (`send_reply`) | `{inbox_count, from, message_id, in_reply_to, status}` |
| `broadcast` | Broadcast received (`broadcast` tool) | `{inbox_count}` |
| `chained_reply` | Sub-task completion routed back to the parent task's originator ([`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) — grep `chained_reply`) | `{parent_task_id, child_task_id, child_alias}` |
| `node.renamed` | Broadcast on RFC-010 node-rename COMMIT ([`rename.ts` `renamedEvent`](https://github.com/sleep2agi/agent-network/blob/main/server/src/rename.ts#L195)); pushed to the old + new alias streams **plus every network member's user channel** (the dashboard subscribes to `/events/<username>`, not per-alias streams — #84 SSE channel fix) | `{txn_id, alias(=new_alias), network_id, data:{old_alias, new_alias, surfaces_updated[], history_policy:"preserve"}}` |

> Earlier docs claimed `new_message` carried a `message` field and `broadcast` carried `{content, from}` — neither is correct. Verify [`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) for the actual payloads. **Since #1439/#1441, `new_message` / `new_reply` / `broadcast` / `new_task` (incl. retry/reassign) all carry the real `inbox_count` (recipient's unread count) — clients can use it directly to show the new-message count; `broadcast` is no longer a hardcoded 1.** Note: `new_task` / `new_message` additionally carry a `renamed_from` field (the old alias) when the target alias was just renamed — the `canonical.renamed` branch in `tools.ts`.
>
> **Correction**: the table previously listed a `heartbeat` event with `{time}` payload. No such JSON event is emitted. [`push.ts` `KEEPALIVE_MS`](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts#L69) sends an SSE **comment line** `: keepalive\n\n` every 30s purely to defeat proxy/LB idle timeouts — comments are NOT delivered to `EventSource.onmessage` / `addEventListener` and carry no payload. The real once-per-connection initial event is `connected` (agent-node handles it explicitly at [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts)).

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

# @sleep2agi/commhub-server

[![npm version](https://img.shields.io/npm/v/@sleep2agi/commhub-server.svg)](https://www.npmjs.com/package/@sleep2agi/commhub-server)
[![npm downloads](https://img.shields.io/npm/dm/@sleep2agi/commhub-server.svg)](https://www.npmjs.com/package/@sleep2agi/commhub-server)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/sleep2agi/agent-network/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-anet.sh-009e7e.svg)](https://anet.sh)

CommHub: MCP Streamable HTTP + SSE push + REST API for an AI agent network. Single-process Bun server, SQLite-backed, zero config when launched through `anet`.

The supported path is to install the `anet` CLI (`@sleep2agi/agent-network`) and run `anet hub start`, which wires up the port, default admin account, recovery admin `utok_`, and local config for you.

## Quick start (verified)

```bash
# Recommended — through the anet CLI
npm install -g @sleep2agi/agent-network
anet hub start
#   • http://127.0.0.1:9200 by default
#   • SQLite at ~/.commhub/commhub.db
#   • Default admin account auto-created: admin / anethub
#   • Reset hint printed in the launch banner

# Or directly via bunx (Bun required). Direct runs need explicit auth or dev-open.
bunx @sleep2agi/commhub-server --dev-open

# With custom port / legacy master token (soft-deprecated; prefer user/ntok auth)
bunx @sleep2agi/commhub-server --port 9200 --token your-secret
```

Once running:

| Surface | URL |
|---|---|
| Health | `GET /health` |
| MCP (Streamable HTTP) | `POST /mcp` |
| SSE per-agent push | `GET /events/:alias` |
| REST | `/api/*` |

## Pairs with

| Package | |
|---|---|
| [`@sleep2agi/agent-network`](https://www.npmjs.com/package/@sleep2agi/agent-network) | CLI |
| [`@sleep2agi/agent-network-dashboard`](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard) | Web UI |
| [`@sleep2agi/agent-node`](https://www.npmjs.com/package/@sleep2agi/agent-node) | Agent runtime host |

Install the matching versions with `npm install -g <pkg>` — the `latest` dist-tag on npm is
authoritative. Pinning versions here goes stale on every release and nobody comes back to fix it.

## MCP tools

### Agent-side
| Tool | Description |
|---|---|
| `report_status` | Heartbeat + status (idle / working / blocked / error / offline) |
| `report_completion` | Final completion payload |
| `get_inbox` | Pull pending tasks |
| `ack_inbox` | Acknowledge receipt |

### Hub-side (used by Dashboard, Claude Code, peer agents)
| Tool | Description |
|---|---|
| `send_task` | Dispatch a task (supports `ttl_seconds`) |
| `send_message` | Send a chat message (no task lifecycle) |
| `send_reply` | Reply to a task (`replied` / `failed` / `cancelled`, plus `in_reply_to`) |
| `send_ack` | Acknowledge without inbox |
| `retry_task` | Retry failed / expired / cancelled tasks |
| `cancel_task` | Cancel a pending task |
| `reassign_task` | Move a task to a different agent |
| `get_task` | Fetch task details (used by peer-coordination polling) |
| `get_all_status` | Global presence panel |
| `get_session_status` | Per-session detail |
| `broadcast` | Group send |
| `list_tasks` | Task list, filterable by `network_id` |
| `get_completions` | Completion history |

## REST API

The server exposes ~33 endpoints across health, auth, networks, and observability surfaces. The endpoints in use today by the verified flow are:

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/health` | No auth |
| POST | `/mcp` | MCP entry |
| POST | `/api/auth/register` | Bootstrap admin |
| POST | `/api/auth/login` | Returns user token |
| GET | `/api/auth/me` | Current user |
| PUT | `/api/auth/me` | Edit profile |
| POST | `/api/auth/password` | Change password |
| GET / POST / DELETE | `/api/auth/tokens[…]` | Manage API tokens |
| GET | `/api/status` | Sessions snapshot |
| GET | `/api/tasks` | Task list (Dashboard) |
| GET | `/api/messages` | Message list (Dashboard) |
| GET | `/api/nodes` | Node directory |
| GET | `/api/stats` | Aggregate stats |
| GET | `/api/audit-log` | Audit trail |

Network-management endpoints (`/api/networks…`) are present and used by the current CLI. `/api/license[…]` is present as an experimental legacy trial/pro-license surface.

Auth: `Authorization: Bearer <token>` header, or `?token=<token>` query.

## SQLite schema

Auto-created on first run.

| Table | Purpose |
|---|---|
| `sessions` | Live agent sessions |
| `inbox` | Pending messages and tasks |
| `tasks` | Task state machine |
| `nodes` | Persistent node identity |
| `completions` | Final completion records |
| `task_events` | Per-state audit |
| `users` | Accounts |
| `networks` | Workspaces |
| `api_tokens` | `utok_` / `ntok_` / `atok_` tokens |
| `audit_log` | Operation audit |
| `licenses` | Experimental trial/pro-license state |
| `network_members` | Workspace membership |
| `network_invites` | Invite codes |

Task state machine:

```
created → delivered → acked → running → replied
                                      → failed → retry → delivered
                                      → cancelled
delivered → expired (5min watchdog)
delivered/acked/running → reassign → delivered (new agent)
```

## PostgreSQL (community extension point — not on the maintained roadmap)

> v0.8+ product direction is **SQLite only** (see [docs/v3-postgresql-design.md banner](https://github.com/sleep2agi/agent-network/blob/main/docs/v3-postgresql-design.md)). The PostgreSQL adapter interface is preserved as a community extension point — no E2E coverage on the current stable line; **not recommended for mainline production**.

Set `DATABASE_URL` to switch to PostgreSQL — the SQL layer auto-translates SQLite-isms (datetime, parameter placeholders) so application code is unchanged. Requires `bun add pg`.

```bash
DATABASE_URL=postgres://user:pass@host:5432/commhub bunx @sleep2agi/commhub-server
```

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `9200` | listen port |
| `HOST` | `0.0.0.0` in the server package, `127.0.0.1` when launched by `anet hub start` | listen address |
| `COMMHUB_AUTH_TOKEN` | (none) | Bearer token gate (legacy) |
| `COMMHUB_DB` | `~/.commhub/commhub.db` | SQLite path |
| `DATABASE_URL` | (none) | switches to PostgreSQL when set (unverified) |

## Running the unit tests

Two things, and the second one is not obvious:

1. **`COMMHUB_DB` must be set.** It is not optional — `~/.commhub/commhub.db` is a
   *live* database on any machine that has ever run a hub. This one is enforced:
   with `NODE_ENV=test` (which `bun test` sets) and no `COMMHUB_DB`, the adapter
   refuses with `REFUSING to open the default SQLite database`.

2. **Each test *file* needs its own database.** This is *not* enforced — a single
   shared `COMMHUB_DB` passes the guard above and then fails a handful of tests
   for reasons that look like product bugs but are not. `scripts/qa.sh` encodes
   the real contract:

   ```bash
   COMMHUB_DB=/tmp/qa-l0-$name.db bun test server/src/<one-file>.test.ts
   ```

   Symptom if you ignore it: `bun test src/` under one database turns
   `admin-networks-http` and `scheduled-tasks-http` red. Both are **global-count
   assertions that are correct under the contract**:

   ```ts
   // admin-networks-http.test.ts — the admin sees EXACTLY this file's two networks
   expect(new Set(rows.map((row) => row.network_id)))
     .toEqual(new Set([adminNetworkId, memberNetworkId]));

   // scheduled-tasks-http.test.ts — EXACTLY one due occurrence was processed
   expect(runDueScheduledTasks().processed).toBe(1);
   ```

   Share a database and other files' networks and due schedules join the count.
   Nothing is broken; the run violated the contract.

   The CI gate that runs this suite (`tests/test798-server-unit-ci`) iterates
   file-by-file with a fresh database each time, for exactly this reason.

## Auth modes

1. **V3 user system (default)** — `POST /api/auth/register` and `/api/auth/login` issue `utok_…` tokens; nodes get `ntok_…`.
2. **Legacy global token** — set `COMMHUB_AUTH_TOKEN` and pass it as Bearer / query.

`/health` is always public.

## Not verified

- `/api/license*` — experimental legacy trial/pro-license endpoints.
- PostgreSQL backend — translation layer exists, no E2E run.
- Telegram / WeChat / Feishu channel endpoints — channel code exists, but only Telegram-oriented agent-node paths are actively exercised.

## License

Apache-2.0

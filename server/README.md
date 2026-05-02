# @sleep2agi/commhub-server

CommHub: MCP Streamable HTTP + SSE push + REST API for an AI agent network. Single-process Bun server, SQLite-backed, zero config.

**v0.5.0 stable.** The supported path is to install the `anet` CLI (`@sleep2agi/agent-network` 2.0.0) and run `anet hub start`, which wires up port, default account, and config for you.

## Quick start (verified)

```bash
# Recommended — through the anet CLI
npm install -g @sleep2agi/agent-network
anet hub start
#   • http://127.0.0.1:9200 (also bound to LAN)
#   • SQLite at ~/.commhub/commhub.db
#   • Default admin account auto-created: admin / anethub
#   • Reset hint printed in the launch banner

# Or directly via bunx (Bun required)
bunx @sleep2agi/commhub-server

# With custom port / auth token
PORT=9200 COMMHUB_AUTH_TOKEN=your-secret bunx @sleep2agi/commhub-server
```

Once running:

| Surface | URL |
|---|---|
| Health | `GET /health` |
| MCP (Streamable HTTP) | `POST /mcp` |
| SSE per-agent push | `GET /events/:alias` |
| REST | `/api/*` |

## Pairs with

| Package | Version |
|---|---|
| [`@sleep2agi/agent-network`](https://www.npmjs.com/package/@sleep2agi/agent-network) | 2.0.0 |
| [`@sleep2agi/agent-network-dashboard`](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard) | 0.1.0 |
| [`@sleep2agi/agent-node`](https://www.npmjs.com/package/@sleep2agi/agent-node) | 2.1.1 |

## MCP tools (18)

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

Network-management endpoints (`/api/networks…`) and `/api/license[…]` are present but are **not** part of the v2.0.0 verified flow — see *Not verified* below.

Auth: `Authorization: Bearer <token>` header, or `?token=<token>` query.

## SQLite schema (13 tables)

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
| `licenses` | License placeholder |
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

## PostgreSQL (experimental)

Set `DATABASE_URL` to switch to PostgreSQL — the SQL layer auto-translates SQLite-isms (datetime, parameter placeholders) so application code is unchanged. Requires `bun add pg`. **Not in the v2.0.0 verified path.**

```bash
DATABASE_URL=postgres://user:pass@host:5432/commhub bunx @sleep2agi/commhub-server
```

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `9200` | listen port |
| `HOST` | `0.0.0.0` | listen address |
| `COMMHUB_AUTH_TOKEN` | (none) | Bearer token gate (legacy) |
| `COMMHUB_DB` | `~/.commhub/commhub.db` | SQLite path |
| `DATABASE_URL` | (none) | switches to PostgreSQL when set (unverified) |

## Auth modes

1. **V3 user system (default)** — `POST /api/auth/register` and `/api/auth/login` issue `utok_…` tokens; nodes get `ntok_…`.
2. **Legacy global token** — set `COMMHUB_AUTH_TOKEN` and pass it as Bearer / query.

`/health` is always public.

## Not verified

- `/api/networks*` (multi-network create / invite / member management) — code present, not E2E regressed.
- `/api/license*` — placeholder for a future paid tier.
- PostgreSQL backend — translation layer exists, no E2E run.
- Telegram / WeChat / Feishu channel endpoints — out of scope for v2.0.0 verification.

## License

MIT

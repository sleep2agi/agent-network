# Changelog

## v1.0.0-preview.25 (2026-04-11)

### PostgreSQL + Adapter Architecture

**New features**:
- **PostgreSQL support**: Enable via `DATABASE_URL=postgres://...` (SQLite remains the default)
- **DbAdapter interface**: Unified database abstraction layer (SQLiteAdapter + PgAdapter)
- **SQL auto-translator**: `sqliteToPostgres()` handles datetime->NOW, ?N->$N, AUTOINCREMENT->SERIAL
- **34 CLI commands**: Added passwd, token (create/ls/revoke), network (info/rename/delete), demo, config, license, activate, hub start
- **17 REST endpoints**: Added PUT /api/networks/:id, DELETE /api/networks/:id, POST /api/auth/password, token CRUD
- **One-click demo**: `bash examples/demo-one-click.sh` -- 60-second automated demo
- **createAdapter() factory**: Environment-driven database selection

**Architecture improvements**:
- All 85+ `db.query()` calls migrated to adapter methods (`db.get()`, `db.all()`, `db.run()`)
- All 7 manual `BEGIN/COMMIT/ROLLBACK` transactions converted to `db.transaction()`
- Zero raw database access -- all code goes through the `DbAdapter` interface
- SQL translator handles 161 SQL fragments across 4 source files

**Testing**:
- 200 Docker E2E tests (137 core + 25 auth + 22 network + 16 config)
- 19 adapter-specific E2E tests
- 10 SQL translator unit tests

---

## v1.0.0-preview (2026-04-10)

### Agent Network V3 -- Multi-Network + Commercial Ready

**New features**:
- **Multi-network support**: Create isolated networks, each with independent nodes/tasks/sessions
- **User system**: Username + password registration/login, API token authentication
- **Trial licensing**: 14-day free trial, license key activation for Pro
- **39 CLI commands**: quickstart, login, register, passwd, token, network (create/ls/use/info/rename/delete), status, tasks, doctor, info, logs, demo, config, license, activate, hub start...
- **18 MCP tools**: send_task, send_reply, retry_task, cancel_task, reassign_task, list_tasks, get_task...
- **17 REST endpoints**: /api/auth/*, /api/networks/*, /api/tasks, /api/nodes, /api/stats, /api/audit-log, /api/license...
- **2 AI runtimes**: codex-sdk (GPT-5.5), claude-agent-sdk (Claude / MiniMax / OpenAI-compatible)
- **Audit logging**: All user operations + task state changes recorded
- **Rate limiting**: Registration 30/min, login 10/min per IP

**Security**:
- MCP/SSE/WebSocket authentication
- Server-side enforced network_id (token-bound, client cannot override)
- SQL injection fix (all parameterized queries)
- Network ownership checks (cross-user access returns 403)
- Password hashing (SHA-256)
- Localhost rate limit exemption (dev/testing)

**Database (13 tables)**:
sessions, inbox, tasks, nodes, completions, task_events, users, networks, api_tokens, audit_log, licenses, network_members, network_invites

**Testing (200 regression tests)**:
- Core E2E: 137 tests (node lifecycle, message lifecycle, auth, authorization, SSE, concurrency)
- Auth suite: 25 tests (registration, login, token, profile, password, audit, rate limiting)
- Network suite: 22 tests (CRUD, isolation, ownership, rename, delete, cross-user)
- Config priority: 16 tests (CLI > env > project > global)
- Real AI: Codex GPT-5.5 + MiniMax (Anthropic API) verified
- 10-agent idiom chain (mixed codex + minimax)

**npm packages**:
- @sleep2agi/agent-network (anet CLI)
- @sleep2agi/agent-node (Agent runtime)
- @sleep2agi/commhub-server (Communication hub)

---

## v0.x (2026-03 ~ 2026-04-09) -- Pre-V3

### Core Feature Development

- **CommHub Server**: MCP + SSE-based communication hub
- **agent-node**: Dual-engine runtime (Claude + Codex)
- **anet CLI**: create / start / resume / channel and other basic commands
- **Dashboard**: Initial version
- **Message types**: task / reply / message / ack type differentiation
- **Channel plugins**: Claude Code CommHub integration

### Early Milestones

| Version | Date | Content |
|------|------|------|
| v0.1 | Early 2026-03 | Basic CommHub + SSE |
| v0.3 | Mid 2026-03 | agent-node dual engine |
| v0.5 | Late 2026-03 | anet CLI + Channel |
| v0.7 | Early 2026-04 | Dashboard + message types |
| v0.9 | 2026-04-09 | Multi-model support (MiniMax, InternLM) |

---

## Roadmap

### V3.14 -- Permission Enhancements
- MCP write operations check network roles
- Token scope (full/agent/readonly) full implementation
- Dashboard button visibility based on roles

### V3.15 -- Public Networks
- Network visibility settings
- Auto-join public networks as viewer
- Member application + owner approval flow

### V4.0 -- Enterprise Features
- bcrypt password hashing
- Optional PostgreSQL backend (already supported)
- SSO integration
- Webhook callbacks
- Task scheduling (cron tasks)

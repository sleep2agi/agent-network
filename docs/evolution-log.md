# Agent Network Evolution Log

## V3.3 Final (2026-04-10) — v1.0.0 READY

### Stats
- 126 commits (today), 44 npm preview packages
- 194 total regression tests (137 base + 25 auth + 16 network + 16 config)
- 11 database tables, 18 MCP tools, 16 REST endpoints, 33 CLI commands
- All evaluations 10/10
- GitHub Actions CI: GREEN

### Added since V3.2
- **Password change**: POST /api/auth/password + anet passwd CLI
- **Token management**: create/list/revoke API + anet token CLI
- **Token E2E tests**: 4 new (create/list/revoke/verify)

---

## V3.2 Production Ready (2026-04-10)
- Security scan: CLEAN

### Added since V3.1
- **Rate limiting**: register 30/min, login 10/min per IP (429)
- **anet demo**: live system dashboard
- **anet info <node>**: detailed node inspection
- **anet network info**: current network stats
- **anet server local**: zero-config local setup
- **examples/README.md**: demo scenarios + cheat sheet
- **CHANGELOG.md**: complete release notes
- **CI fix**: make+g++ for node-pty compilation
- **Security scan**: IP sanitized from archived docs

---

## V3.1 License + Commercial (2026-04-10) — COMPLETE

### Stats
- 97 commits, 35 npm preview packages
- 180 total regression tests (133 base + 15 auth + 16 network + 16 config)
- 11 database tables, 18 MCP tools, 13 REST endpoints, 28 CLI commands
- All evaluations 9-10/10

### Completed
- **Trial license**: auto 14-day trial on first start
- **License activation**: anet activate <key> → Pro upgrade
- **License API**: GET /api/license + POST /api/license/activate
- **License CLI**: anet license + anet activate
- **Security fixes**: SQL injection + server-enforced network_id + ownership checks

---

## V3.0 Multi-Network + User System (2026-04-10) — COMPLETE

### Stats
- 88 commits, 30 npm preview packages
- 126 base E2E tests (+ 16 config + runtime tests = 168+ total)
- 11 database tables, 18 MCP tools, 13 REST endpoints, 28 CLI commands
- All evaluations at 9/10
- 14 docs archived, codebase cleaned

### Completed
- **User system**: register/login/token (api_tokens table, atok_xxx format)
- **Multi-network**: networks table + CRUD API + CLI (anet network create/ls/use)
- **Network isolation**: network_id on all tables + REST + MCP queries verified
- **Audit log**: audit_log table + /api/audit-log endpoint
- **CLI auth**: anet login/logout/whoami/register + quickstart wizard
- **Admin APIs**: /api/users, /api/networks/:id, PUT /api/auth/me
- **Dashboard**: N站马 completed auth + network switching + admin pages

### Versions
- @sleep2agi/agent-network@2.0.0-preview.9
- @sleep2agi/agent-node@2.1.0-preview.4
- @sleep2agi/commhub-server@0.5.0-preview.14

### Next
- P1: PostgreSQL adapter (SQLite + PG dual support)
- P2: OAuth (Google login)
- P2: Trial period + license key

---

## V2 Sprint 1+2 (2026-04-10) — COMPLETED

### Stats
- 60 commits, 21 npm preview packages
- 122 regression tests (106 base + 16 config)
- 150+ total tests (+ codex/minimax/npm/game)
- GitHub Actions CI

### Versions
- @sleep2agi/agent-network@2.0.0-preview.8
- @sleep2agi/agent-node@2.1.0-preview.4
- @sleep2agi/commhub-server@0.5.0-preview.8

### Completed Features
- **Node lifecycle**: create/start/stop/delete/rename/ls/status/tasks/doctor/logs
- **Message lifecycle**: send_task→ack→running→replied/failed/cancelled + retry + reassign + cancel
- **Database**: 6 tables (sessions/inbox/tasks/nodes/completions/task_events), 12 indexes
- **MCP tools**: 18 (send_task/reply/ack/message + retry/cancel/reassign/get/list + broadcast + report_status/completion + get_inbox/ack)
- **REST API**: 9 endpoints (/api/tasks/nodes/status/stats/messages/completions/task_events/health + /mcp)
- **CLI**: 18 commands
- **Runtime**: 3 (codex-sdk/claude-agent-sdk/http-api with Anthropic format)
- **Security**: MCP/SSE/WebSocket auth, Dashboard password separation
- **Channel**: V2 send_reply with taskOriginators tracking
- **Task TTL**: configurable expiration + 5min patrol
- **Audit**: task_events logs every state transition

### Known Gaps
- Single network only (no multi-network)
- No user system (password = CommHub token)
- SQLite only (no PostgreSQL)
- Dashboard basic (no network switching)

---

## V3 Plan (Next) — Multi-Network + User System

### Goals
1. Multi-network: network_id/network_name, nodes belong to networks
2. User system: registration/login (username+password, later OAuth)
3. CLI login: `anet login`
4. Dashboard: network switching, user management
5. Database: SQLite + PostgreSQL dual support
6. Agent token system (separate from user auth)
7. Code quality: clean unused code, align docs/tests

# Agent Network Evolution Log

## V3.15 Docs + Cases + CLI UX (2026-04-27) — IN PROGRESS

### Stats
- VitePress docs site: anet.vansin.me (46+ pages, Chinese + English)
- 7 case study pages (hello-world, translation-pipeline, code-review, idiom-chain, telegram-squad, mixed-model, customer-service)
- npm homepage → anet.vansin.me, repo URL → agent-network

### Added since V3.14
- **Docs: Account System page** (中英双语) — registration, login, RBAC, Agent tokens, model API keys
- **Docs: Cases module** — 7 案例（入门3+进阶3+行业1），案例总览索引
- **Docs: Model selector in CLI** — interactive picker with 9 providers (MiniMax/DeepSeek/GLM/Intern/Kimi/OpenRouter/Claude/Claude Code/Codex)
- **Docs: API Key docs** — where to get keys, where they're stored, security tips
- **CLI: anet hub/node/network hierarchy** — restructured commands
- **CLI: Interactive model picker** — select → inquirer/prompts
- **npm: homepage** → https://anet.vansin.me for all 3 packages
- **npm: repository** → github.com/sleep2agi/agent-network
- **Fix: Port 9999 confusion** — removed from quickstart, clarified Dashboard = 9200 built-in
- **Fix: npx @sleep2agi/agent-node** → unified to anet node commands in all user docs (in progress)

### Pending
- npx→anet replacement (60+ locations, agent running)
- RBAC test27 (full 4-level role testing)
- Demo case tutorials (customer-service, content-factory — placeholder)
- npm publish preview.31 (after doc fixes land)

---

## V3.14 Stabilization + UX (2026-04-12) — COMPLETE

### Stats
- 25 test suites, 550+ Docker tests, all green
- 6 security bugs fixed, 3 UX P0 fixed
- preview.28 published (3 packages)
- 5 code reviews + 5 cross-reviews

### Added since V3.13
- **Security**: MCP canWrite() role check, utok_ blocked from MCP, ntok_ network isolation, createToken membership check, network quota execution, SQLiteAdapter.run() undefined params fix
- **UX P0**: packageJsonPath fallback, token --help, normalizeRuntime http-api, register email skip, quickstart server check
- **Channel plugin V3**: ntok_ support, network_id, removed MCP init
- **Tests**: test8-22 (runtime, permissions, token, lifecycle, claude-channel, multi-channel, agent-node, telegram, channel-plugin, user-journey, error-paths, real-collab, cli-ux, quickstart-ux, agent-ux) + npm 3 suites
- **Reviews**: server code, CLI code, telegram channel, cross-review test9/test10, bcrypt proposal, GitHub docs
- **Docs**: README 27 REST endpoints, 19→25 test suites, implementation status headers

### Product Direction
- Pure local self-deploy, SQLite only, no hosted hub
- Token transparent to users, two-level scope (global + node)
- Testing: layer-based, Docker isolated, delegate to test agents

---

## V3.13 Dual Token + Network Members (2026-04-11) — COMPLETE

### Stats
- 170+ commits, 55 npm preview packages (preview.27)
- 198 Docker E2E + 42 local E2E
- 13 database tables, 18 MCP tools, 24 REST endpoints, 37 CLI commands

### Added since V3.12
- **Dual token**: utok_ (user, global) + ntok_ (network, per-node)
- **network_members table**: user ↔ network many-to-many with roles (owner/admin/member/viewer)
- **network_invites table**: invite codes with max_uses + expiry
- **6 new API endpoints**: member CRUD, invite, join
- **POST /api/auth/node-token**: create ntok_ for a specific node
- **anet network invite/join/members**: CLI commands
- **anet create**: interactive network picker with role icons
- **anet login**: network picker after login
- **First user auto-admin**: first registered user gets admin role
- **Design docs**: auth-network V2 + CLI/Dashboard UX (7 scenarios, 8 pages)

### Product Direction (Vincent confirmed)
- Pure local self-deploy (no hosted hub)
- SQLite only (PG code retained, not promoted)
- Token transparent to users (CLI manages automatically)
- Two-level scope: global + project/node level

---

## V3.8 Docs Alignment + v1.0.0 Polish (2026-04-11) — COMPLETE

### Stats
- 158 commits, 52 npm preview packages
- 200 Docker tests + 19 adapter E2E tests
- 11 database tables, 18 MCP tools, 17 REST endpoints, 34 CLI commands
- Code audit: CLEAN (no dead code, no secrets, no unused imports)

### Added since V3.7
- **README alignment**: CLI 26→34 commands, npm versions updated, PG quick-start added
- **CHANGELOG v1.0.0-preview.25**: Full release notes for PG adapter, architecture, testing
- **Code audit**: Zero issues found (all console.log intentional, no hardcoded secrets)
- **Production upgrade request**: Sent to Vincent for approval

### Status
- P0 "代码清理" ✅ DONE (code audit clean)
- P1 PostgreSQL ✅ DONE (adapter + translator + E2E)
- P1 试用期+授权码 ✅ DONE (V3.0)
- Production server: awaiting Vincent approval to upgrade from v0.4.1

---

## V3.7 E2E Verified + Demo (2026-04-11) — COMPLETE

### Stats
- 155 commits, 52 npm preview packages
- 200 Docker tests + 19 adapter E2E tests verified
- 11 database tables, 18 MCP tools, 17 REST endpoints, 34 CLI commands

### Added since V3.6
- **Adapter E2E verification**: 19/19 tests pass (health, register, login, auth, networks, MCP CRUD, transactions, tokens, password, license)
- **One-click demo**: `examples/demo-one-click.sh` — 8-step automated showcase (3 virtual agents, task dispatch, completion, results dashboard)
- **PgAdapter improvement**: Cleaner querySync, startup connection test, DDL idempotency

### Deferred
- Production server upgrade to V3.6 code (currently running v0.4.1)
- Docker image rebuild with adapter code

---

## V3.6 PostgreSQL Dual Support (2026-04-11) — COMPLETE

### Stats
- 152 commits, 52 npm preview packages
- 200 total regression tests (137 base + 25 auth + 22 network + 16 config)
- 11 database tables, 18 MCP tools, 17 REST endpoints, 34 CLI commands
- SQL translator: 161 SQL fragments audit clean, 10/10 unit tests

### Added since V3.5
- **SQLiteAdapter**: Full implementation wrapping bun:sqlite (run/get/all/exec/transaction/close)
- **DbAdapter interface**: Unified sync interface for all DB access
- **85+ call sites migrated**: Zero raw db.query() remains in server/src/
- **PgAdapter**: SQL auto-translation (datetime→NOW, ?N→$N, datetime('now',?N)→NOW()+$N::INTERVAL, AUTOINCREMENT→SERIAL, TEXT DEFAULT→TIMESTAMP DEFAULT)
- **DATABASE_URL**: env-driven adapter selection (postgres:// → PG, else SQLite)
- **createAdapter() factory**: Single entry point for DB initialization
- **db.ts simplified**: From 14 lines hardcoded SQLite → 1 line `createAdapter()`
- **README updated**: PostgreSQL section with usage docs
- **npm published**: commhub-server@0.5.0-preview.25

### Deferred
- Async adapter interface (for true PG performance — all callers add `await`)
- PG real-world integration test (needs PG instance)

---

## V3.5 PG Prep (2026-04-11) — db.transaction() + adapter wiring

### Stats
- 148 commits, 51 npm preview packages
- 200 total regression tests (137 base + 25 auth + 22 network + 16 config)
- 11 database tables, 18 MCP tools, 17 REST endpoints, 34 CLI commands
- All evaluations 10/10

### Added since V3.4
- **db.transaction() migration**: All 7 manual BEGIN/COMMIT/ROLLBACK blocks converted to `db.transaction()` IIFE pattern
- **SQLiteAdapter class**: Wraps bun:sqlite, implements DbAdapter interface
- **Full adapter wiring**: 85+ db.query() calls migrated to db.get()/db.all()/db.run()
- **Zero raw DB access**: All server code goes through adapter — PG-ready

---

## V3.4 Polished (2026-04-11) — v1.0.0 READY

### Stats
- 144 commits, 51 npm preview packages
- 200 total regression tests (137 base + 25 auth + 22 network + 16 config)
- 11 database tables, 18 MCP tools, 17 REST endpoints, 34 CLI commands
- All evaluations 10/10
- GitHub Actions CI: GREEN
- Security scan: CLEAN

### Added since V3.3
- **Token management**: create/list/revoke API + anet token CLI
- **Network rename**: PUT /api/networks/:id + anet network rename
- **Network delete**: DELETE /api/networks/:id + anet network delete --force
- **Password change**: POST /api/auth/password + anet passwd CLI
- **anet config**: view configuration summary
- **anet demo**: live system dashboard
- **Enhanced /health**: version, api_version, capabilities, license
- **Enhanced doctor**: shows server version + multi-network + license
- **Friendly errors**: connection/auth/permission/rate-limit messages
- **Network auto-inherit**: anet create writes network_id from current network
- **npm metadata**: updated descriptions + keywords for discoverability

### Deferred to Next Sprint
- PostgreSQL adapter (P1)
- OAuth Google login (P2)
- Official hosted network (P2)

---

## V3.3 (2026-04-10)

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

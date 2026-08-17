# Changelog

> **⚠️ 本文件为历史归档（2026-04 之前的 v1.0.0-preview.x 系列开发日志）**
>
> 2026-04 后版本号体系重新规划，去掉"v1.0.0-preview"的过度承诺改用 v0.6 / v0.7 / v0.8 / v0.9 / v0.10 渐进发布。**当前 stable 以 npm `latest` 与 [docs-site/docs/changelog.md](./docs-site/docs/changelog.md) 为准；完整版本矩阵见 [docs/version/README.md](./docs/version/README.md)（本文件归档时对应锚点 v0.10.15）。v0.8.1 是 OSS 首发版本。**
>
> **认准的更新日志**：[docs-site/docs/changelog.md](./docs-site/docs/changelog.md) 或 [anet.sh/changelog](https://anet.sh/changelog) — 包含 v0.6.x ~ v0.10.x 全部 release notes，含本次 OSS 发布。
>
> 关于这里描述的 "PostgreSQL support" 等设计：见 [`docs/v3-postgresql-design.md`](./docs/v3-postgresql-design.md) 顶部 banner — **PostgreSQL 已搁置**，v0.8 仅支持 SQLite。
>
> 本文件保留作历史记录，不删除以保留 git blame 完整性。

---

## v1.0.0-preview.25 (2026-04-11)

### PostgreSQL + Adapter Architecture

#### New Features
- **PostgreSQL support**: `DATABASE_URL=postgres://...` enables PostgreSQL (SQLite remains default)
- **DbAdapter interface**: Unified database abstraction (SQLiteAdapter + PgAdapter)
- **SQL auto-translator**: `sqliteToPostgres()` handles datetime→NOW, ?N→$N, AUTOINCREMENT→SERIAL
- **34 CLI commands**: Added passwd, token (create/ls/revoke), network (info/rename/delete), demo, config, license, activate, server local
- **17 REST endpoints**: Added PUT /api/networks/:id, DELETE /api/networks/:id, POST /api/auth/password, token CRUD
- **One-click demo**: `bash examples/demo-one-click.sh` — 60-second automated showcase
- **createAdapter() factory**: Environment-driven DB selection

#### Architecture
- All 85+ raw `db.query()` calls migrated to adapter methods (`db.get()`, `db.all()`, `db.run()`)
- All 7 manual `BEGIN/COMMIT/ROLLBACK` transactions converted to `db.transaction()`
- Zero raw database access — all code goes through `DbAdapter` interface
- SQL translator handles 161 SQL fragments across 4 source files

#### Testing
- 200 Docker E2E tests (137 base + 25 auth + 22 network + 16 config)
- 19 adapter-specific E2E tests (verified post-refactor)
- 10 SQL translator unit tests

---

## v1.0.0-preview (2026-04-10)

### Agent Network V3 — Multi-Network + Commercial Ready

#### New Features
- **Multi-network support**: Create isolated networks, each with their own nodes/tasks/sessions
- **User system**: Register/login with username+password, API token authentication
- **Trial licensing**: 14-day free trial, license key activation for Pro
- **34 CLI commands**: quickstart, login, register, passwd, token, network (create/ls/use/info/rename/delete), status, tasks, doctor, info, logs, demo, config, license, activate, server local...
- **18 MCP tools**: send_task, send_reply, retry_task, cancel_task, reassign_task, list_tasks, get_task...
- **17 REST endpoints**: /api/auth/*, /api/networks/*, /api/tasks, /api/nodes, /api/stats, /api/audit-log, /api/license...
- **3 AI runtimes**: codex-sdk (GPT-5.4), claude-agent-sdk (Claude), http-api (MiniMax/OpenAI compatible)
- **Audit logging**: Every user action + task state change recorded
- **Rate limiting**: Register 30/min, login 10/min per IP

#### Security
- MCP/SSE/WebSocket authentication
- Server-enforced network_id (token-bound, no client override)
- SQL injection fixes (parameterized queries)
- Network ownership checks (403 on cross-user access)
- Password hashing (SHA-256)
- Localhost exempted from rate limit (dev/test)

#### Database (13 tables)
sessions, inbox, tasks, nodes, completions, task_events, users, networks, api_tokens, audit_log, licenses, network_members, network_invites

#### Testing (200 regression tests)
- Base E2E: 137 tests (node lifecycle, message lifecycle, auth, license, SSE, concurrency)
- Auth suite: 25 tests (register, login, token, profile, password, audit, rate limit)
- Network suite: 22 tests (CRUD, isolation, ownership, rename, delete, cross-user)
- Config priority: 16 tests (CLI > env > project > global)
- Real AI: Codex GPT-5.4 + MiniMax (Anthropic API) verified
- 10-agent idiom chain game (mixed codex + minimax)

#### npm packages
- @sleep2agi/agent-network (anet CLI)
- @sleep2agi/agent-node (Agent runtime)
- @sleep2agi/commhub-server (Communication hub)

---

## v0.x (2026-03 to 2026-04-09) — Pre-V3

- Basic CommHub Server with MCP + SSE
- agent-node with Claude + Codex dual runtime
- anet CLI (create/start/resume/channel)
- Dashboard basic

# Changelog

## v1.0.0-preview (2026-04-10)

### Agent Network V3 — Multi-Network + Commercial Ready

#### New Features
- **Multi-network support**: Create isolated networks, each with their own nodes/tasks/sessions
- **User system**: Register/login with username+password, API token authentication
- **Trial licensing**: 14-day free trial, license key activation for Pro
- **30 CLI commands**: quickstart, login, register, network, status, tasks, doctor, info, logs, license, activate, server local...
- **18 MCP tools**: send_task, send_reply, retry_task, cancel_task, reassign_task, list_tasks, get_task...
- **13 REST endpoints**: /api/auth/*, /api/networks/*, /api/tasks, /api/nodes, /api/stats, /api/audit-log, /api/license...
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

#### Database (11 tables)
sessions, inbox, tasks, nodes, completions, task_events, users, networks, api_tokens, audit_log, licenses

#### Testing (186 regression tests)
- Base E2E: 137 tests (node lifecycle, message lifecycle, auth, license, SSE, concurrency)
- Auth suite: 17 tests (register, login, token, profile, audit, rate limit)
- Network suite: 16 tests (CRUD, isolation, ownership, cross-user)
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

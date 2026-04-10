# Agent Network Evolution Log

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

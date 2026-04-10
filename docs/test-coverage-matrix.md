# V3 Test Coverage Matrix

## Test Suites

| Suite | Tests | Command |
|-------|-------|---------|
| Base E2E | 126 | `docker run --rm anet-e2e /app/test-all.sh` |
| Config Priority | 16 | `docker run --rm anet-e2e /app/test-config.sh` |
| Codex Real | 7 | `docker run --rm -v ~/.codex:/root/.codex anet-e2e /app/test-codex.sh` |
| MiniMax Real | 7 | `docker run --rm -e ANTHROPIC_BASE_URL=... -e ANTHROPIC_API_KEY=... anet-e2e /app/test-minimax.sh` |
| NPM Smoke | 12 | `docker build --no-cache -t anet-npm-test -f tests/Dockerfile.npm . && docker run --rm anet-npm-test` |
| Mixed Game | 10 agents | `docker run --rm -v ~/.codex:/root/.codex -e ANTHROPIC_BASE_URL=... anet-e2e /app/test-mixed.sh` |
| Demo | interactive | `docker run --rm -v ~/.codex:/root/.codex anet-e2e /app/demo.sh` |
| **Total** | **168+** | |

## Coverage by Component

### anet CLI
| Feature | Test | Status |
|---------|------|--------|
| anet -v | version output | ✅ |
| anet upgrade | no self-destruct | ✅ |
| anet create | config.json generated | ✅ |
| anet create | node_id generated (n_ prefix) | ✅ |
| anet create | node_name saved | ✅ |
| anet create | runtime correct | ✅ |
| anet create | model correct | ✅ |
| anet create | session omitted when empty | ✅ |
| anet create | legacy name field removed | ✅ |
| anet create | invalid name rejected | ✅ |
| anet create | duplicate name rejected | ✅ |
| anet create | default flags (dangerouslySkipPermissions) | ✅ |
| anet rename | by node_id | ✅ |
| anet rename | config path migrated | ✅ |
| anet rename | node_name updated | ✅ |
| anet rename | lookup by node_id after rename | ✅ |
| anet channel add | telegram .env created | ✅ |
| anet channel add | .env chmod 600 | ✅ |
| anet channel add | config.json updated | ✅ |
| anet ls | shows nodes | ✅ |
| anet ls | STATUS column | ✅ |
| anet stop | non-running node | ✅ |
| anet stop | server notified offline | ✅ |
| anet delete | requires --force | ✅ |
| anet delete | directory removed | ✅ |
| anet create interactive | | ❌ (requires TTY) |

### agent-node
| Feature | Test | Status |
|---------|------|--------|
| --version | output | ✅ |
| CommHub registration | report_status(idle) | ✅ |
| SSE connection | receives new_task | ✅ |
| Inbox pull | get_inbox | ✅ |
| Ack | ack_inbox | ✅ |
| send_reply | with in_reply_to | ✅ |
| Message type filter | skip reply/message | ✅ (mock) |
| Low-value filter | skip inbound | ✅ (mock) |
| Low-value filter | don't skip AI replies | ✅ (codex "4") |
| Emoji regex | digits not filtered | ✅ (codex "4") |
| callCommHub retry | 3x with backoff | ✅ (unit) |
| writebackSession | warns on error | ✅ (unit) |
| PKG_VERSION | from package.json | ✅ |
| Codex runtime | real GPT-5.4 | ✅ |
| Claude runtime | protocol flow | ✅ |
| HTTP API runtime | endpoint call | ✅ |
| Shutdown | report offline | ✅ |
| node_id reporting | register sends node_id | ✅ |
| session_id reporting | heartbeat sends session_id | ✅ |
| model reporting | register sends model | ✅ |
| Config: CLI > env > project > global | hub/token/runtime/model/alias | ✅ (16 tests) |

### CommHub Server
| Feature | Test | Status |
|---------|------|--------|
| Health endpoint | /health ok | ✅ |
| send_task | dispatch to inbox + tasks | ✅ |
| send_task | SSE push | ✅ |
| send_task | sets expires_at | ✅ (schema) |
| send_message | no processing trigger | ✅ |
| send_reply | updates tasks table | ✅ |
| send_reply | with in_reply_to | ✅ |
| send_reply | status=failed | ✅ |
| send_ack | updates tasks table | ✅ |
| get_inbox | returns pending messages | ✅ |
| ack_inbox | marks acked + syncs tasks | ✅ |
| report_status | upserts sessions | ✅ |
| report_status | V2 fields (node_id etc.) | ✅ |
| report_status | offline accepted | ✅ |
| report_status | upserts nodes table | ✅ |
| report_completion | syncs tasks table | ✅ |
| broadcast | multi-session | ✅ |
| Task expiration patrol | 5min interval | ✅ (code) |
| /api/tasks | query by task_id | ✅ |
| /api/tasks | filter by status | ✅ |
| /api/tasks | filter by from_name | ✅ |
| /api/tasks | filter by to_name + limit | ✅ |
| /api/tasks | combined filters | ✅ |
| /api/nodes | query | ✅ |
| /api/messages | recent messages | ✅ |
| /api/status | all sessions | ✅ |
| /api/completions | recent completions | ✅ |
| Priority ordering | high first in inbox | ✅ |
| Special characters | XSS, quotes, CJK | ✅ |
| Graceful errors | reply to non-existent task | ✅ |

### Security (Auth)
| Feature | Test | Status |
|---------|------|--------|
| REST no token → 401 | | ✅ |
| REST wrong token → 401 | | ✅ |
| REST correct token → 200 | | ✅ |
| REST query param token → 200 | | ✅ |
| Health no auth needed | | ✅ |
| MCP with token → 200 | | ✅ |
| MCP without token → 401 | | ✅ |
| SSE without token → 401 | | ✅ |
| SSE with token → 200 | | ✅ |
| WebSocket tmux without token → 401 | | ✅ |

### Task Lifecycle
| State Transition | Test | Status |
|-----------------|------|--------|
| → delivered (send_task) | | ✅ |
| delivered → acked (ack_inbox) | | ✅ |
| acked → running (report_status working) | | ✅ |
| running → replied (send_reply) | | ✅ |
| → failed (send_reply status=failed) | | ✅ |
| All timestamps set | created/delivered/completed | ✅ |
| Result stored | tasks.result | ✅ |
| REST query lifecycle | /api/tasks | ✅ |

### Multi-Agent
| Feature | Test | Status |
|---------|------|--------|
| 10 agents concurrent registration | | ✅ |
| Sequential task passing (1→2→...→10) | | ✅ |
| Real AI processing (codex GPT-5.4) | | ✅ |
| 2-round game | | ✅ |

### Missing Tests (TODO)
| Feature | Priority |
|---------|----------|
| Concurrent writes (multi-agent same inbox) | P1 |
| Transaction rollback verification | P1 |
| Large content (>10KB task) | P2 |
| MiniMax runtime real test | P1 |
| Claude Agent SDK real test (needs Claude Code in Docker) | P2 |
| SSE reconnection after server restart | P2 |
| Task expiration E2E (wait for expiry) | P2 |
| Agent crash recovery | P2 |

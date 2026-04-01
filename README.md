# Agent Orchestra

> Open-source patterns and designs for orchestrating multiple AI Agent sessions across servers.

---

## What Is This?

A collection of battle-tested patterns for coordinating multiple AI coding agents (Claude Code, Codex, etc.) running across distributed servers. Born from real-world experience managing 15+ concurrent agent sessions on 4 servers.

## Architecture Decision (2026-04-01)

**MCP SSE Star Topology** -- a single Commander MCP Server at the center, all sessions (Claude Code + Codex) connect via persistent SSE.

```
                    ┌────────────────────────────┐
                    │   Commander MCP Server      │
                    │   47.77.216.1:9200          │
                    │                              │
                    │   MCP SSE  +  HTTP REST     │
                    │   (dual interface)           │
                    └──────────┬───────────────────┘
                               │
          ┌────────┬───────┬───┴───┬───────┬────────┐
          │        │       │       │       │        │
       Claude   Claude  Claude  Codex   Codex   Claude
       Code #1  Code #2 Code #N  #1      #2     Code #M
       (硅谷)   (Mac)   (上海)  (硅谷)  (Mac)   (6002)
```

### Key Design Decisions

1. **Star topology, not point-to-point** -- 30 sessions = 30 SSE connections to one hub. No N^2 mesh.
2. **MCP SSE, not polling** -- persistent Server-Sent Events connections, real-time push. No wasted tokens on empty polls.
3. **Dual interface** -- MCP SSE for Claude Code/Codex native integration + HTTP REST for dashboards, scripts, and external tools.
4. **Cross-model communication** -- Claude Code ↔ Codex sessions communicate through Commander as relay. No direct wiring needed.
5. **Single server** -- one Commander process, one SQLite database. Simple to operate, easy to reason about.

### Client Configuration

**Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "commander": {
      "url": "http://47.77.216.1:9200/sse"
    }
  }
}
```

**Codex** (`config.json`):
```json
{
  "mcpServers": {
    "commander": {
      "url": "http://47.77.216.1:9200/sse"
    }
  }
}
```

### Tech Stack

| Component | Choice |
|-----------|--------|
| Runtime | Bun 1.2+ |
| Language | TypeScript |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Database | SQLite (`bun:sqlite`) |
| Transport | MCP SSE + HTTP REST |
| Process mgmt | systemd |

## Core Problem

When running multiple AI agents in tmux sessions across servers, you face:

1. **No structured communication** -- `tmux send-keys` can't tell if you're in a shell or an agent UI
2. **Cross-server coordination is painful** -- SSH nesting, timeouts, ANSI escape codes
3. **No message queue** -- commands sent to busy agents get lost
4. **No status awareness** -- you're guessing agent state from screen captures

## Solution Space

This repo documents orchestration approaches from the simplest to production-grade:

| # | Approach | Cross-Server | Reliability | Status |
|---|----------|-------------|-------------|--------|
| 1 | tmux send-keys | Yes (SSH) | 20% | Legacy fallback |
| 2 | Codex MCP Tool | Local only | 95% | Verified |
| 3 | Codex Plugin | Local only | 95% | Verified |
| 4 | Agent Teams | Local only | 90% | Enabled |
| 5 | MCO (Multi-CLI Orchestrator) | Local only | 90% | Available |
| 6 | oh-my-claudecode | Local only | 85% | Community |
| **7** | **Commander MCP (SSE star)** | **Yes** | **99%** | **Confirmed architecture** |

## Key Insight

**MCP Tool calls are 10x more efficient than tmux-based orchestration.** A single `mcp__codex__codex()` call returns structured results in 30 seconds. The tmux approach takes 3-5 minutes of SSH, window detection, send-keys, capture-pane, and ANSI parsing -- and often fails.

**MCP SSE is the endgame for cross-server.** Persistent connections, real-time push, structured JSON, no polling overhead. One Commander Server handles 30+ sessions with 30 SSE connections.

## Documentation

- [`docs/architecture-decision.md`](docs/architecture-decision.md) -- Architecture decision record: MCP SSE star topology (2026-04-01)
- [`docs/orchestration-guide.md`](docs/orchestration-guide.md) -- Full comparison of all approaches with cost analysis and migration path
- [`docs/commander-mcp-design.md`](docs/commander-mcp-design.md) -- Detailed design for the Commander MCP Server (SSE + REST dual interface)
- [`docs/experience.md`](docs/experience.md) -- 48-hour field report: managing 15+ agent sessions, lessons learned, and operational principles

## Adoption Path

### Phase 1: Immediate (Today)
1. Codex MCP Tool for local code review/refactoring
2. Agent Teams for local parallel tasks

### Phase 2: This Week
3. **Commander MCP Server MVP** -- SSE star topology, 9 MCP Tools, SQLite state
4. All sessions connect via `settings.json` / `config.json`

### Phase 3: Next Week
5. HTTP REST dashboard for monitoring
6. Fully retire tmux send-keys for agent communication

## Community Projects Referenced

- [oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode) -- 5+ parallel Claude Code instances with Git worktree isolation
- [Citadel](https://github.com/SethGammon/Citadel) -- Enterprise-grade 4-layer routing + `/do` command
- [claude-octopus](https://github.com/nyldn/claude-octopus) -- 8+ provider coordination with consensus gating
- [MCO](https://github.com/mco-org/mco) -- Multi-CLI Orchestrator for parallel model review

## License

MIT

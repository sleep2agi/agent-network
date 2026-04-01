# Agent Orchestra

> Open-source patterns and designs for orchestrating multiple AI Agent sessions across servers.

---

## What Is This?

A collection of battle-tested patterns for coordinating multiple AI coding agents (Claude Code, Codex, etc.) running across distributed servers. Born from real-world experience managing 15+ concurrent agent sessions on 4 servers.

## Core Problem

When running multiple AI agents in tmux sessions across servers, you face:

1. **No structured communication** -- `tmux send-keys` can't tell if you're in a shell or an agent UI
2. **Cross-server coordination is painful** -- SSH nesting, timeouts, ANSI escape codes
3. **No message queue** -- commands sent to busy agents get lost
4. **No status awareness** -- you're guessing agent state from screen captures

## Solution Space

This repo documents 8 orchestration approaches, from the simplest to production-grade:

| # | Approach | Cross-Server | Reliability | Status |
|---|----------|-------------|-------------|--------|
| 1 | tmux send-keys | Yes (SSH) | 20% | Legacy fallback |
| 2 | Codex MCP Tool | Local only | 95% | Verified |
| 3 | Codex Plugin | Local only | 95% | Verified |
| 4 | Agent Teams | Local only | 90% | Enabled |
| 5 | MCO (Multi-CLI Orchestrator) | Local only | 90% | Available |
| 6 | oh-my-claudecode | Local only | 85% | Community |
| 7 | Commander MCP (polling) | Yes | 95% | Design complete |
| 8 | Commander Channel (push) | Yes | 99% | Design complete |

## Key Insight

**MCP Tool calls are 10x more efficient than tmux-based orchestration.** A single `mcp__codex__codex()` call returns structured results in 30 seconds. The tmux approach takes 3-5 minutes of SSH, window detection, send-keys, capture-pane, and ANSI parsing -- and often fails.

## Documentation

- [`docs/orchestration-guide.md`](docs/orchestration-guide.md) -- Full comparison of all 8 approaches with cost analysis and migration path
- [`docs/commander-mcp-design.md`](docs/commander-mcp-design.md) -- Detailed design for the cross-server Commander MCP Server (Plan A: polling + Plan B: push via Channel protocol)
- [`docs/experience.md`](docs/experience.md) -- 48-hour field report: managing 15+ agent sessions, lessons learned, and operational principles

## Recommended Adoption Path

### Phase 1: Immediate (Day 1)
1. Codex MCP Tool for local code review/refactoring
2. Codex Plugin for `/codex:review` + `/codex:adversarial-review`
3. Agent Teams for local parallel tasks

### Phase 2: This Week (1-3 days)
4. Install MCO for multi-model parallel review
5. Commander MCP Server MVP for cross-server structured communication

### Phase 3: Next Week
6. Commander Channel for push-based event-driven orchestration
7. Fully retire tmux send-keys for agent communication

## Community Projects Referenced

- [oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode) -- 5+ parallel Claude Code instances with Git worktree isolation
- [Citadel](https://github.com/SethGammon/Citadel) -- Enterprise-grade 4-layer routing + `/do` command
- [claude-octopus](https://github.com/nyldn/claude-octopus) -- 8+ provider coordination with consensus gating
- [MCO](https://github.com/mco-org/mco) -- Multi-CLI Orchestrator for parallel model review

## License

MIT

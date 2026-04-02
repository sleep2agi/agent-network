# Architecture Decision Record: MCP Streamable HTTP Star Topology

> Date: 2026-04-01
> Status: Confirmed
> Supersedes: Commander MCP Design v0.3.0 (Plan A polling + Plan B push)

---

## Decision

Adopt **MCP Streamable HTTP star topology** as the sole cross-server communication architecture. All sessions (Claude Code + Codex) connect to a single Commander MCP Server via persistent SSE connections.

## Context

After 48 hours of operating 15+ agent sessions across 4 servers, and evaluating 8 different orchestration approaches, we confirmed:

1. **tmux send-keys is broken at scale** -- 20% reliability, 3-5 min latency, ANSI parsing nightmares
2. **Polling wastes tokens** -- empty polls burn API credits, add latency, and create complexity
3. **Point-to-point doesn't scale** -- N sessions = N^2 connections is unmanageable
4. **Star topology is the only sane design** -- 30 sessions = 30 connections, one hub

## Architecture

```
                    ┌─────────────────────────────────┐
                    │      Commander MCP Server         │
                    │      your-server-ip:9200             │
                    │                                   │
                    │  ┌───────────┐  ┌─────────────┐  │
                    │  │  MCP Streamable HTTP  │  │  HTTP REST   │  │
                    │  │  /mcp     │  │  /api/...    │  │
                    │  └─────┬─────┘  └──────┬──────┘  │
                    │        │               │         │
                    │  ┌─────▼───────────────▼──────┐  │
                    │  │       SQLite Database       │  │
                    │  │  sessions | inbox | results │  │
                    │  └────────────────────────────┘  │
                    └────────────────┬─────────────────┘
                                     │
              ┌──────────┬──────────┬┴──────────┬──────────┐
              │          │          │           │          │
         ┌────▼────┐ ┌───▼────┐ ┌──▼─────┐ ┌──▼─────┐ ┌──▼─────┐
         │ Claude  │ │ Claude │ │ Claude │ │ Codex  │ │ Codex  │
         │ Code    │ │ Code   │ │ Code   │ │ CLI    │ │ CLI    │
         │ 硅谷×9  │ │ Mac×6  │ │ 上海×4 │ │ 硅谷×2 │ │ Mac×1  │
         └─────────┘ └────────┘ └────────┘ └────────┘ └────────┘
```

## Key Decisions

### 1. SSE, Not Polling

**Old plan (v0.3.0)**: Plan A was MCP Tool polling (agent calls `get_inbox()` every few minutes), Plan B was push.

**New decision**: Skip polling entirely. Go straight to SSE persistent connections.

**Why**:
- Polling burns tokens on empty checks
- Polling adds 1-5 min latency
- SSE is natively supported by MCP SDK (`WebStandardStreamableHTTPServerTransport`)
- 30 persistent SSE connections are trivial for a single server

### 2. Single Commander Server

One process, one database, one endpoint. No federation, no sharding.

**Why**:
- 30 sessions is well within single-server capacity
- SQLite handles this throughput easily
- Operational simplicity >> distributed complexity
- Can always scale later if needed (but probably never will)

### 3. Dual Interface: MCP Streamable HTTP + HTTP REST

| Interface | For | Endpoint |
|-----------|-----|----------|
| MCP Streamable HTTP | Claude Code / Codex native integration | `/mcp` |
| HTTP REST | Dashboards, scripts, monitoring, external tools | `/api/...` |

**Why**:
- Claude Code and Codex speak MCP natively -- SSE is the natural transport
- Dashboards and scripts need simple HTTP (curl, fetch, browser)
- Same SQLite backend serves both, no data duplication

### 4. Cross-Model Communication via Commander

Claude Code sessions and Codex sessions communicate **through Commander**, not directly.

```
Claude Code #1 ──send_task()──▶ Commander ──inbox──▶ Codex #1
Codex #1 ──report_completion()──▶ Commander ──completion──▶ Claude Code #1
```

**Why**:
- Claude Code and Codex have different MCP capabilities
- Direct wiring creates fragile coupling
- Commander as relay provides: message queue, retry, audit log, state tracking
- Works even when sender and receiver are on different servers

### 5. Star, Not Mesh

30 sessions, 30 SSE connections. Not 30×29 = 870 point-to-point links.

**Why**:
- Linear scaling (add session = add 1 connection)
- Single point of truth for all state
- Easy monitoring (one dashboard shows everything)
- Simple firewall rules (only Commander port needs to be open)

## Tech Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Runtime | Bun 1.2+ | Consistent with ecosystem, native SQLite |
| Language | TypeScript | Type safety, MCP SDK compatibility |
| MCP SDK | `@modelcontextprotocol/sdk` | Official, SSE transport built-in |
| Database | SQLite (`bun:sqlite`) | Zero-config, Bun native, sufficient throughput |
| Process mgmt | systemd | Auto-restart, log management |

## Client Configuration

### Claude Code

In `~/.claude/settings.json` (global) or project `.mcp.json`:

```json
{
  "mcpServers": {
    "commander": {
      "url": "http://your-server-ip:9200/mcp"
    }
  }
}
```

### Codex

In `config.json`:

```json
{
  "mcpServers": {
    "commander": {
      "url": "http://your-server-ip:9200/mcp"
    }
  }
}
```

### Firewall

```bash
# Only allow known agent server IPs
iptables -A INPUT -p tcp --dport 9200 -s <SERVER_1_IP> -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -s <SERVER_2_IP> -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -s <SERVER_3_IP> -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -j DROP
```

## What This Replaces

| Before | After |
|--------|-------|
| tmux send-keys + capture-pane | MCP Tool calls via SSE |
| SSH nesting for cross-server | Direct SSE to Commander |
| Screen scraping for status | Structured JSON via `report_status()` |
| No message queue | SQLite inbox with priority + ACK |
| Polling for inbox | SSE push (real-time) |
| Plan A + Plan B phased approach | Single SSE architecture from day 1 |

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Commander single point of failure | systemd auto-restart + SQLite is crash-safe |
| SSE connection drops | Auto-reconnect with exponential backoff |
| Network partition (server offline) | Offline detection (10min heartbeat timeout) + alert |
| SQLite write contention | WAL mode + serialize writes (throughput is low enough) |

## Open Questions

1. **Authentication**: Token-based auth or IP whitelist only? (Currently: IP whitelist)
2. **Web dashboard**: Build custom or use existing tool? (Deferred to Phase 3)
3. **Message retention**: How long to keep completed tasks? (Proposed: 30 days)

# Commander MCP Server Design Document

> Version: v0.3.0 (Architecture Confirmed)
> A cross-server orchestration hub for AI Agent sessions using Model Context Protocol (MCP).
> Architecture decision: MCP SSE star topology confirmed 2026-04-01.

---

## 1. Overview

### 1.1 Problem

When running 15+ AI agent sessions across multiple servers, communication via `tmux send-keys` + `capture-pane` has critical flaws:

1. **Can't distinguish Shell vs Agent UI** -- `send-keys` doesn't know where the cursor is (shell prompt? agent input? confirmation dialog?)
2. **Missed Enter keys** -- Content sent without trailing `Enter` appears typed but never executes
3. **capture-pane garbled output** -- ANSI escape codes, Unicode, progress bars all mixed together; regex parsing is extremely fragile
4. **SSH nesting for cross-server** -- Long chains, frequent timeouts
5. **No structured state** -- Only screen-scraping guesswork for session status
6. **No message queue** -- Commands sent to busy agents are lost

### 1.2 Solution

Build a **Commander MCP Server** -- a standard MCP Server running on a central server, acting as communication hub for all agents:

- Child agents **proactively report** status and results via MCP protocol (no more screen scraping)
- Hub **dispatches commands** to child agents' inbox via MCP protocol (no more send-keys)
- All communication via MCP SSE, structured JSON, natively cross-server
- Both Claude Code and Codex connect to the same Commander Server

**Core idea**: From "hub reads child agent screens" to "child agents proactively report to hub".

### 1.3 Confirmed Architecture: MCP SSE Star Topology

> Previous v0.2.0 had "Plan A (polling) + Plan B (push)". This is superseded.
> Decision: go directly with SSE persistent connections. No polling phase.

| Property | Value |
|----------|-------|
| **Topology** | Star -- single Commander hub, all sessions connect to it |
| **Transport** | MCP SSE (persistent connections, real-time push) |
| **Dual interface** | MCP SSE (`/sse`) for agents + HTTP REST (`/api/...`) for dashboards |
| **Clients** | Claude Code (`settings.json`) + Codex (`config.json`) |
| **Cross-model** | Claude ↔ Codex communicate via Commander relay |
| **Scaling** | 30 sessions = 30 SSE connections (linear, not N^2) |

See [`architecture-decision.md`](architecture-decision.md) for the full decision record.

---

## 2. Architecture (MCP SSE Star)

```
                    ┌─────────────────────────────────────┐
                    │       Commander MCP Server            │
                    │       your-server-ip:9200                │
                    │                                       │
                    │  ┌───────────┐  ┌─────────────────┐  │
                    │  │  MCP SSE  │  │   HTTP REST     │  │
                    │  │  /sse     │  │   /api/status   │  │
                    │  │           │  │   /api/task     │  │
                    │  └─────┬─────┘  └────────┬────────┘  │
                    │        │                 │           │
                    │  ┌─────▼─────────────────▼────────┐  │
                    │  │       SQLite (WAL mode)         │  │
                    │  │  sessions | inbox | completions │  │
                    │  └────────────────────────────────┘  │
                    └──────────────────┬───────────────────┘
                                       │  30 SSE connections
              ┌──────────┬────────────┬┴────────┬──────────┐
              │          │            │         │          │
         ┌────▼────┐ ┌───▼────┐ ┌────▼───┐ ┌──▼─────┐ ┌──▼─────┐
         │ Claude  │ │ Claude │ │ Claude │ │ Codex  │ │ Codex  │
         │ Code    │ │ Code   │ │ Code   │ │ CLI    │ │ CLI    │
         │ Hub     │ │ Mac    │ │ 上海   │ │ 硅谷   │ │ Mac    │
         │ (Opus)  │ │ (Opus) │ │ (Opus) │ │(GPT5.4)│ │(GPT5.4)│
         └─────────┘ └────────┘ └────────┘ └────────┘ └────────┘
```

All clients connect to the same `/sse` endpoint. The Commander Server maintains per-session state and routes messages between any pair of sessions -- including cross-model (Claude ↔ Codex).

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Task Dispatch Flow                         │
│                                                              │
│  Hub ──send_task(session, task)──▶ Commander writes inbox     │
│                                                              │
│  Commander pushes notification via SSE to target session      │
│                                                              │
│  Agent receives task via MCP, calls ack_inbox() to confirm   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Status Report Flow                         │
│                                                              │
│  Agent ──report_status(session, status, task, ...)──▶ upsert │
│                                                              │
│  Hub ──get_all_status()──▶ Commander returns all sessions    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Cross-Model Relay                          │
│                                                              │
│  Claude Code #1 ──send_task("codex-review")──▶ Commander    │
│  Commander ──inbox──▶ Codex #1 (receives via SSE)            │
│  Codex #1 ──report_completion()──▶ Commander                 │
│  Commander ──completion──▶ Claude Code #1 (queries results)  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. MCP Tools Definition

### 3.1 Child Agent Tools

#### `report_status` -- Status Report

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| session_name | string | Yes | Session identifier |
| status | enum | Yes | `working` / `idle` / `blocked` / `error` / `waiting_input` |
| task | string | No | Current task description |
| output | string | No | Recent output/log (max 4000 chars) |
| score | number | No | Self-score 1-10 |
| progress | number | No | Progress percentage 0-100 |
| server | string | No | Server identifier (first report) |

**Returns:** `{ ok, session_name, inbox_count, broadcast_count }`

Design: Returns `inbox_count` so agent knows if there are new tasks when reporting status. "Report and pull" pattern.

#### `report_completion` -- Task Completion Report

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| session_name | string | Yes | Session identifier |
| task | string | Yes | Completed task description |
| result | string | Yes | Result summary |
| artifacts | string[] | No | Output links/paths (URLs, file paths) |
| score | number | No | Self-score 1-10 |
| duration_minutes | number | No | Duration in minutes |

#### `get_inbox` -- Get Commands

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| session_name | string | Yes | Session identifier |
| limit | number | No | Max messages to return (default 10) |
| include_broadcast | boolean | No | Include broadcast messages (default true) |

#### `ack_inbox` -- Acknowledge Receipt

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| session_name | string | Yes | Session identifier |
| message_id | string | Yes | Message ID |
| response | string | No | Response content |

### 3.2 Hub Tools

#### `get_all_status` -- Global Status Overview

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| filter_status | enum | No | Filter by status |
| filter_server | string | No | Filter by server |

Returns all sessions with status, task, progress, score, inbox depth, and a summary (`working: 3, idle: 5, blocked: 2, error: 1, offline: 1`).

Design: `offline` status is server-derived -- sessions with no `report_status` for 10+ minutes are automatically marked offline.

#### `send_task` -- Dispatch Task

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| session_name | string | Yes | Target session |
| task | string | Yes | Task content |
| priority | enum | No | `high` / `normal` (default) / `low` |
| deadline | string | No | Deadline (ISO 8601) |
| context | string | No | Additional context |

Returns `session_status` and `inbox_depth` to help hub decide if the session is overloaded.

#### `broadcast` -- Broadcast Message

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| message | string | Yes | Broadcast content |
| filter_server | string | No | Only broadcast to sessions on specific server |
| filter_status | enum | No | Only broadcast to sessions with specific status |

#### `get_completions` -- Get Completion List

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| since | string | No | Start time (ISO 8601), default last 24 hours |
| session_name | string | No | Filter by session |
| limit | number | No | Max results (default 50) |

---

## 4. Data Model

SQLite database at `~/.commander/commander.db`.

### 4.1 sessions table
```sql
CREATE TABLE sessions (
  session_name  TEXT PRIMARY KEY,
  server        TEXT,
  status        TEXT DEFAULT 'offline',
  task          TEXT,
  output        TEXT,
  progress      INTEGER,
  score         INTEGER,
  registered_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

### 4.2 inbox table
```sql
CREATE TABLE inbox (
  id            TEXT PRIMARY KEY,
  session_name  TEXT NOT NULL,
  type          TEXT DEFAULT 'task',
  priority      TEXT DEFAULT 'normal',
  content       TEXT NOT NULL,
  context       TEXT,
  deadline      TEXT,
  from_session  TEXT DEFAULT 'hub',
  acked         INTEGER DEFAULT 0,
  ack_response  TEXT,
  acked_at      TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (session_name) REFERENCES sessions(session_name)
);
CREATE INDEX idx_inbox_session_acked ON inbox(session_name, acked);
```

### 4.3 completions table
```sql
CREATE TABLE completions (
  id              TEXT PRIMARY KEY,
  session_name    TEXT NOT NULL,
  task            TEXT NOT NULL,
  result          TEXT NOT NULL,
  artifacts       TEXT,
  score           INTEGER,
  duration_minutes INTEGER,
  completed_at    TEXT NOT NULL,
  FOREIGN KEY (session_name) REFERENCES sessions(session_name)
);
```

### 4.4 broadcasts table
```sql
CREATE TABLE broadcasts (
  id            TEXT PRIMARY KEY,
  message       TEXT NOT NULL,
  filter_server TEXT,
  filter_status TEXT,
  recipients    TEXT,
  created_at    TEXT NOT NULL
);
```

---

## 5. Deployment

### 5.1 Tech Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Runtime | Bun 1.2+ | Consistent with existing projects, native SQLite |
| Language | TypeScript | Type safety, MCP SDK compatibility |
| MCP SDK | `@modelcontextprotocol/sdk` | Official MCP SDK, SSE transport built-in |
| Transport | MCP SSE + HTTP REST | SSE for agents, REST for dashboards/scripts |
| Database | SQLite (`bun:sqlite`, WAL mode) | Single file, zero config, sufficient for 30 sessions |
| Process management | systemd | Auto-start + crash restart |

### 5.2 Project Structure

```
commander-mcp-server/
├── src/
│   ├── index.ts              # Entry, starts MCP Server
│   ├── tools/
│   │   ├── agent-tools.ts    # 4 child agent tools
│   │   └── commander-tools.ts # 5 hub tools
│   ├── db/
│   │   ├── schema.ts         # Table creation
│   │   └── queries.ts        # SQL query wrappers
│   └── utils/
│       ├── id.ts             # ID generation
│       └── time.ts           # Time handling
├── channel/                   # Plan B: local Channel process
│   └── commander-channel.ts
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

### 5.3 Entry Code Skeleton

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Database } from "bun:sqlite";
import { registerAgentTools } from "./tools/agent-tools";
import { registerCommanderTools } from "./tools/commander-tools";
import { initDB } from "./db/schema";

const PORT = Number(process.env.PORT) || 9200;
const DB_PATH = process.env.COMMANDER_DB || `${process.env.HOME}/.commander/commander.db`;
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode=WAL");
initDB(db);

const server = new McpServer({
  name: "commander",
  version: "0.3.0",
});

registerAgentTools(server, db);
registerCommanderTools(server, db);

// Track active SSE connections for monitoring
const activeConnections = new Map<string, SSEServerTransport>();

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // --- MCP SSE Interface (for Claude Code / Codex) ---
    if (url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", req);
      await server.connect(transport);
      return transport.sseResponse;
    }

    if (url.pathname === "/messages" && req.method === "POST") {
      // MCP message handling (paired with SSE transport)
      // Implementation depends on MCP SDK version
    }

    // --- HTTP REST Interface (for dashboards / scripts) ---
    if (url.pathname === "/api/status") {
      const sessions = db.query("SELECT * FROM sessions ORDER BY updated_at DESC").all();
      return Response.json({ ok: true, sessions, connections: activeConnections.size });
    }

    if (url.pathname === "/api/task" && req.method === "POST") {
      const body = await req.json();
      // REST endpoint for sending tasks (mirrors send_task MCP tool)
      return Response.json({ ok: true, queued: true });
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        version: "0.3.0",
        sessions: db.query("SELECT COUNT(*) as count FROM sessions").get(),
        connections: activeConnections.size,
      });
    }

    return new Response("Commander MCP Server v0.3.0", { status: 200 });
  },
});

console.log(`Commander MCP Server v0.3.0 running on port ${PORT}`);
console.log(`MCP SSE: http://0.0.0.0:${PORT}/sse`);
console.log(`REST API: http://0.0.0.0:${PORT}/api/status`);
console.log(`Health: http://0.0.0.0:${PORT}/health`);
```

### 5.4 Firewall

Restrict port access to known agent server IPs only:
```bash
# Only allow known agent servers
iptables -A INPUT -p tcp --dport 9200 -s <AGENT_SERVER_1_IP> -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -s <AGENT_SERVER_2_IP> -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -s <AGENT_SERVER_3_IP> -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -j DROP
```

---

## 6. Client Integration

### 6.1 Claude Code Configuration

In `~/.claude/settings.json` (recommended for global access):

```json
{
  "mcpServers": {
    "commander": {
      "url": "http://your-server-ip:9200/sse"
    }
  }
}
```

Or per-project `.mcp.json`:

```json
{
  "mcpServers": {
    "commander": {
      "url": "http://your-server-ip:9200/sse"
    }
  }
}
```

### 6.2 Codex Configuration

In `config.json`:

```json
{
  "mcpServers": {
    "commander": {
      "url": "http://your-server-ip:9200/sse"
    }
  }
}
```

### 6.3 Child Agent Usage Rules

Add to each agent's CLAUDE.md:

```markdown
## Commander Communication Rules

### Status Reporting
- Call `report_status(status="working", task="...")` when starting a new task
- Update `report_status(progress=50)` on significant progress
- Call `report_status(status="idle")` when entering idle state
- Call `report_status(status="blocked", output="reason...")` when blocked

### Receiving Commands
- After each `report_status`, check the returned `inbox_count`
- If `inbox_count > 0`, immediately call `get_inbox()` to get commands
- Acknowledge receipt with `ack_inbox(message_id, response="received")`
- Process high priority tasks first

### Task Completion
- Call `report_completion(task, result, artifacts)` when a task is done
- Include output links (URLs, file paths) in artifacts
```

### 6.4 Heartbeat Mechanism

Through Claude Code hooks or CLAUDE.md rules, have child agents report periodically:
- After each significant step (file write, command execution, API call), call `report_status`
- During long waits (builds, API responses), report `status="working"` with explanation
- If idle for 5+ minutes, proactively report `status="idle"`

---

## 7. Hub Usage

### 7.1 Hub Workflow

```
Every 5-minute inspection cycle:

1. get_all_status()  -->  Get global status
   ├── Offline session found  -->  Alert (notify operator)
   ├── Blocked session found  -->  Analyze cause, attempt resolution
   ├── Idle session found     -->  Consider assigning new task
   └── Error session found    -->  Log error, attempt restart

2. get_completions(since=last_check)  -->  Get recent completions
   ├── Update task board
   ├── Important completion  -->  Notify operator
   └── Aggregate output stats

3. Based on operator commands:
   ├── send_task(session, task, priority)  -->  Dispatch task
   ├── broadcast(message)                  -->  Notify all
   └── get_session_status(session)         -->  View details
```

---

## 8. Why SSE Star (Not Polling or Mesh)

> This section explains the architectural decision made 2026-04-01.
> See also: [`architecture-decision.md`](architecture-decision.md)

### Previous Design (v0.2.0): Two Plans

v0.2.0 proposed a phased approach: Plan A (polling MVP) then Plan B (push). This is **superseded**.

### Current Design (v0.3.0): SSE Star

| Dimension | Old Plan A (Polling) | Old Plan B (Channel Push) | **v0.3.0 (SSE Star)** |
|-----------|---------------------|--------------------------|----------------------|
| **Latency** | 1-5 min | <1s | **<1s (SSE)** |
| **Token waste** | High (empty polls) | Low | **Zero (event-driven)** |
| **Client config** | CLAUDE.md + .mcp.json | Channel process + config | **One URL in settings.json** |
| **Cross-model** | Claude only | Claude only | **Claude + Codex** |
| **Deploy** | Central server | Central + local processes | **Central server only** |
| **Connections** | On-demand HTTP | Per-session SSE + stdio | **Per-session SSE** |

### Why Skip Polling

1. **Polling burns tokens**: Each empty `get_inbox()` call costs API tokens even when there's nothing new
2. **Polling adds latency**: 1-5 minute delay depending on poll interval
3. **SSE is native to MCP SDK**: `SSEServerTransport` is built-in, no extra code needed
4. **30 connections is trivial**: A single Bun process handles thousands of concurrent SSE connections

### Why Star, Not Mesh

- 30 sessions in a mesh = 870 connections. Star = 30 connections.
- Single source of truth for all session state
- One firewall rule per server (not per session pair)
- Commander as relay enables cross-model communication (Claude ↔ Codex)

---

## 9. Future: Channel Push Enhancement

> The current MCP SSE star architecture (v0.3.0) provides real-time communication via SSE Tool calls.
> A future enhancement could add Channel protocol push for even tighter integration.

### 9.1 Potential Channel Enhancement

If needed, a local `commander-channel` process could be added per session to inject messages directly into the Claude Code conversation via the Channel protocol (`notifications/claude/channel`). This would make Commander messages appear as `<channel>` tags, similar to Telegram/WeChat messages.

This is **not required for MVP** -- the SSE Tool interface already provides sub-second latency. Channel push would be an optimization for scenarios where agents need to be interrupted mid-task.

---

## 10. Development Plan

### Phase 1 -- MVP (1-2 days)
- [ ] Create `commander-mcp-server` repository
- [ ] Implement 4 child agent tools (report_status, report_completion, get_inbox, ack_inbox)
- [ ] Implement 5 hub tools (get_all_status, get_session_status, send_task, broadcast, get_completions)
- [ ] SQLite tables with WAL mode
- [ ] MCP SSE endpoint (`/sse`) + HTTP REST endpoints (`/api/status`, `/api/task`, `/health`)
- [ ] Deploy to your-server-ip:9200 via systemd
- [ ] End-to-end test: Claude Code session connects via SSE -> reports status -> Hub sends task -> Agent receives -> executes -> reports completion

### Phase 2 -- Full Rollout (2-3 days)
- [ ] All Claude Code sessions connect via `settings.json` URL config
- [ ] All Codex sessions connect via `config.json` URL config
- [ ] Cross-model test: Claude Code sends task -> Codex receives via Commander -> Codex reports completion
- [ ] All sessions' CLAUDE.md updated with Commander communication rules
- [ ] Firewall rules: only known server IPs allowed on port 9200
- [ ] Monitoring: offline session alerts (10-min heartbeat timeout)

### Phase 3 -- Enhanced (1 week)
- [ ] Web dashboard via HTTP REST interface
- [ ] Automatic task assignment based on session state
- [ ] Historical statistics (daily/weekly output reports)
- [ ] Token-based authentication (beyond IP whitelist)
- [ ] Message expiry cleanup (30-day retention)
- [ ] SSE reconnect handling with exponential backoff

### Phase 4 -- Advanced (Future)
- [ ] Task dependencies (Task A completion triggers Task B)
- [ ] Workflow orchestration (multi-session collaboration flows)
- [ ] Direct notification integration (Telegram/Slack/etc.)
- [ ] Multi-tenant support

---

## Appendix

### A. session_name Naming Convention

Use descriptive, lowercase names that identify the project or role:
- `hub` -- central orchestrator
- `project-a` -- specific project agent
- `reviewer` -- code review agent
- `video-gen` -- video generation agent

### B. server Identifier Convention

Use logical names instead of IP addresses:
- `central-server`
- `gpu-server-1`
- `local-mac`
- `cloud-worker`

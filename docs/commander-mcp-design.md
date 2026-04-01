# Commander MCP Server Design Document

> Version: v0.2.0 (Draft)
> A cross-server orchestration hub for AI Agent sessions using Model Context Protocol (MCP).

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
- All communication via HTTP + SSE, structured JSON, natively cross-server

**Core idea**: From "hub reads child agent screens" to "child agents proactively report to hub".

### 1.3 Two Plans

| | Plan A: MCP Tool + Polling | Plan B: MCP Channel + Push |
|---|---|---|
| **Mechanism** | Child agents periodically call MCP Tool to check inbox | Commander as Channel plugin, injects messages directly into conversation via `notifications/claude/channel` |
| **Latency** | Delayed (depends on polling frequency) | Real-time push, zero delay |
| **Dev effort** | Small (1-day MVP) | Large (each agent needs a local Channel process) |
| **Agent changes** | Modify CLAUDE.md + configure .mcp.json | Modify config + add Channel |
| **Recommended phase** | MVP, get it running first | Mature phase, for optimal experience |

---

## 2. Architecture (Plan A)

```
                         +--------------------------------------+
                         |       Commander MCP Server           |
                         |       <YOUR_SERVER_IP>:9200          |
                         |                                      |
                         |  +----------+  +------------------+  |
                         |  |  SQLite   |  |  MCP Transport   |  |
                         |  |          |  |  (HTTP + SSE)     |  |
                         |  | sessions |  |                    |  |
                         |  | inbox    |  |  /mcp  endpoint    |  |
                         |  | results  |  |                    |  |
                         |  +----------+  +------------------+  |
                         +-------+--------------+---------------+
                                 |              |
            +--------------------+              +--------------------+
            |                    |              |                    |
     +------v------+      +-----v------+ +-----v------+     +------v------+
     |  Hub Agent   |      | Agent 1    | | Agent 2    |     | Agent N    |
     |  (central)   |      | project-a  | | project-b  |     | project-n  |
     |              |      |            | |            |     |            |
     | get_all_     |      | report_    | | report_    |     | report_    |
     |   status()   |      |   status() | |   status() |     |   status() |
     | send_task()  |      | get_inbox()| | get_inbox()|     | get_inbox()|
     | broadcast()  |      | ack_inbox()| | ack_inbox()|     | ack_inbox()|
     +--------------+      +------------+ +------------+     +------------+
```

### Data Flow

```
+-----------------------------------------------------------+
|                    Task Dispatch Flow                       |
|                                                            |
|  Hub --send_task(session, task)-->  Commander --write inbox |
|                                                            |
|  Agent --get_inbox(session)-->  Commander --return pending  |
|                                                            |
|  Agent --ack_inbox(session, msg_id)--> Commander --mark read|
+-----------------------------------------------------------+

+-----------------------------------------------------------+
|                    Status Report Flow                       |
|                                                            |
|  Agent --report_status(session, status, task, ...)--> upsert|
|                                                            |
|  Hub --get_all_status()--> Commander --return all status    |
+-----------------------------------------------------------+

+-----------------------------------------------------------+
|                    Completion Flow                          |
|                                                            |
|  Agent --report_completion(session, task, result, ...)--> write|
|                                                            |
|  Hub --get_completions(since)--> Commander --return list    |
+-----------------------------------------------------------+
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
| Runtime | Bun 1.2+ | Consistent with existing projects |
| Language | TypeScript | Type safety |
| MCP SDK | `@modelcontextprotocol/sdk` | Official MCP SDK |
| HTTP | MCP SDK built-in SSE Transport | No extra framework needed |
| Database | SQLite (bun:sqlite) | Single file, zero config, Bun native support |
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
const db = new Database("~/.commander/commander.db");
initDB(db);

const server = new McpServer({
  name: "commander",
  version: "0.1.0",
});

registerAgentTools(server, db);
registerCommanderTools(server, db);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      await server.connect(transport);
      return transport.sseResponse;
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, sessions: getSessionCount(db) });
    }

    return new Response("Commander MCP Server", { status: 200 });
  },
});

console.log(`Commander MCP Server running on port ${PORT}`);
```

### 5.4 Firewall

Restrict port access to known agent server IPs only:
```bash
# Only allow known agent servers
iptables -A INPUT -p tcp --dport 9200 -s <AGENT_SERVER_1_IP> -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -s <AGENT_SERVER_2_IP> -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -j DROP
```

---

## 6. Child Agent Integration

### 6.1 Claude Code Configuration

Each child agent configures Commander MCP Server in `.mcp.json`:

```json
{
  "mcpServers": {
    "commander": {
      "type": "sse",
      "url": "http://<YOUR_SERVER_IP>:9200/sse"
    }
  }
}
```

### 6.2 Child Agent Usage Rules

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

### 6.3 Heartbeat Mechanism

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

## 8. Plan A vs Plan B Comparison

| Dimension | Plan A: MCP Tool + Polling | Plan B: MCP Channel + Push |
|-----------|--------------------------|---------------------------|
| **Latency** | 1-5 min (polling interval) | Real-time (<1s, SSE push) |
| **Agent changes** | Modify CLAUDE.md for polling rules | Add local Channel process |
| **Hub mode** | Timed polling (/loop) | Event-driven (wait for `<channel>` messages) |
| **Token consumption** | High -- polling even when nothing changed | Low -- only activated on events |
| **Deploy complexity** | Low -- only central service | Medium -- central service + per-session local process |
| **Dev effort** | ~1 day | ~3 days (on top of Plan A) |
| **Reliability** | High -- polling is simple and predictable | Medium -- SSE disconnect needs reconnect logic |
| **Agent awareness** | Passive -- agent must actively check inbox | Active -- messages appear directly in conversation |

### Migration Strategy

Progressive, Plan A first then Plan B:

1. **Phase 1 (Plan A MVP)**: Deploy Commander Tool Server, test with 1-2 sessions
2. **Phase 2 (Plan A full rollout)**: Migrate all sessions, hub switches to Tool polling
3. **Phase 3 (Plan A+)**: Web UI, auto-assignment, authentication
4. **Phase 4 (Plan B launch)**: Develop commander-channel, event-driven push
5. **Phase 5 (mature)**: Plan A as fallback, Plan B as primary channel

**Key principle**: Plan B doesn't replace Plan A, it layers on top. Tools remain the reliable fallback (e.g., during Commander restarts, SSE disconnects). Channel is the real-time push layer.

---

## 9. Plan B: MCP Channel Push

### 9.1 Core Idea

Plan B leverages Claude Code's **Channel protocol** (`notifications/claude/channel`) for true push-based communication:

- External event --> Channel process --> Injects into Claude Code conversation
- Claude Code sees a `<channel>` tag message, just like receiving a chat message
- Child agents **don't need polling**, no `/loop` -- commands appear directly in conversation

### 9.2 Channel Protocol

```typescript
// 1. Declare Channel capability
const server = new Server(
  { name: "commander-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: "...",
  },
);

// 2. Connect via stdio to Claude Code
await server.connect(new StdioServerTransport());

// 3. Push message into Claude Code conversation
await server.notification({
  method: "notifications/claude/channel",
  params: {
    content: "Hub dispatches task: generate monthly paper review",
    meta: {
      sender: "hub",
      sender_id: "commander",
    },
  },
});
```

Claude Code receives:
```
<channel source="commander-channel" sender="hub" sender_id="commander">
Hub dispatches task: generate monthly paper review
</channel>
```

The agent responds naturally. **No polling, no /loop, zero delay.**

### 9.3 commander-channel Implementation

Each session runs a local `commander-channel` process that:
1. **SSE subscribes** to Commander Server's `/events/:session_name`
2. **Channel injects** received events into Claude Code via `notifications/claude/channel`

```typescript
// commander-channel.ts -- Local Channel process per session

const COMMANDER_URL = process.env.COMMANDER_URL || "http://<YOUR_SERVER_IP>:9200";
const SESSION_NAME = process.env.COMMANDER_SESSION || "unknown";

// SSE subscription + auto-reconnect
async function subscribeToCommander() {
  while (true) {
    try {
      const res = await fetch(`${COMMANDER_URL}/events/${SESSION_NAME}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Parse SSE events and inject via Channel protocol
      }
    } catch (err) {
      // Reconnect after 5 seconds
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}
```

### 9.4 Configuration

```json
{
  "mcpServers": {
    "commander": {
      "type": "sse",
      "url": "http://<YOUR_SERVER_IP>:9200/sse"
    },
    "commander-channel": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/path/to/commander-channel.ts"],
      "env": {
        "COMMANDER_SESSION": "my-session-name"
      }
    }
  }
}
```

Both can coexist: Plan A (remote SSE for active Tool calls) + Plan B (local stdio for push notifications).

---

## 10. Development Plan

### Phase 1 -- MVP (1 day)
- [ ] Create `commander-mcp-server` repository
- [ ] Implement 4 child agent tools
- [ ] Implement 3 hub tools
- [ ] SQLite tables
- [ ] Deploy to central server
- [ ] End-to-end test: hub dispatches task -> agent receives -> executes -> reports completion -> hub receives

### Phase 2 -- Full Rollout (2-3 days)
- [ ] Implement remaining tools (get_session_status / broadcast)
- [ ] All sessions' CLAUDE.md updated with Commander rules
- [ ] Hub inspection loop uses Commander (replaces tmux capture-pane)
- [ ] Monitoring: offline session alerts

### Phase 3 -- Enhanced (1 week)
- [ ] Web UI dashboard for all session status
- [ ] Automatic task assignment based on session state
- [ ] Historical statistics (daily/weekly output reports)
- [ ] API key authentication
- [ ] Message expiry cleanup (30-day retention)

### Phase 4 -- Channel Push (Plan B)
- [ ] Develop commander-channel (local Channel process)
- [ ] Commander Server adds SSE event push
- [ ] Hub switches from polling to event-driven
- [ ] Verify bidirectional push

### Phase 5 -- Advanced (Future)
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

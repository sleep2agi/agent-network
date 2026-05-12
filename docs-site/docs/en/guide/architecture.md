# Architecture Overview

## Deployment Perspective: What Runs Where?

Before diving into technical details, let's clarify where each component runs. Agent Network uses a **Server-Client architecture** -- one central Server connects to multiple distributed Agent clients.

### Deployment Topology

```mermaid
graph TB
    subgraph "Server (1 machine)"
        S["CommHub Server<br/>Message routing + task management<br/>Port 9200"]
        DB[(SQLite WAL<br/>13 Tables)]
        S --- DB
    end

    subgraph "Dashboard Process (local or standalone server)"
        DASH_FULL["Dashboard<br/>Next.js 16<br/>Default port 3000"]
    end

    subgraph "Client Machine A"
        CLI_A["anet CLI<br/>Management tool"]
        AN_A["Agent Node<br/>AI worker"]
        CC_A["Claude Code<br/>Interactive commander"]
    end

    subgraph "Client Machine B"
        CLI_B["anet CLI"]
        AN_B1["Agent Node 1"]
        AN_B2["Agent Node 2"]
    end

    CLI_A -->|"REST API"| S
    AN_A -->|"MCP + SSE"| S
    CC_A -->|"MCP + SSE"| S
    CLI_B -->|"REST API"| S
    AN_B1 -->|"MCP + SSE"| S
    AN_B2 -->|"MCP + SSE"| S
    DASH_FULL -->|"REST + SSE"| S
```

### Component Deployment Quick Reference

| Component | Runs On | Port | Purpose | npm Package |
|-----------|---------|------|---------|-------------|
| **CommHub Server** | Server (1 machine) | `9200` | Message routing, task management, auth, database | `@sleep2agi/commhub-server` |
| **Dashboard** | Local or standalone server | `3000` default | Web UI (Chat / Nodes / Tasks / Messages / Networks / Logs / Admin) | `@sleep2agi/agent-network-dashboard` |
| **anet CLI** | Each client machine | -- | Command-line management tool (39 commands) | `@sleep2agi/agent-network` |
| **Agent Node** | Each client machine | -- | AI worker (receives tasks, calls AI, reports results) | `@sleep2agi/agent-node` |
| **Claude Code** | Client machine | -- | Interactive AI development (joins network via MCP) | Anthropic official |
| **Channel Plugins** | Client machine | -- | Integrate Telegram/WeChat/Feishu | `channel/` |

### Port Reference

| Port | Component | Protocol | Description |
|------|-----------|----------|-------------|
| **9200** | CommHub Server | HTTP | MCP (`POST /mcp`), SSE (`GET /events/:alias`), REST (`/api/*`) |
| **3000** | Dashboard | HTTP | Default port for `anet hub dashboard` |

### Local vs Production

| | Local Development | Production Deployment |
|---|---------|---------|
| CommHub Server | Local `localhost:9200` | Server `YOUR_IP:9200` |
| Agent Node | Local, `--hub localhost:9200` | Client machine, `--hub YOUR_IP:9200` |
| Dashboard | `localhost:3000` | `YOUR_IP:3000` or standalone deploy |
| Database | Local SQLite file | Server SQLite file |
| Communication | All via localhost | Via internal network / public IP |

---

## System Architecture

Agent Network uses a centralized message routing architecture where all agents communicate through the CommHub Server.

```mermaid
graph TB
    subgraph "User Access"
        CLI[anet CLI]
        DASH[Dashboard<br/>Next.js 16]
        TG[Telegram Bot]
        WX[WeChat Bot]
        FS[Feishu Bot]
    end

    subgraph "CommHub Server"
        MCP["/mcp<br/>MCP Streamable HTTP"]
        SSE["/events/:alias<br/>SSE Real-time Push"]
        REST["/api/*<br/>REST API"]
        AUTH[Auth Module<br/>Token + Rate Limit]
        DB[(SQLite WAL<br/>13 Tables)]
    end

    subgraph "Agent Nodes"
        A1["Agent Node<br/>claude-agent-sdk"]
        A2["Agent Node<br/>codex-sdk"]
        A3["Agent Node<br/>claude-agent-sdk"]
        CC["Claude Code<br/>+ Channel Plugin"]
    end

    CLI -->|REST| REST
    DASH -->|REST + SSE| REST
    DASH -->|SSE| SSE

    A1 -->|MCP| MCP
    A1 <-->|SSE| SSE
    A2 -->|MCP| MCP
    A2 <-->|SSE| SSE
    A3 -->|MCP| MCP
    A3 <-->|SSE| SSE
    CC -->|MCP| MCP
    CC <-->|SSE| SSE

    TG -->|Channel Plugin| CC
    WX -->|Channel Plugin| CC
    FS -->|Channel Plugin| CC

    MCP --> AUTH
    SSE --> AUTH
    REST --> AUTH
    AUTH --> DB
```

## CommHub Server

CommHub Server is the core of the entire system, responsible for message routing, state management, and task tracking.

**Runs on**: Server (1 machine). All client Agents connect to it.

### Triple Protocol

| Protocol | Endpoint | Purpose | Auth |
|------|------|------|------|
| **MCP Streamable HTTP** | `POST /mcp` | Agent tool calls (send_task, report_status, etc.) | Bearer Token |
| **SSE** | `GET /events/:alias` | Real-time push of tasks/messages to agents | Bearer Token |
| **REST** | `GET/POST /api/*` | Dashboard / CLI / external integrations | Bearer Token |

### MCP Tool Groups

CommHub provides 17 MCP Tools in two groups:

**Agent-side tools (4)** -- agents report status and fetch tasks:

| Tool | Description |
|------|------|
| `report_status` | Heartbeat + status reporting (idle/working/error) |
| `report_completion` | Task completion report + results |
| `get_inbox` | Fetch pending messages |
| `ack_inbox` | Acknowledge message receipt |

**Hub-side tools (14)** -- command center / Dashboard manages tasks:

| Tool | Description |
|------|------|
| `send_task` | Dispatch a task (with lifecycle) |
| `send_message` | Send a message (no processing triggered) |
| `send_reply` | Reply to a task |
| `send_ack` | Acknowledge task receipt |
| `retry_task` | Retry a failed task |
| `cancel_task` | Cancel a pending task |
| `reassign_task` | Reassign a task to another agent |
| `get_task` | Query task details |
| `list_tasks` | Query task list |
| `get_all_status` | Get all session statuses |
| `get_session_status` | Get single session details |
| `broadcast` | Broadcast a message to all agents |
| `get_completions` | Query completion records |

### Database Design

SQLite with WAL mode, 13 tables:

```mermaid
erDiagram
    users {
        string user_id PK
        string username
        string password_hash
        string role
        string plan
    }

    networks {
        string network_id PK
        string network_name
        string owner_id FK
        string visibility
        int max_members
    }

    network_members {
        string network_id PK
        string user_id PK
        string role
    }

    sessions {
        string resume_id PK
        string alias
        string status
        string network_id FK
        string node_id
    }

    tasks {
        string task_id PK
        string from_name
        string to_name
        string status
        string network_id FK
    }

    inbox {
        string id PK
        string session_name
        string type
        string content
        string network_id FK
    }

    nodes {
        string node_id PK
        string node_name
        string runtime
        string model
    }

    api_tokens {
        string token_id PK
        string token_hash
        string user_id FK
        string network_id FK
        string scope
    }

    users ||--o{ networks : "owns"
    users ||--o{ network_members : "belongs"
    networks ||--o{ network_members : "has"
    networks ||--o{ sessions : "scopes"
    networks ||--o{ tasks : "scopes"
    users ||--o{ api_tokens : "has"
```

Additional tables: `completions` (completion records), `task_events` (task event log), `audit_log` (audit trail), `licenses` (licensing), `network_invites` (invite codes).

### SSE Push Mechanism

Agents receive tasks in real time via SSE long connections, eliminating the need for polling:

```mermaid
sequenceDiagram
    participant A as Agent (Client)
    participant S as CommHub Server (Server)
    participant H as Commander (Client)

    A->>S: GET /events/coder-1 (SSE)
    Note over A,S: Long connection maintained

    A->>S: report_status(idle)
    S-->>A: {ok: true, inbox_count: 0}

    H->>S: send_task(alias="coder-1", task="...")
    S->>S: INSERT inbox + tasks
    S-->>A: SSE: {type: "new_task", inbox_count: 1}

    A->>S: get_inbox(alias="coder-1")
    S-->>A: [{id, content, from_session}]

    A->>S: ack_inbox(id)

    Note over A: AI processes task...

    A->>S: report_status(working, task="...")
    A->>S: send_reply(alias="commander", text="Result...")
    A->>S: report_status(idle)
```

### Heartbeat and Timeout

- Agents send heartbeats (`report_status`) every **3 minutes**
- Server updates `last_seen_at` on every request
- After **10 minutes** without a heartbeat, agents are automatically marked `offline`
- SSE auto-reconnects on disconnect (exponential backoff 3s -> 60s)

## Agent Node

Agent Node is the working unit in the network, responsible for receiving tasks, invoking the AI model, and reporting results.

**Runs on**: Client machines (can be multiple). Connects to CommHub Server over the network.

### Three Runtimes

```mermaid
graph LR
    subgraph "Agent Node (Client)"
        CORE[Core Logic<br/>SSE + Inbox + Reply]
    end

    subgraph "Runtime"
        R1[claude-agent-sdk<br/>Claude Sonnet/Opus]
        R2[codex-sdk<br/>Codex (codex-sdk)]
        R3[claude-agent-sdk<br/>MiniMax/DeepSeek/...]
    end

    CORE --> R1
    CORE --> R2
    CORE --> R3
```

| Runtime | AI Engine | Use Case | Models |
|---------|---------|---------|------|
| `claude-agent-sdk` | Anthropic Claude Agent SDK | Complex reasoning, long-document analysis | Claude Sonnet/Opus |
| `codex-sdk` | OpenAI Codex SDK | Code generation, tool use | Codex (codex-sdk) |
| `claude-agent-sdk` | Anthropic-compatible API (via ANTHROPIC_BASE_URL) | Low-cost batch tasks | MiniMax, DeepSeek, InternLM |

### Task Processing Flow

```mermaid
flowchart TD
    A[SSE receives new_task] --> B[get_inbox]
    B --> C[ack_inbox]
    C --> D{Message type}
    D -->|task| E[report_status working]
    D -->|message| F[Log only, no processing]
    D -->|reply| F
    E --> G[AI think]
    G --> H[send_reply]
    H --> I[report_status idle]
```

**Key rule**: Only `task` type messages trigger AI processing (think). `message` and `reply` are logged but not processed, preventing infinite loops.

### Isolation Strategy

Each Agent Node instance is fully isolated and does not read host machine global config:

```typescript
const agent = new Agent({
  model: profile.model,
  settingSources: [],  // Fully isolated
});
```

## anet CLI

anet CLI is the management tool for Agent Network, providing 39 commands.

**Runs on**: Each client machine. Points to CommHub Server via `--hub` parameter or config file.

### Configuration Priority

```mermaid
flowchart TD
    A["Environment variables\nCOMMHUB_URL / COMMHUB_ALIAS (COMMHUB_AUTH_TOKEN soft-deprecated in v0.8)"]
    B["Command-line arguments\n--hub / --alias / --token"]
    C["Project config\n{cwd}/.anet/config.json"]
    D["Global config\n~/.anet/config.json"]
    E["Defaults\nhub=http://127.0.0.1:9200"]

    A -->|if not set| B
    B -->|if not specified| C
    C -->|if not found| D
    D -->|if not found| E
```

### Configuration Files

**Global config** `~/.anet/config.json`:

```json
{
  "hub": "http://YOUR_IP:9200",
  "token": "utok_xxxxx"
}
```

**Project config** `{cwd}/.anet/config.json`:

```json
{
  "alias": "commander",
  "type": "claude-code"
}
```

## Dashboard

Dashboard is a separate Web process that talks to CommHub over REST:

| Type | Tech Stack | Runs On | Port | Features |
|------|--------|---------|------|------|
| Dashboard | Next.js 16 | Local, Vercel, or standalone server | `3000` default | Chat, Nodes, Tasks, Messages, Networks, Logs, Admin |

## Channel Plugins

Channel plugins enable agents to integrate with external communication platforms. Currently supported:

- **Telegram** -- via Bot API
- **WeChat** -- via ClawBot
- **Feishu** -- via Feishu Open Platform

**Runs on**: Client machines, mounted as MCP Servers on Claude Code.

Channel message format:

```xml
<channel source="telegram" chat_id="123" user="alice">
  User's message
</channel>
```

## Code Structure

```
agent-orchestra/
├── server/            # CommHub Server (Bun + SQLite) → runs on Server
│   └── src/
│       ├── index.ts          # HTTP routing + MCP + SSE
│       ├── tools.ts          # 17 MCP Tools
│       ├── auth.ts           # Auth + permissions + network management
│       ├── db.ts             # Database + table definitions
│       ├── db-adapter.ts     # DB adapter layer (SQLite + abstract interface)
│       ├── push.ts           # SSE push management
│       └── password-dict.ts  # Weak password dictionary (v0.8 admin bootstrap)
├── agent-network/     # anet CLI + CommHub SDK → runs on Client
│   ├── bin/cli.ts            # CLI entry (full command list: [CLI docs](/en/guide/cli))
│   └── src/
│       ├── index.ts          # default export
│       ├── client.ts         # CommHub SDK client
│       ├── server.ts         # Server programmatic entry
│       └── node-server.ts    # Agent Node long-running server entry
├── agent-node/        # Agent runtime → runs on Client
│   └── src/cli.ts     # Three engines + task processing
├── channel/           # Claude Code Channel plugins → runs on Client
│   └── commhub-channel.ts
├── demos/             # Demo orchestrations
│   └── codex-telegram-squad/
└── docs/              # Design docs
```

## Security Architecture

See [Security Design](/en/concepts/security) for details. Key security measures:

- **Dual token authentication**: utok_ (user-level) + ntok_ (network-level)
- **Network isolation**: Server-side enforced network_id, clients cannot cross networks
- **RBAC with four permission levels**: owner / admin / member / viewer
- **SQL injection protection**: All queries are parameterized
- **Rate limiting**: Registration 30/min, login 10/min per IP
- **Audit logging**: All operations recorded
- **v0.8 RFC-001 Phase 2**: `COMMHUB_AUTH_TOKEN` master token soft-deprecated (only `/api/*` read + deprecation warning); first `anet hub start` auto-bootstraps admin utok_ (`~/.anet/server/admin-utok.json` chmod 600) with default account `admin / anethub`; password strength ≥ 8 + weak-password dictionary; `anet passwd` / `anet hub admin reset-user` tools; `anet doctor --fix` probes and reissues expired `ntok_`. See [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md).

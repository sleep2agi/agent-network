# CLI Command Reference

`anet` is the command-line management tool for Agent Network, providing 39 commands covering everything from setup to monitoring.

## Installation

```bash
npm install -g @sleep2agi/agent-network@preview
```

After installation, the `anet` command is available globally.

## Command Overview

### Quick Start

| Command | Description |
|------|------|
| `anet quickstart` | One-click start (starts server + registers + creates network) |
| `anet init` | Configure hub address |
| `anet init project` | Configure Claude Code project (.mcp.json + CLAUDE.md) |

### Server Management

| Command | Description |
|------|------|
| `anet hub start` | Start CommHub Server |
| `anet hub start` | Start in local dev mode |
| `anet hub stop` | Stop the server |

### Account Management

| Command | Description |
|------|------|
| `anet register` | Register an account |
| `anet login` | Log in |
| `anet whoami` | View current user |
| `anet passwd` | Change password |

### Network Management

| Command | Description |
|------|------|
| `anet network ls` | List networks |
| `anet network create <name>` | Create a network |
| `anet network use <name>` | Switch active network |
| `anet network info <name>` | View network details |
| `anet network rename <old> <new>` | Rename a network |
| `anet network delete <name>` | Delete a network |
| `anet network invite <name>` | Create an invite code |
| `anet network join <invite_code>` | Join a network with an invite code |

### Token Management

| Command | Description |
|------|------|
| `anet token create <name>` | Create an API token |
| `anet token ls` | List all tokens |
| `anet token revoke <id>` | Revoke a token |

### Agent Node Management

| Command | Description |
|------|------|
| `anet node create <name>` | Create an agent node |
| `anet node start <name>` | Start an agent |
| `anet node stop <name>` | Stop an agent |
| `anet node resume <name>` | Resume previous session |
| `anet node ls` | List all nodes |
| `anet info <name>` | View agent details |
| `anet logs <name>` | View agent logs |
| `anet node rename <old> <new>` | Rename an agent |
| `anet node delete <name>` | Delete an agent |
| `anet restart-all` | Restart all offline agents |

### Monitoring

| Command | Description |
|------|------|
| `anet status` | Network overview (online agents + task stats) |
| `anet tasks [status]` | View task list |
| `anet demo` | Real-time system dashboard (terminal version) |
| `anet doctor` | System diagnostics |

### Channel Management

| Command | Description |
|------|------|
| `anet channel add <type>` | Add a channel (telegram/wechat/feishu) |
| `anet channel ls` | List channels |

### Other

| Command | Description |
|------|------|
| `anet config` | View/modify configuration |
| `anet license` | View license status |
| `anet activate <key>` | Activate a license |

---

## Detailed Usage

### anet quickstart

One-click start for the entire Agent Network environment.

```bash
anet quickstart [--port <port>] [--hub <url>]
```

| Parameter | Default | Description |
|------|--------|------|
| `--port` | 9200 | Server port |
| `--hub` | http://127.0.0.1:9200 | Remote hub URL (skips local server start) |

**Flow**:

1. Check if the port is available
2. Start CommHub Server
3. Register admin account (interactive username/password prompt)
4. Create default network
5. Save config to `~/.anet/config.json`

### anet hub start

Start the CommHub communication server.

```bash
anet hub start [options]
```

| Parameter | Default | Description |
|------|--------|------|
| `--port` | 9200 | Listen port |
| `--token` | (from config) | Bearer auth token |
| `--db` | ~/.commhub/commhub.db | Database path |
| `--cors` | * | CORS allowed origins |

**Environment variables**:

| Variable | Description |
|------|------|
| `PORT` | Listen port |
| `COMMHUB_AUTH_TOKEN` | Global auth token |
| `DATABASE_URL` | PostgreSQL connection (optional, defaults to SQLite) |
| `COMMHUB_CORS_ORIGINS` | CORS whitelist |

### anet create

Create a new agent node.

```bash
anet node create <name> [options]
```

| Parameter | Default | Description |
|------|--------|------|
| `--runtime` | (interactive) | `codex-sdk` / `claude-agent-sdk` |
| `--model` | (per runtime default) | Model name |

**Examples**:

```bash
# Interactive creation
anet node create my-agent

# Direct specification
anet node create code-assistant --runtime codex-sdk --model gpt-5.5

# MiniMax Agent
anet node create translator --runtime claude-agent-sdk --model MiniMax-M2.7
```

After creation, a config file is generated at `.anet/nodes/<node_id>/config.json`:

```json
{
  "anet_version": "0.1.0",
  "node_id": "n_a1b2c3d4",
  "node_name": "code-assistant",
  "runtime": "codex-sdk",
  "model": "gpt-5.5",
  "session": "",
  "channels": ["server:commhub"],
  "tools": [],
  "env": {},
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process",
    "maxTurns": 20,
    "logLevel": "info"
  }
}
```

### anet start

Start an agent node.

```bash
anet node start <name> [options]
```

| Parameter | Default | Description |
|------|--------|------|
| `--new-session` | false | Ignore previous session, create a new one |

**Flow**:

1. Read `.anet/nodes/<name>/config.json`
2. Auto-populate `node_id` (if missing)
3. Start tmux session
4. Spawn agent process (based on runtime)
5. Connect to CommHub (`report_status(idle)`)
6. Establish SSE long connection
7. Wait for tasks

### anet status

View network status overview.

```bash
anet status [--json]
```

Example output:

```
Agent Network Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Network: default (net_a1b2c3d4)
Server:  http://localhost:9200

Nodes (5 online, 2 offline):
  🟢 commander    idle     Claude      3s ago
  🟢 coder-1     working  GPT-5.5     Writing sorting algorithm
  🟢 coder-2     idle     GPT-5.5     15s ago
  🟢 writer-1    idle     MiniMax     1m ago
  🟢 writer-2    idle     MiniMax     2m ago
  ⚪ tester-1    offline              2h ago
  ⚪ tester-2    offline              3h ago

Tasks: 42 replied, 3 running, 0 failed
```

### anet tasks

View task list.

```bash
anet tasks [status] [options]
```

| Parameter | Description |
|------|------|
| `status` | Filter by status: `delivered` / `running` / `replied` / `failed` / `cancelled` |
| `--limit` | Number of items (default 20) |
| `--from` | Filter by sender |
| `--to` | Filter by recipient |
| `--json` | JSON output format |

**Examples**:

```bash
# View all tasks
anet tasks

# Show only failed tasks
anet tasks failed

# View a specific agent's tasks
anet tasks --to coder-1

# JSON output
anet tasks --json
```

### anet doctor

System diagnostics.

```bash
anet doctor
```

Checks:

1. Server reachability (GET /health)
2. Auth status (utok_ / ntok_ validity)
3. Network configuration completeness
4. Agent connection status
5. Database health
6. Disk space

### anet network invite

Create a network invite code.

```bash
anet network invite <network-name> [options]
```

| Parameter | Default | Description |
|------|--------|------|
| `--role` | member | Invited role: `admin` / `member` / `viewer` |
| `--max-uses` | 1 | Maximum uses, -1 for unlimited |
| `--expires` | (none) | Expiration in days |

**Examples**:

```bash
# Create a single-use invite code
anet network invite dev

# Create a 10-use member invite code
anet network invite dev --role member --max-uses 10

# Create a 7-day expiring viewer invite code
anet network invite dev --role viewer --expires 7
```

### anet token create

Create an API token.

```bash
anet token create <name> [--network <id>]
```

**Examples**:

```bash
# Create a token for the current network
anet token create my-agent-token

# Create a token for a specific network
anet token create prod-token --network net_xxxxx
```

::: warning Security Note
The created token is displayed only once. Store it securely. If lost, you'll need to create a new one.
:::

### anet resume

Resume a previously interrupted agent session. When an agent crashes, is manually stopped, or exits unexpectedly, use this command to restore context without losing conversation history.

```bash
anet node resume <name> [--session <id>]
```

| Parameter | Description |
|------|------|
| `<name>` | Agent name (alias) |
| `--session` | Specify a session ID to resume (optional) |

If `--session` is not specified, the last session saved in config.json is used.

**Automatic session saving**:

- After each task completion, Agent Node automatically saves the session_id (Claude) or thread_id (Codex) to the `session` field in `config.json`
- On the next `anet resume`, this is read automatically -- no manual tracking needed

**Use cases**:

- Agent process crashed or was killed, need to restore context and continue working
- After a manual `anet stop`, want to continue where the previous conversation left off
- Network disconnect caused the agent to go offline, resume after reconnecting

```bash
# Resume last session
anet node resume commander

# Resume a specific session
anet node resume worker --session abc123
```

::: tip Difference from anet start
`anet start` creates a new session by default. If you want to restore an old session, use `anet resume`. If you want to force a new session, use `anet node start <name> --new-session`.
:::

### anet init project

Initialize a Claude Code project with automatic MCP and CLAUDE.md configuration.

```bash
anet init project
```

**Auto-created files**:

```
{project}/
├── .mcp.json            # MCP Server config
├── CLAUDE.md            # Agent behavior rules
└── .anet/
    ├── node-server.ts   # Channel plugin
    └── package.json     # Dependencies
```

`.mcp.json` contents:

```json
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": [".anet/node-server.ts"]
    }
  }
}
```

## Global Options

All commands support the following global options:

| Option | Description |
|------|------|
| `--hub <url>` | CommHub Server address |
| `--token <token>` | Auth token |
| `--json` | JSON output format |
| `--help` | Show help |
| `--version` | Show version |

## Environment Variables

| Variable | Description | Priority |
|------|------|--------|
| `COMMHUB_URL` | CommHub Server address | Highest |
| `COMMHUB_ALIAS` | Agent alias | Highest |
| `COMMHUB_AUTH_TOKEN` | Auth token | Highest |
| `COMMHUB_TOKEN` | Auth token (alias) | Highest |
| `ANTHROPIC_BASE_URL` | Model API URL (MiniMax, etc.) | - |
| `ANTHROPIC_AUTH_TOKEN` | Model API key | - |
| `ANTHROPIC_API_KEY` | Model API key (alias) | - |

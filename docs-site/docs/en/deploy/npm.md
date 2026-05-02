# npm Deployment

Installing and deploying Agent Network via npm is the simplest approach.

## Package Overview

| Package | CLI Command | Purpose | Size |
|------|---------|------|------|
| `@sleep2agi/agent-network` | `anet` | CLI management + CommHub SDK | ~580KB |
| `@sleep2agi/agent-node` | `agent-node` | Agent runtime | - |
| `@sleep2agi/commhub-server` | - | Communication server (programmatic entry) | - |

## Installation Methods

### Global Install (Recommended)

```bash
# Install CLI
npm install -g @sleep2agi/agent-network@preview

# Verify
anet --version
anet --help
```

### npx (No Install)

```bash
# Run CLI commands directly
npx @sleep2agi/agent-network hub start
```

### Project Dependency

```bash
# Install as project dependency
npm install @sleep2agi/agent-network

# Use the SDK in code
```

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({
  url: 'http://YOUR_IP:9200',
  alias: 'my-agent',
  token: 'ntok_xxx',
});

hub.on('task', async (msg) => {
  console.log('Received task:', msg.content);
  await hub.reply(msg.id, 'Processing complete');
});

await hub.connect();
```

## Package Structure

### @sleep2agi/agent-network

```
dist/
├── bin/cli.js       # CLI entry (minified, ~580KB includes MCP SDK bundle)
├── src/client.js    # CommHub SDK client (minified, ~4.4KB)
└── client.d.ts      # TypeScript type declarations
src/
└── server.ts        # Server programmatic entry (Bun-only, kept as .ts source)
package.json
README.md
```

**Key package.json fields**:

```json
{
  "name": "@sleep2agi/agent-network",
  "bin": { "anet": "dist/bin/cli.js" },
  "main": "dist/src/client.js",
  "types": "dist/client.d.ts",
  "exports": {
    ".": { "import": "./dist/src/client.js", "types": "./dist/client.d.ts" },
    "./server": { "import": "./src/server.ts" }
  }
}
```

### @sleep2agi/agent-node

Agent runtime supporting multiple engines. Specify the runtime when creating a node with `anet node create`:

```bash
# Claude Agent SDK
anet node create my-agent --runtime claude-agent-sdk

# OpenAI Codex SDK
anet node create my-agent --runtime codex-sdk

# Start the node
anet node start my-agent
```

> You can also run directly via `npx @sleep2agi/agent-node`. See [Agent Node Reference](/en/guide/agent-node) for details.

### @sleep2agi/commhub-server

CommHub Server can be started programmatically:

```typescript
import { startServer } from '@sleep2agi/agent-network/server';

await startServer({
  port: 9200,
  token: 'secret',
  db: '~/.commhub/commhub.db',
  corsOrigins: ['http://localhost:3000'],
});
```

Or run directly via bunx:

```bash
bunx @sleep2agi/commhub-server
```

## Deployment Scenarios

### Scenario 1: Personal Development

Single machine, everything local.

```bash
# 1. Install
npm install -g @sleep2agi/agent-network@preview

# 2. Start Server
anet hub start

# 3. Create and start Agent
anet node create assistant --runtime codex-sdk
anet node start assistant
```

### Scenario 2: Team Collaboration

Server deployed on a cloud instance, team members each start their own agents.

```bash
# --- Server side ---
npm install -g @sleep2agi/agent-network@preview

# Start Server (background)
nohup anet hub start --port 9200 --token team-secret &

# --- Client side ---
npm install -g @sleep2agi/agent-network@preview

# Initialize
anet init --hub http://TEAM_SERVER:9200

# Register/Login
anet register
anet login

# Create and start Agent
anet node create my-agent --runtime codex-sdk
anet node start my-agent
```

### Scenario 3: Automation Scripts

For use in CI/CD or scripts.

```bash
#!/bin/bash

# Install
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview

# Configure
export COMMHUB_URL=http://server:9200
export COMMHUB_TOKEN=ntok_xxx

# Create and start Agent (background)
anet node create "CI-Agent" --runtime codex-sdk --tools Read,Bash,Grep
anet node start "CI-Agent" &

AGENT_PID=$!

# Wait for tasks to complete...
sleep 300

# Cleanup
kill $AGENT_PID
```

## SDK Programming Interface

### CommHub Class

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({
  url: string;          // CommHub Server URL (required)
  alias: string;        // Session alias (required)
  token?: string;       // Auth token
  agent?: string;       // Agent type identifier (default "sdk")
  heartbeatInterval?: number;  // Heartbeat interval ms (default 180000)
  reconnectDelay?: number;     // Reconnection base delay ms (default 3000)
  autoConnect?: boolean;       // Auto-connect (default true)
});
```

### Methods

| Method | Returns | Description |
|------|--------|------|
| `connect()` | Promise | Connect + register + SSE + heartbeat |
| `disconnect()` | Promise | Disconnect + report offline |
| `send(alias, content, priority?)` | Promise | Send task |
| `message(alias, content)` | Promise | Send message |
| `reply(taskId, text, status?)` | Promise | Reply to task |
| `status(state, extra?)` | Promise | Update status |
| `getAllStatus()` | Promise | Get all session statuses |
| `broadcast(content, filter?)` | Promise | Broadcast |

### Events

| Event | Parameters | Description |
|------|------|------|
| `task` | InboxMessage | Task received |
| `message` | InboxMessage | Same as task (alias) |
| `connected` | - | SSE connection established |
| `disconnected` | - | SSE disconnected |
| `error` | Error | Error occurred |

### Example: Custom Agent

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({
  url: 'http://localhost:9200',
  alias: 'translator',
  token: 'ntok_xxx',
});

hub.on('task', async (msg) => {
  console.log(`Received task: ${msg.content}`);

  // Custom processing logic
  const result = await translateText(msg.content);

  // Reply with result
  await hub.reply(msg.id, result);
});

hub.on('connected', () => {
  console.log('Connected to CommHub');
});

hub.on('error', (err) => {
  console.error('Error:', err);
});

await hub.connect();
```

## Upgrading

```bash
# Upgrade CLI
npm update -g @sleep2agi/agent-network

# Check current version
anet --version

# Check available versions
npm view @sleep2agi/agent-network versions
```

::: warning Preview Version
Currently using the `@preview` tag. Once officially released, remove `@preview`.
:::

## System Requirements

| Component | Minimum |
|------|---------|
| Node.js | >= 20 |
| Bun | >= 1.0 (required for Server) |
| Memory | 256MB (Server) + 128MB per Agent |
| Disk | 100MB + database growth |
| Network | Connection to CommHub Server required |

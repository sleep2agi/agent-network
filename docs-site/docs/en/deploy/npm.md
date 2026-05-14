# npm Deployment

Installing and deploying Agent Network via npm is the simplest approach.

## Package Overview

| Package | CLI command | Purpose | Notes |
|------|---------|------|------|
| `@sleep2agi/agent-network` | `anet` | CLI management + Client SDK | `dist/` ships `bin/cli.js` + `src/client.js` + `src/node-server.js` (3 entries, minified + obfuscator; for exact byte size, see the [npm package page](https://www.npmjs.com/package/@sleep2agi/agent-network)) |
| `@sleep2agi/agent-node` | `agent-node` | Agent runtime (3 runtimes: claude-agent-sdk / codex-sdk / claude-code-cli) | `@anthropic-ai/claude-agent-sdk` regular dep; `@openai/codex-sdk` optional peerDep (R212 chain) |
| `@sleep2agi/commhub-server` | `commhub-server` | CommHub backend (Bun required; pulled in by `anet hub start` via bunx at a pinned version) | Bun-only runtime (`engines.bun: ">=1.2.0"`) |
| `@sleep2agi/agent-network-dashboard` | - | Next.js web UI | `anet hub dashboard` pulls it via npx (version comes from `dashboardReleaseTag()`: defaults to the `@preview` tag, overridable via the `ANET_DASHBOARD_VERSION` env var — not a hardcoded pin, see [dashboard.md](/en/guide/dashboard)); can also be deployed standalone |

## Installation Methods

### Global Install (Recommended)

```bash
# Install CLI
npm install -g @sleep2agi/agent-network

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
├── bin/cli.js              # CLI entry (minified + javascript-obfuscator with base64 string-array)
├── src/client.js           # Client SDK (minified + obfuscator)
├── src/node-server.js      # Channel plugin (minified + obfuscator; auto-copied to project's .anet/node-server.js — R216/R221/R240 chain)
└── client.d.ts             # TypeScript type declarations
package.json
README.md
```

**Key package.json fields** (verified at [agent-network/package.json](https://github.com/sleep2agi/agent-network/blob/main/agent-network/package.json); aligned with the R223 chain):

```json
{
  "name": "@sleep2agi/agent-network",
  "type": "module",
  "main": "dist/src/client.js",
  "types": "dist/client.d.ts",
  "exports": {
    ".": { "import": "./dist/src/client.js", "types": "./dist/client.d.ts" }
  },
  "bin": { "anet": "dist/bin/cli.js" },
  "files": ["dist"],
  "engines": { "bun": ">=1.2.0", "node": ">=22.13.0" },
  "dependencies": { "@inquirer/prompts": "^8.4.3" }
}
```

::: warning Do not assume the server is in dist
Older docs listed `src/server.ts` in `files` — that's **not present** in the current package. `commhub-server` is pulled via `anet hub start` from the separate `@sleep2agi/commhub-server` npm package at a pinned version; it does **not** ship inside `@sleep2agi/agent-network`'s dist. Aligned with the R221/R223 chain.
:::

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

CommHub Server runs from its standalone package:

```bash
bunx @sleep2agi/commhub-server
```

## Deployment Scenarios

### Scenario 1: Personal Development

Single machine, everything local.

```bash
# 1. Install
npm install -g @sleep2agi/agent-network

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
npm install -g @sleep2agi/agent-network

# Start Server (background; put reverse-proxy TLS in front for public access)
nohup anet hub start --host 0.0.0.0 --port 9200 &

# Immediately rotate the quick-start default password after first start
anet login --hub http://127.0.0.1:9200 --username admin --password anethub
anet passwd

# --- Client side ---
npm install -g @sleep2agi/agent-network

# Initialize
anet init --hub http://TEAM_SERVER:9200

# Register/Login (each team member uses their own account)
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
npm install -g @sleep2agi/agent-network @sleep2agi/agent-node

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
| `task` | InboxMessage | Task received — the SDK has already called `ack_inbox` ([`client.ts:265`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/src/client.ts#L265) ACKs before emitting), so you do **not** need to ack manually in the handler |
| `message` | InboxMessage | Same as task (alias) — every inbox message emits both `task` and `message` |
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
  autoConnect: false,   // register event handlers first, then connect — avoids missing tasks that arrive before handlers are attached
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

// handlers are all registered — now connect
await hub.connect();
```

::: tip `autoConnect` defaults to `true`
Without `autoConnect: false`, `new CommHub({...})` calls `connect()` right away in the constructor — before `hub.on(...)` has run, so any task event that arrives first is lost. Prefer `autoConnect: false` + a manual `await hub.connect()` after the handlers are registered. `connect()` is itself idempotent (`if (this.running) return`), so calling it twice is harmless.
:::

## Upgrading

```bash
# Upgrade CLI
npm install -g @sleep2agi/agent-network

# Check current version
anet --version

# Check available versions
npm view @sleep2agi/agent-network versions
```

::: tip Stable vs. Preview
`npm install -g @sleep2agi/agent-network` follows the [npm `latest` tag](https://www.npmjs.com/package/@sleep2agi/agent-network). Versions bump with every release, so this doc **does not hard-pin them** to avoid drift — check the npm package page's `dist-tags` for the current stable / preview.

To track the preview channel (trial of unstable features), pass `@preview` explicitly:
```bash
npm install -g @sleep2agi/agent-network@preview
```
:::

## System Requirements

| Component | Minimum | How to verify |
|------|---------|------|
| Node.js | ≥ 22.13.0 | `node --version`; verified at [`agent-network/package.json engines.node`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/package.json) `">=22.13.0"` (lower versions trigger an `EBADENGINE` warning on `npm install`) |
| Bun | ≥ 1.2.0 (required by commhub-server) | `bun --version`; verified at [`agent-network/package.json engines.bun`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/package.json) `">=1.2.0"` |
| Memory | 256MB (Server) + 128MB per Agent | `free -m` |
| Disk | 100MB + database growth | `df -h` |
| Network | Connection to CommHub Server | `curl <hub>/health` |

## Next steps

**Get started**:
- [One-shot install](/en/guide/one-shot-install) — first agent in 5 minutes after install
- [Hello World](/en/cases/hello-world) — 6-step tutorial

**Production**:
- [Production deployment](/en/deploy/production) — multi-machine + TLS + backups
- [Docker deployment](/en/deploy/docker) — containerization vs. npm

**Dig deeper**:
- [Architecture](/en/guide/architecture) — where each component runs
- [CLI commands](/en/guide/cli) — full anet command reference
- [Dashboard](/en/guide/dashboard) — Web UI monitoring

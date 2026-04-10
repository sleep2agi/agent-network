# Getting Started with Agent Network

## What is Agent Network?

Agent Network lets you create a network of AI agents that collaborate via a central communication hub. Each agent runs an AI model (GPT-5.4, Claude, MiniMax, etc.) and can send/receive tasks through the hub.

```
You → anet CLI → CommHub Server ← Agent 1 (GPT-5.4)
                                ← Agent 2 (MiniMax)
                                ← Agent 3 (Claude)
```

## Option A: Quickstart (Recommended)

**Prerequisites**: Node.js 20+, Bun (for server)

```bash
# 1. Install
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview

# 2. Start local server + auto-setup
anet server local

# 3. In another terminal — create and start an agent
anet create my-agent --runtime codex-sdk
anet start my-agent
```

That's it! Your agent is online and ready to receive tasks.

## Option B: Step by Step

### Step 1: Install

```bash
npm install -g @sleep2agi/agent-network @sleep2agi/agent-node
```

### Step 2: Start or Connect to a Server

**Local server** (for development):
```bash
anet server local
```

**Remote server** (for teams):
```bash
anet init --hub https://your-server:9200
```

### Step 3: Register & Login

```bash
anet register      # Create account (first time)
anet login         # Login (returning user)
anet whoami        # Verify you're logged in
```

### Step 4: Create a Network

A network is an isolated space for your agents. One is auto-created on registration.

```bash
anet network ls              # List your networks
anet network create my-team  # Create another
anet network use my-team     # Switch to it
```

### Step 5: Create an Agent

```bash
# Interactive (asks you to choose runtime/model)
anet create my-agent

# Or specify directly
anet create my-agent --runtime codex-sdk --model gpt-5.4
```

**Available runtimes**:

| Runtime | AI Model | Needs |
|---------|----------|-------|
| `codex-sdk` | GPT-5.4 | `codex auth login` |
| `claude-agent-sdk` | Claude | Claude Pro + `claude auth login` |
| `http-api` | MiniMax, DeepSeek, etc. | API key in env |

### Step 6: Start the Agent

```bash
anet start my-agent
```

The agent connects to CommHub via SSE, waits for tasks, and processes them with AI.

### Step 7: Send a Task

From another Claude Code / Codex session, or via the Dashboard:

```bash
# Check who's online
anet status

# View from CLI
anet tasks
```

Via MCP (from Claude Code):
```
commhub_send_task(alias="my-agent", task="Write a hello world in Python")
```

## Managing Your Account

```bash
anet whoami          # Current user info
anet passwd          # Change password
anet token create k  # Create API token for an agent
anet token           # List tokens
anet token revoke x  # Revoke a token
anet license         # Check trial/license status
anet activate <key>  # Activate license key
```

## Managing Agents

```bash
anet ls              # List all nodes + status
anet info my-agent   # Detailed node info
anet logs my-agent   # View agent logs
anet stop my-agent   # Stop agent
anet delete my-agent --force  # Delete agent
anet rename old new  # Rename agent
```

## Monitoring

```bash
anet status          # Network overview (agents + tasks)
anet tasks           # Task history
anet tasks replied   # Filter by status
anet demo            # Live system dashboard
anet doctor          # System diagnostic
```

## Using MiniMax (no Codex/Claude needed)

```bash
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_API_KEY=your-key \
agent-node --alias mm-bot --runtime http-api --model claude-3-5-haiku-20241022
```

## Architecture

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Agent Node │    │  Agent Node │    │  Agent Node │
│  (codex)    │    │  (minimax)  │    │  (claude)   │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │ SSE              │ SSE              │ MCP
       └──────────┬───────┴──────────────────┘
            ┌─────┴─────┐
            │  CommHub   │  ← MCP + REST + SSE
            │  Server    │  ← SQLite / PostgreSQL
            └─────┬─────┘
                  │
            ┌─────┴─────┐
            │ Dashboard  │  ← Web UI
            └───────────┘
```

## FAQ

**Q: Do I need a server?**
A: `anet server local` starts one on your laptop. For teams, deploy CommHub on a server.

**Q: Is it free?**
A: 14-day free trial. After that, activate a license key or use the free hosted network.

**Q: Which runtime should I use?**
A: `codex-sdk` (GPT-5.4) for code tasks. `http-api` with MiniMax for general tasks without Codex/Claude.

**Q: Can agents in different networks see each other?**
A: No. Networks are completely isolated.

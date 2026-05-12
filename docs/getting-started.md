# Getting Started with Agent Network

## What is Agent Network?

Agent Network lets you create a network of AI agents that collaborate via a central communication hub. Each agent runs an AI model (Codex, Claude, MiniMax, etc.) and can send/receive tasks through the hub.

```
You → anet CLI → CommHub Server ← Agent 1 (Codex)
                                ← Agent 2 (MiniMax)
                                ← Agent 3 (Claude)
```

## Option A: Quickstart (Recommended)

**Prerequisites**: Node.js 20+, Bun (for server)

```bash
# 1. Install
npm install -g @sleep2agi/agent-network

# 2. Start local server
anet hub start

# 3. In another terminal — start the dashboard
anet hub dashboard

# 4. In another terminal — login, create, and start an agent
anet login --username admin --password anethub
anet node create my-agent --runtime codex-sdk
anet node start my-agent
```

That's it! Your agent is online and ready to receive tasks.

## Option B: Step by Step

### Step 1: Install

```bash
npm install -g @sleep2agi/agent-network
```

### Step 2: Start or Connect to a Server

**Local server** (for development):
```bash
anet hub start
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
anet node create my-agent

# Or specify directly
anet node create my-agent --runtime codex-sdk --model <codex-model-id>
```

**Available runtimes**:

| Runtime | AI Model | Needs |
|---------|----------|-------|
| `codex-sdk` | Codex | `codex auth login` |
| `claude-agent-sdk` | Claude / MiniMax / DeepSeek / GLM / Kimi | API key in env or via `anet node create` prompts |
| `claude-code-cli` | Claude Code CLI | Claude Code installed + `claude auth login` |
| `http-api` | OpenAI/Anthropic-compatible HTTP | API key in env |

### Step 6: Start the Agent

```bash
anet node start my-agent
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
# anet license / anet activate <key> — legacy v0.6 license commands;
# Apache-2.0 OSS no longer needs them. Hub still has a `licenses` SQLite table
# for backward-compat. If you hit `license_expired`, see docs-site/troubleshooting.
```

## Managing Agents

```bash
anet ls              # List all nodes + status
anet info my-agent   # Detailed node info
anet logs my-agent   # View agent logs
anet node stop my-agent   # Stop agent
anet node delete my-agent --force  # Delete agent
anet node rename old new  # Rename agent
```

## Monitoring

```bash
anet status          # Network overview (agents + tasks)
anet tasks           # Task history
anet tasks replied   # Filter by status
anet demo ls         # List available built-in multi-agent demos
anet demo debate     # 6-agent 9-step debate demo
anet doctor          # System diagnostic — also auto-fixes stale ntok_ on hub DB wipe
```

## Using MiniMax (no Codex/Claude needed)

```bash
anet node create mm-bot \
  --runtime claude-agent-sdk \
  --model MiniMax-M2.7 \
  --env ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
  --env ANTHROPIC_AUTH_TOKEN=your-key
anet node start mm-bot
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
A: `anet hub start` starts one on your laptop. For teams, deploy CommHub on a server and start it with `--host 0.0.0.0` if LAN agents need to connect.

**Q: Is it free?**
A: **Apache-2.0 open source, fully self-hosted.** No paid license is required and there is no official hosted SaaS. The current v0.8 server still contains a legacy `licenses` table + `send_task` expiry check (creates a 14-day trial on first run). If you hit `license_expired`, see [Troubleshooting](https://anet.sh/en/troubleshooting). The business model is courses + consulting, not license sales.

**Q: Which runtime should I use?**
A: `claude-agent-sdk` is the verified default — works with Claude API directly, plus any Anthropic-compatible provider (MiniMax / DeepSeek / GLM / Kimi). `codex-sdk` (Codex) for code-heavy tasks if you have a Codex subscription. `claude-code-cli` works locally for Claude Pro subscribers.

**Q: Can agents in different networks see each other?**
A: No. Networks are completely isolated.

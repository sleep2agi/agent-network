# Agent Network Examples

> Quick reference for the most common flows. For the full guide, see [anet.sh/guide/getting-started](https://anet.sh/guide/getting-started).

## Quick Start (3 commands)

```bash
# Install
npm i -g @sleep2agi/agent-network

# Start the Hub (Terminal 1)
anet hub start

# Create + start an agent (Terminal 2)
anet node create my-agent --runtime claude-agent-sdk
anet node start my-agent
```

## Demo: Math Challenge

Two agents solving math problems:

```bash
# Terminal 1: start hub (first run auto-bootstraps admin / anethub)
anet hub start

# Terminal 2: login + create agents
anet login --username admin --password anethub
anet node create solver-1 --runtime codex-sdk --model <codex-model-id>
anet node create solver-2 --runtime codex-sdk --model <codex-model-id>
anet node start solver-1 &
anet node start solver-2 &

# Terminal 3: verify and send tasks
anet status                                 # both should show online

# Use the CommHub MCP via Claude Code / dashboard ChatPanel to dispatch:
#   commhub_send_task(alias="solver-1", task="What is 123 * 456?")
#   commhub_send_task(alias="solver-2", task="What is the 20th Fibonacci number?")
anet tasks                                  # see results
```

## Demo: MiniMax via `claude-agent-sdk`

Use MiniMax (Anthropic-compatible) as the AI backend — no Codex / Claude subscription needed:

```bash
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-minimax-key \
anet node create minimax-bot --runtime claude-agent-sdk --model <minimax-model-id>
anet node start minimax-bot
```

See [anet.sh/guide/multi-model](https://anet.sh/guide/multi-model) for the full provider table (DeepSeek, GLM, Kimi, InternLM, Xiaomi MiMo, OpenRouter, custom).

## Demo: Docker E2E

Run the in-repo Docker E2E and QA suites (matches CI):

```bash
# QA report-only suite (L0 unit + L1 contract, ~40s)
bash scripts/qa.sh

# Per-suite Docker test (example: hub start UX)
docker compose --project-directory tests/qa-cli-01-hub-start up --abort-on-container-exit
```

Test matrix and strategy: [`docs/qa/`](../docs/qa/README.md).

## CLI cheat sheet

```bash
anet hub start                  # Start Hub + bootstrap admin (admin / anethub on first run)
anet hub dashboard              # Web UI on localhost:3000
anet login                      # Login (saves utok_ to ~/.anet/config.json)
anet whoami                     # Current user
anet passwd                     # Change password (v0.8+)
anet node ls                    # List nodes
anet node create <name>         # Interactive runtime + provider picker
anet node start <name>          # Start agent
anet node resume <name>         # Resume previous session (v0.8.2 fixed session-resume default-loss bug)
anet status                     # Network overview
anet tasks                      # Task history
anet doctor                     # System diagnostic
anet doctor --fix               # Auto-probe expired ntok_ and reissue
anet info <name>                # Node details
anet logs <name>                # Node logs
```

Full CLI reference: [anet.sh/guide/cli](https://anet.sh/guide/cli).

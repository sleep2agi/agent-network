# Agent Network Examples

## Quick Start (3 commands)

```bash
# Install
npm i -g @sleep2agi/agent-network @sleep2agi/agent-node

# Start local server (Terminal 1)
anet server local

# Create + start agent (Terminal 2)
anet create my-agent --runtime codex-sdk
anet start my-agent
```

## Demo: Math Challenge

Two agents solve math problems:

```bash
# Start server + register
anet server local --username demo --password demo123456

# Terminal 2: Create agents
anet create solver-1 --runtime codex-sdk --model <codex-model-id>
anet create solver-2 --runtime codex-sdk --model <codex-model-id>
anet start solver-1 &
anet start solver-2 &

# Terminal 3: Send tasks
anet status  # verify both online
# Use CommHub MCP to send:
# commhub_send_task(alias="solver-1", task="What is 123 * 456?")
# commhub_send_task(alias="solver-2", task="What is the 20th Fibonacci number?")
anet tasks   # see results
```

## Demo: MiniMax Agent

Use MiniMax as AI backend (no Codex/Claude needed):

```bash
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_API_KEY=your-minimax-key \
agent-node --alias minimax-bot --runtime http-api --model claude-3-5-haiku-20241022
```

## Demo: Docker E2E

Run the full test suite:

```bash
# Build test image
docker build -t anet-e2e -f tests/Dockerfile .

# Run all 186 tests
docker run --rm anet-e2e /app/test-all.sh

# Run with real Codex
docker run --rm -v ~/.codex:/root/.codex anet-e2e /app/test-codex.sh

# 10-agent idiom chain game
docker run --rm -v ~/.codex:/root/.codex anet-e2e /app/test-game.sh
```

## CLI Cheat Sheet

```bash
anet quickstart              # Guided setup
anet demo                    # Live dashboard
anet status                  # Network overview
anet tasks                   # Task history
anet doctor                  # System diagnostic
anet info <agent>            # Agent details
anet logs <agent>            # View logs
anet license                 # License info
```

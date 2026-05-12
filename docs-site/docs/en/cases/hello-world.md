# Hello World

The simplest case: two Agents send messages to each other.

**Estimated time**: 3 minutes  
**Number of Agents**: 2  
**Model**: MiniMax (or any model)

::: tip Docker quick start
```bash
cd demos/hello-world
MINIMAX_API_KEY=your-key docker compose up
```
Source: [demos/hello-world](https://github.com/sleep2agi/agent-network/tree/main/demos/hello-world)
:::

## Result

```
小明 -> 小红: "Hello, please introduce yourself"
小红 -> 小明: "Hi! I'm 小红, an AI assistant..."
```

## Steps

### 1. Make sure CommHub is running

```bash
anet hub start
```

### 2. Create two Agents

```bash
# Agent 1: 小明 (uses MiniMax — low-latency in China, very cheap)
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-MiniMax-API-Key \
anet node create 小明 --runtime claude-agent-sdk

# Agent 2: 小红 (same MiniMax setup)
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-MiniMax-API-Key \
anet node create 小红 --runtime claude-agent-sdk
```

::: tip No MiniMax key?
Sign up at [platform.minimaxi.com](https://platform.minimaxi.com) and create an API key. The free tier is enough to run this case study.
:::

### 3. Start them

```bash
# Start in two separate terminal windows
anet node start 小明
anet node start 小红
```

### 4. Send a task

Open the Dashboard (in your browser at the CommHub address) and use the **Dispatch** button to send a task to 小明:

```
Ask 小红 to introduce herself
```

### 5. View results

```bash
# Check task status
anet tasks

# View 小明's logs
anet logs 小明

# View 小红's logs
anet logs 小红
```

## How it works

```
┌──────┐    send_task     ┌──────────┐    send_task     ┌──────┐
│ You  │ ──────────────→ │   小明    │ ──────────────→ │  小红  │
│(CLI) │                  │(Agent)   │                  │(Agent)│
└──────┘                  └──────────┘                  └──────┘
                               ▲                            │
                               │        send_reply          │
                               └────────────────────────────┘
```

1. You send a task to 小明 via the CLI or Dashboard
2. 小明 receives the task and sends a message to 小红 through CommHub
3. 小红 replies, and 小明 receives the result
4. 小明 reports the result back to you

## Next steps

- [Translation Pipeline](/en/cases/translation-pipeline) -- Three Agents in a chain collaboration

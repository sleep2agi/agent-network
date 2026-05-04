# Hello World

The simplest case: two Agents send messages to each other.

**Estimated time**: 3 minutes  
**Number of Agents**: 2  
**Model**: MiniMax (or any model)

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
# Agent 1: 小明
anet node create 小明 --runtime claude-agent-sdk
# Select MiniMax, enter API Key

# Agent 2: 小红
anet node create 小红 --runtime claude-agent-sdk
# Select MiniMax, enter API Key
```

### 3. Start them

```bash
# Start in two separate terminal windows
anet node start 小明
anet node start 小红
```

### 4. Send a task

Open the Dashboard (visit the CommHub address in your browser) and send a task to 小明 from the command panel:

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

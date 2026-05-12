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

### 0. First time? Init + login first

If you haven't installed `anet`:

```bash
npm i -g @sleep2agi/agent-network@latest
```

First `anet hub start` will prompt to set up an admin account (since v0.8). Press Enter to accept defaults `admin / anethub`:

```bash
anet hub start
# You'll see: Set up admin account (default: admin / anethub):
# → press Enter
```

In a second terminal, register the hub URL and log in:

```bash
anet init        # First run points to http://127.0.0.1:9200
anet login       # enter admin / anethub, get utok_
```

::: tip Already installed and logged in?
Just run `anet hub start`, then skip to step 2. `anet doctor --fix` auto-repairs expired tokens.
:::

### 1. Make sure CommHub is running

```bash
anet hub start   # skip if step 0 already started it
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

If you haven't started the Dashboard yet, open another terminal:

```bash
anet hub dashboard
# Browser opens http://localhost:3000 — log in with admin / anethub
```

In the Dashboard, use the **Dispatch** button to send a task to 小明:

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

Hello-world done — pick what's interesting next:

**More complex demos**
- [Translation Pipeline](/en/cases/translation-pipeline) — 3 Agents in a chain (DeepSeek dispatcher + MiniMax translators)
- [Debate Demo](/en/cases/debate) — 6 Agents (host + 4 debaters + judge) running a 9-step debate in one command
- [Telegram Squad](/en/cases/telegram-squad) — 11 Agents + Docker Compose + Telegram inbox

**Go deeper**
- [CLI Commands](/en/guide/cli) — complete command reference
- [Multi-Model Config](/en/guide/multi-model) — mix providers / models across agents
- [Dashboard Guide](/en/guide/dashboard) — what each browser-side panel does

**Deploy for team / public**
- [One-Shot Install](/en/guide/one-shot-install) — multi-agent + tmux in a single line
- [Production Deployment](/en/deploy/production) — public-internet checklist (TLS, password rotation, firewall)

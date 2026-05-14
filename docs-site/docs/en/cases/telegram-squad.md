# Telegram Squad

The most complete case: 1 commander + 5 code soldiers + 5 copywriting soldiers, launched with a single Docker Compose command, with Telegram integration support.

**Estimated time**: 10 minutes  
**Number of Agents**: 11 (commander + 5 Codex + 5 MiniMax)  
**Models**: Codex + MiniMax
**Requires**: Docker

## Result

Issue commands via Telegram or Dashboard to the commander:

```
You: "Build a REST API service"
Commander -> 代码1号: "Set up project skeleton"
Commander -> 代码2号: "Implement CRUD endpoints"
Commander -> 文案1号: "Write API documentation"
Commander -> 文案2号: "Write README"
...all tasks completed, summary report generated
```

## One-command launch

```bash
cd demos/codex-telegram-squad

# Configure environment variables
cp .env.example .env
# Edit .env and fill in:
# - MINIMAX_API_KEY=your MiniMax Key
# - TELEGRAM_BOT_TOKEN=your Telegram Bot Token (optional)

# Start
docker compose up -d

# Check status
docker compose ps
docker compose logs -f commander
```

## Architecture

```
┌─────────────────────────────────────────────┐
│              Docker Compose                  │
│                                              │
│  ┌──────────┐                               │
│  │ CommHub   │ ← Communication hub           │
│  │ Server    │                               │
│  └─────┬────┘                               │
│        │                                     │
│  ┌─────┴────┐                               │
│  │ Commander │ ← Receives commands,          │
│  │           │   assigns tasks               │
│  └─────┬────┘                               │
│        │                                     │
│   ┌────┴────────────────────┐               │
│   │                         │               │
│   ▼                         ▼               │
│  ┌───────────────┐   ┌───────────────┐      │
│  │ Code 1-5      │   │ Copy 1-5      │      │
│  │ (Codex)     │   │ (MiniMax)     │      │
│  │ Code + execute│   │ Copy + translate│     │
│  └───────────────┘   └───────────────┘      │
│                                              │
│  ┌──────────┐  ┌──────────┐                 │
│  │Dashboard │  │  seed    │ ← Initialization │
│  └──────────┘  └──────────┘                 │
└─────────────────────────────────────────────┘
```

## Container list

| Container | Role | Model | Description |
|-----------|------|-------|-------------|
| server | CommHub | - | Communication hub |
| seed | Initialization | - | Registers admin, creates network, generates ntok_ |
| commander | Commander | Codex | Receives commands, assigns tasks |
| worker-1~5 | Code soldiers | Codex | Write code, run commands |
| worker-6~10 | Copy soldiers | MiniMax | Copywriting, translation |
| dashboard | Web UI | - | Browser control panel |

## Environment variables

```bash
# Required
MINIMAX_API_KEY=sk-cp-xxx        # MiniMax API Key (used by commander + 文案 workers)

# Optional (for Telegram integration)
TELEGRAM_BOT_TOKEN=123456:ABC    # Telegram Bot Token
TELEGRAM_ALLOW_USER=your_ID      # Allowed Telegram user ID (singular ALLOW_USER, NOT ALLOWED_USERS)

# Optional (for Codex)
# Run codex auth login first
```

::: warning Env-var naming gotcha
`TELEGRAM_ALLOW_USER` is **singular** (verified at [`demos/codex-telegram-squad/.env.example`](https://github.com/sleep2agi/agent-network/blob/main/demos/codex-telegram-squad/.env.example) + [`docker-compose.yml:52`](https://github.com/sleep2agi/agent-network/blob/main/demos/codex-telegram-squad/docker-compose.yml#L52)). A typo like `TELEGRAM_ALLOWED_USERS` / `_USERS` gets silently ignored by docker compose — the Telegram bot then rejects all non-whitelisted messages but the logs show no obvious error, so it's easy to misattribute to a bot-config issue.
:::

## Operations

```bash
# Start
docker compose up -d

# Check all container statuses
docker compose ps

# View commander logs
docker compose logs -f commander

# View a specific code soldier's logs
docker compose logs -f worker-1

# Stop
docker compose down

# Rebuild
docker compose up -d --build
```

## Telegram integration

1. Create a Bot with @BotFather and get the Token
2. Add it to `.env` as `TELEGRAM_BOT_TOKEN`
3. Restart: `docker compose up -d`
4. Send a message to the Bot on Telegram -- the commander will receive and distribute tasks

::: tip Not using Docker? v0.8.2 one-shot bind
If you run a single node via `anet node create / start` instead of Docker Compose, attach Telegram in one command:
```bash
# Note: telegram takes a <node-id> positional arg; the allowlist flag is --allow (not --allow-user)
anet channel add telegram <node-id> --bot-token <BOT_TOKEN> --allow <TG_USER_ID>
```
This auto-generates the node's `channels/telegram` config — no `.env` edits required. See [Channels — Telegram](/en/guide/channels#telegram-channel).
:::

## Next steps

**More cases**:
- [Hello World](/en/cases/hello-world) — minimal 6-step demo (two-agent conversation warm-up)
- [Debate Demo](/en/cases/debate) — built-in 6-agent debate orchestration (one command)
- [Translation pipeline](/en/cases/translation-pipeline) — multi-agent pipeline

**Customize and dig deeper**:
- Swap code workers for DeepSeek or Kimi? See [multi-model](/en/guide/multi-model) — Anthropic-compatible endpoint table for domestic providers
- Want to understand how the Telegram channel plugin works? See [Channels](/en/guide/channels) + the repo [demos/codex-telegram-squad](https://github.com/sleep2agi/agent-network/tree/main/demos/codex-telegram-squad)
- Wire up WeChat / Feishu instead? See the extension guide at the end of [Channels](/en/guide/channels)

**Production**:
- Move the whole stack to a cloud VM: [Production deployment](/en/deploy/production)
- Adjust worker count or model mix: edit `docker-compose.yml` directly — each worker is an independent block
- Monitor commander + workers: [Dashboard](/en/guide/dashboard) Topology + Tasks panels

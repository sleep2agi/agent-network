# Telegram Squad

The most complete case: 1 commander + 5 code soldiers + 5 copywriting soldiers, launched with a single Docker Compose command, with Telegram integration support.

**Estimated time**: 10 minutes  
**Number of Agents**: 11 (commander + 5 Codex + 5 MiniMax)  
**Models**: GPT-5 + MiniMax
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
│  │ (GPT-5)     │   │ (MiniMax)     │      │
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
| commander | Commander | GPT-5 | Receives commands, assigns tasks |
| worker-1~5 | Code soldiers | GPT-5 | Write code, run commands |
| worker-6~10 | Copy soldiers | MiniMax | Copywriting, translation |
| dashboard | Web UI | - | Browser control panel |

## Environment variables

```bash
# Required
MINIMAX_API_KEY=sk-cp-xxx        # MiniMax API Key

# Optional (for Telegram integration)
TELEGRAM_BOT_TOKEN=123456:ABC    # Telegram Bot Token
TELEGRAM_ALLOWED_USERS=your_ID   # Allowed user IDs

# Optional (for Codex)
# Run codex auth login first
```

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

## Next steps

- Debate Demo -- Built-in 6-agent debate orchestration
- Examples And Demo -- Back to the overview

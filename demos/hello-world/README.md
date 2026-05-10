# Hello World Demo

Two AI agents (小明 and 小红) talk to each other through CommHub.

## Quick Start

```bash
# Set your MiniMax API Key
export MINIMAX_API_KEY=sk-cp-your-key-here

# Start everything
docker compose up

# Watch the conversation
docker compose logs -f xiaoming xiaohong
```

## What Happens

1. CommHub server starts on port 9200
2. Admin account is registered, network token generated
3. 小明 and 小红 connect to CommHub
4. A task is sent to 小明: "Say hello to 小红"
5. 小明 sends a message to 小红, 小红 replies
6. You see the conversation in the logs

## Get a MiniMax API Key

1. Go to [platform.minimaxi.com](https://platform.minimaxi.com)
2. Register and create an API Key
3. Free tier is enough for this demo

## Stop

```bash
docker compose down -v
```

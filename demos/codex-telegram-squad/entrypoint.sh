#!/bin/bash
# Agent entrypoint — reads config from environment variables

ALIAS="${ALIAS:-agent}"
RUNTIME="${RUNTIME:-codex-sdk}"
MODEL="${MODEL:-gpt-5.4}"
HUB="${COMMHUB_URL:-http://server:9200}"
TOKEN="${COMMHUB_TOKEN:-}"
TOOLS_ARG="${TOOLS:-}"
PROMPT="${SYSTEM_PROMPT:-}"

# Build agent-node command
CMD="bun /app/agent-node/src/cli.ts --alias $ALIAS --runtime $RUNTIME --url $HUB"

[ -n "$MODEL" ] && CMD="$CMD --model $MODEL"
[ -n "$TOOLS_ARG" ] && CMD="$CMD --tools $TOOLS_ARG"

# Set up Telegram channel if bot token provided
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ALLOW_USER" ]; then
  mkdir -p /app/.anet/nodes/$ALIAS/channels/telegram
  echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" > /app/.anet/nodes/$ALIAS/channels/telegram/.env
  chmod 600 /app/.anet/nodes/$ALIAS/channels/telegram/.env
  echo "{\"allow\":[\"$TELEGRAM_ALLOW_USER\"]}" > /app/.anet/nodes/$ALIAS/channels/telegram/access.json
  CMD="$CMD --channel telegram:/app/.anet/nodes/$ALIAS/channels/telegram"
fi

# Write config for token
mkdir -p /root/.anet
echo "{\"hub\":\"$HUB\",\"token\":\"$TOKEN\"}" > /root/.anet/config.json

echo "Starting agent: $ALIAS ($RUNTIME)"
echo "  Hub: $HUB"
echo "  Model: $MODEL"
[ -n "$TELEGRAM_BOT_TOKEN" ] && echo "  Telegram: enabled"

# Export env for runtimes
export COMMHUB_TOKEN="$TOKEN"

exec $CMD

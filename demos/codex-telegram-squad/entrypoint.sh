#!/bin/bash
# Agent entrypoint — reads config from environment variables

ALIAS="${ALIAS:-agent}"
RUNTIME="${RUNTIME:-codex-sdk}"
MODEL="${MODEL:-gpt-5.5}"
HUB="${COMMHUB_URL:-http://server:9200}"
TOKEN="${COMMHUB_TOKEN:-}"
TOOLS_ARG="${TOOLS:-}"
PROMPT="${SYSTEM_PROMPT:-}"

# Prefer ntok_ from shared volume (seeded by seed container), so sessions register
# under the admin's network instead of network_id=null
if [ -f /shared/ntok ]; then
  NTOK="$(cat /shared/ntok)"
  if [ -n "$NTOK" ]; then
    TOKEN="$NTOK"
    echo "  using ntok_ from /shared/ntok"
  fi
fi

# Build agent-node command as array (handles spaces / special chars in prompt)
CMD=(bun /app/agent-node/src/cli.ts --alias "$ALIAS" --runtime "$RUNTIME" --url "$HUB")

[ -n "$MODEL" ] && CMD+=(--model "$MODEL")
[ -n "$TOOLS_ARG" ] && CMD+=(--tools "$TOOLS_ARG")

# Inject network roster as prior knowledge (so node knows who it can talk to)
ROSTER="网络成员 (CommHub alias):
- 指挥室 (Codex 指挥，处理 Telegram 消息，不要派任务给自己)
- 代码1号 / 代码2号 / 代码3号 / 代码4号 / 代码5号 (Codex GPT-5.4，擅长代码/文件/命令)
- 文案1号 / 文案2号 / 文案3号 / 文案4号 / 文案5号 (MiniMax，擅长文本/翻译/分析)

通信方式 (MCP tools)：
- commhub_get_all_status() → 查当前在线节点
- commhub_send_task(alias, task, priority) → 派任务给指定节点
- commhub_reply(task_id, text, status) → 回任务
- commhub_report_status(status, task) → 上报自己状态

收到消息时先用 get_all_status 看现状，再用 send_task 分派。"

if [ -n "$PROMPT" ]; then
  FULL_PROMPT="$PROMPT

$ROSTER"
else
  FULL_PROMPT="你是 $ALIAS，CommHub 网络中的 AI 节点。

$ROSTER"
fi
CMD+=(--prompt "$FULL_PROMPT")

# Set up Telegram channel if bot token provided
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ALLOW_USER" ]; then
  mkdir -p /app/.anet/nodes/$ALIAS/channels/telegram
  echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" > /app/.anet/nodes/$ALIAS/channels/telegram/.env
  chmod 600 /app/.anet/nodes/$ALIAS/channels/telegram/.env
  echo "{\"allow\":[\"$TELEGRAM_ALLOW_USER\"]}" > /app/.anet/nodes/$ALIAS/channels/telegram/access.json
  CMD+=(--channel "telegram:/app/.anet/nodes/$ALIAS/channels/telegram")
fi

# Write config for token
mkdir -p /root/.anet
echo "{\"hub\":\"$HUB\",\"token\":\"$TOKEN\"}" > /root/.anet/config.json

# ── Isolated Codex config for this container (don't pollute host's ~/.codex) ──
# Copy auth.json + version from mounted host codex dir, write fresh config.toml
if [ "$RUNTIME" = "codex-sdk" ]; then
  export CODEX_HOME="/tmp/codex-home"
  mkdir -p "$CODEX_HOME"
  [ -f /root/.codex/auth.json ] && cp /root/.codex/auth.json "$CODEX_HOME/auth.json"
  [ -f /root/.codex/version.json ] && cp /root/.codex/version.json "$CODEX_HOME/version.json"

  # Fresh container-safe config.toml + register CommHub as Streamable HTTP MCP server
  cat > "$CODEX_HOME/config.toml" <<EOF
model = "${MODEL}"
model_reasoning_effort = "low"

[projects."/app"]
trust_level = "trusted"

[mcp_servers.commhub]
url = "${HUB}/mcp"
bearer_token_env_var = "COMMHUB_TOKEN"
EOF

  echo "  codex: CODEX_HOME=$CODEX_HOME (MCP: commhub → ${HUB}/mcp)"
fi

echo "Starting agent: $ALIAS ($RUNTIME)"
echo "  Hub: $HUB"
echo "  Model: $MODEL"
[ -n "$TELEGRAM_BOT_TOKEN" ] && echo "  Telegram: enabled"

# Export env for runtimes
export COMMHUB_TOKEN="$TOKEN"
# Claude CLI refuses --dangerously-skip-permissions as root; IS_SANDBOX=1 tells it we're in Docker
export IS_SANDBOX="${IS_SANDBOX:-1}"

exec "${CMD[@]}"

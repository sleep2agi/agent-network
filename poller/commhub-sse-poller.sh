#!/bin/bash
# CommHub SSE Poller — 实时推送，零轮询
#
# 通过 SSE 长连接监听 CommHub /events/:alias，
# 收到 new_task/broadcast 事件时 tmux send-keys 推 AI 领任务。
#
# 效果等同 Channel，但不依赖 Claude Code Channel 协议。
# 适用于 MiniMax、Codex、Qwen、OpenCode 等所有 tmux session。
#
# 用法：
#   ./commhub-sse-poller.sh --alias minimax-96g --tmux minimax-cc
#   ./commhub-sse-poller.sh --alias codex-硅谷 --tmux codex-hub
#   ./commhub-sse-poller.sh --alias P站姐 --tmux codex-paper --url http://IP:9200
#
# 环境变量：
#   COMMHUB_URL   (默认 http://127.0.0.1:9200)
#   COMMHUB_TOKEN (可选)

set -uo pipefail

# ── 参数解析 ────────────────────────────────────────
ALIAS=""
TMUX_SESSION=""
COMMHUB_URL="${COMMHUB_URL:-http://127.0.0.1:9200}"
TOKEN="${COMMHUB_TOKEN:-}"
RECONNECT_DELAY=3
# 收到事件后推给 AI 的命令模板
# 默认让 AI 调 get_inbox 拉取任务
PUSH_CMD_TEMPLATE='调 get_inbox alias={ALIAS} limit=5，有任务就执行，完成后 report_completion。'

while [[ $# -gt 0 ]]; do
  case $1 in
    --alias) ALIAS="$2"; shift 2;;
    --tmux) TMUX_SESSION="$2"; shift 2;;
    --url) COMMHUB_URL="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --delay) RECONNECT_DELAY="$2"; shift 2;;
    --push-cmd) PUSH_CMD_TEMPLATE="$2"; shift 2;;
    *) echo "Unknown: $1"; exit 1;;
  esac
done

if [[ -z "$ALIAS" || -z "$TMUX_SESSION" ]]; then
  echo "Usage: $0 --alias <alias> --tmux <tmux-session> [--url http://...] [--token xxx]"
  echo ""
  echo "Options:"
  echo "  --alias       CommHub session alias"
  echo "  --tmux        tmux session name to push messages to"
  echo "  --url         CommHub server URL (default: http://127.0.0.1:9200)"
  echo "  --token       Auth token (or set COMMHUB_TOKEN env)"
  echo "  --delay       Reconnect delay seconds (default: 3)"
  echo "  --push-cmd    Custom command template to push (use {ALIAS} placeholder)"
  exit 1
fi

log() { echo "[$(date +%H:%M:%S)] [sse:$ALIAS] $*"; }

# ── 构建 push 命令 ──────────────────────────────────
PUSH_CMD="${PUSH_CMD_TEMPLATE//\{ALIAS\}/$ALIAS}"

# ── SSE 监听主循环 ──────────────────────────────────
log "starting: alias=$ALIAS tmux=$TMUX_SESSION url=$COMMHUB_URL"
log "push command: $PUSH_CMD"

while true; do
  # 检查 tmux
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "WARN: tmux '$TMUX_SESSION' not found, waiting ${RECONNECT_DELAY}s..."
    sleep "$RECONNECT_DELAY"
    continue
  fi

  SSE_URL="$COMMHUB_URL/events/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$ALIAS'))" 2>/dev/null || echo "$ALIAS")"
  log "connecting SSE: $SSE_URL"

  # 构建 curl 参数
  CURL_ARGS=(-N -s --no-buffer)
  [[ -n "$TOKEN" ]] && CURL_ARGS+=(-H "Authorization: Bearer $TOKEN")

  # 用 curl 保持 SSE 长连接，逐行读取
  curl "${CURL_ARGS[@]}" "$SSE_URL" 2>/dev/null | while IFS= read -r line; do
    # 跳过空行和注释
    [[ -z "$line" ]] && continue
    [[ "$line" == ":"* ]] && continue  # SSE keepalive 注释

    # 只处理 data: 行
    if [[ "$line" == data:* ]]; then
      DATA="${line#data: }"

      # 解析事件类型
      EVENT_TYPE=$(echo "$DATA" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('type', ''))
except:
    print('')
" 2>/dev/null || echo "")

      case "$EVENT_TYPE" in
        connected)
          log "SSE connected as '$ALIAS'"
          ;;
        new_task)
          PRIORITY=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('priority','normal'))" 2>/dev/null || echo "normal")
          FROM=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('from','hub'))" 2>/dev/null || echo "hub")
          COUNT=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('inbox_count',1))" 2>/dev/null || echo "1")
          log "← new_task from=$FROM priority=$PRIORITY inbox=$COUNT"

          # 推给 AI
          tmux send-keys -t "$TMUX_SESSION" "$PUSH_CMD" Enter
          log "→ pushed to tmux:$TMUX_SESSION"
          ;;
        broadcast)
          log "← broadcast"
          tmux send-keys -t "$TMUX_SESSION" "$PUSH_CMD" Enter
          log "→ pushed to tmux:$TMUX_SESSION"
          ;;
        *)
          [[ -n "$EVENT_TYPE" ]] && log "ignored event: $EVENT_TYPE"
          ;;
      esac
    fi
  done

  log "SSE disconnected, reconnecting in ${RECONNECT_DELAY}s..."
  sleep "$RECONNECT_DELAY"
done

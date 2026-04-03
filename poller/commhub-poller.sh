#!/bin/bash
# CommHub Poller Daemon — 外部守护脚本，可靠收消息
#
# 解决核心问题：AI (MiniMax/Codex) 不会可靠自循环轮询。
# 方案：shell 脚本轮询 CommHub inbox → 有消息时 tmux send-keys 推给 AI。
#
# 用法：
#   ./commhub-poller.sh --alias minimax-96g --tmux minimax-cc --interval 10
#   ./commhub-poller.sh --alias codex-硅谷 --tmux codex-hub --interval 15
#
# 环境变量：
#   COMMHUB_URL  (默认 http://127.0.0.1:9200)
#   COMMHUB_TOKEN (可选)

set -euo pipefail

# ── 参数解析 ────────────────────────────────────────
ALIAS=""
TMUX_SESSION=""
INTERVAL=10
COMMHUB_URL="${COMMHUB_URL:-http://127.0.0.1:9200}"
AUTH_HEADER=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --alias) ALIAS="$2"; shift 2;;
    --tmux) TMUX_SESSION="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;;
    --url) COMMHUB_URL="$2"; shift 2;;
    --token) AUTH_HEADER="Authorization: Bearer $2"; shift 2;;
    *) echo "Unknown: $1"; exit 1;;
  esac
done

if [[ -z "$ALIAS" || -z "$TMUX_SESSION" ]]; then
  echo "Usage: $0 --alias <commhub-alias> --tmux <tmux-session> [--interval 10] [--url http://...] [--token xxx]"
  exit 1
fi

if [[ -n "${COMMHUB_TOKEN:-}" && -z "$AUTH_HEADER" ]]; then
  AUTH_HEADER="Authorization: Bearer $COMMHUB_TOKEN"
fi

log() { echo "[$(date +%H:%M:%S)] [poller:$ALIAS] $*"; }

# ── CommHub MCP 调用 ────────────────────────────────
call_mcp() {
  local tool="$1"
  local args="$2"
  local headers=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
  [[ -n "$AUTH_HEADER" ]] && headers+=(-H "$AUTH_HEADER")

  # Initialize
  curl -s "${headers[@]}" -X POST "$COMMHUB_URL/mcp" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"poller","version":"1.0.0"}}}' > /dev/null 2>&1

  # Call tool
  local resp
  resp=$(curl -s "${headers[@]}" -X POST "$COMMHUB_URL/mcp" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" 2>&1)

  # Extract data: line
  echo "$resp" | grep "^data: " | tail -1 | sed 's/^data: //' | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    t = d.get('result',{}).get('content',[{}])[0].get('text','{}')
    print(t)
except: print('{}')
" 2>/dev/null || echo "{}"
}

# ── 检查 tmux session 是否存在 ─────────────────────
check_tmux() {
  tmux has-session -t "$TMUX_SESSION" 2>/dev/null
}

# ── 推消息给 AI ────────────────────────────────────
push_to_ai() {
  local content="$1"
  local task_id="$2"
  local from="$3"

  # 转义引号
  local escaped
  escaped=$(echo "$content" | sed 's/"/\\"/g' | tr '\n' ' ' | head -c 500)

  log "← task [$task_id] from $from: ${escaped:0:80}..."

  # 通过 tmux send-keys 推给 AI
  tmux send-keys -t "$TMUX_SESSION" "CommHub 任务 [from: $from, id: $task_id]: $escaped" Enter

  log "→ pushed to tmux:$TMUX_SESSION"
}

# ── 主循环 ──────────────────────────────────────────
log "starting: alias=$ALIAS tmux=$TMUX_SESSION interval=${INTERVAL}s url=$COMMHUB_URL"

# 检查 tmux session
if ! check_tmux; then
  log "ERROR: tmux session '$TMUX_SESSION' not found!"
  exit 1
fi

log "tmux session verified"

CONSECUTIVE_ERRORS=0
MAX_ERRORS=10

while true; do
  # 检查 tmux 是否还活着
  if ! check_tmux; then
    log "tmux session '$TMUX_SESSION' disappeared, waiting..."
    sleep 30
    continue
  fi

  # 拉取 inbox
  INBOX=$(call_mcp "get_inbox" "{\"alias\":\"$ALIAS\",\"limit\":5}" 2>/dev/null || echo "{}")

  # 检查是否有消息
  MSG_COUNT=$(echo "$INBOX" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    msgs = d.get('messages', [])
    print(len(msgs))
except: print(0)
" 2>/dev/null || echo "0")

  if [[ "$MSG_COUNT" -gt 0 ]]; then
    CONSECUTIVE_ERRORS=0
    log "found $MSG_COUNT message(s)"

    # 处理每条消息
    echo "$INBOX" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for m in d.get('messages', []):
    print(json.dumps({'id': m['id'], 'content': m['content'], 'from': m.get('from_session','hub'), 'priority': m.get('priority','normal')}))
" 2>/dev/null | while IFS= read -r msg; do
      MSG_ID=$(echo "$msg" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
      MSG_CONTENT=$(echo "$msg" | python3 -c "import sys,json; print(json.load(sys.stdin)['content'])")
      MSG_FROM=$(echo "$msg" | python3 -c "import sys,json; print(json.load(sys.stdin)['from'])")

      # ACK
      call_mcp "ack_inbox" "{\"alias\":\"$ALIAS\",\"message_id\":\"$MSG_ID\"}" > /dev/null 2>&1

      # 推给 AI
      push_to_ai "$MSG_CONTENT" "$MSG_ID" "$MSG_FROM"

      sleep 1  # 消息间隔 1 秒
    done
  else
    # 检查是否是错误
    OK=$(echo "$INBOX" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null || echo "")
    if [[ "$OK" != "True" && "$OK" != "true" ]]; then
      CONSECUTIVE_ERRORS=$((CONSECUTIVE_ERRORS + 1))
      if [[ $CONSECUTIVE_ERRORS -ge $MAX_ERRORS ]]; then
        log "ERROR: $CONSECUTIVE_ERRORS consecutive failures, sleeping 60s"
        sleep 60
        CONSECUTIVE_ERRORS=0
        continue
      fi
    else
      CONSECUTIVE_ERRORS=0
    fi
  fi

  sleep "$INTERVAL"
done

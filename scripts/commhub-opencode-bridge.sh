#!/bin/bash
# CommHub → OpenCode Bridge
#
# 监听 CommHub SSE 事件，收到 new_task 时调用 opencode --prompt 执行任务。
# 替代 SSE Poller + tmux send-keys 的粗暴方案。
#
# 每条任务启动独立 opencode --prompt 进程（非 TUI，纯 CLI），
# 执行完自动退出。MCP 工具在 --prompt 模式下可用。
#
# 用法：
#   ./commhub-opencode-bridge.sh --alias P站MiniMax马 --url http://47.77.216.1:9200
#
# 环境变量：
#   MINIMAX_API_KEY  — MiniMax API key
#   OPENCODE_BIN     — opencode 二进制路径（默认 ~/opencode-v1）
#   OPENCODE_DIR     — opencode 工作目录（默认 ~/opencode-test）

set -uo pipefail

# ── 参数解析 ──
ALIAS=""
COMMHUB_URL="${COMMHUB_URL:-http://47.77.216.1:9200}"
TOKEN="${COMMHUB_TOKEN:-}"
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/opencode-v1}"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/opencode-test}"
RECONNECT_DELAY=3

while [[ $# -gt 0 ]]; do
  case $1 in
    --alias) ALIAS="$2"; shift 2;;
    --url) COMMHUB_URL="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --bin) OPENCODE_BIN="$2"; shift 2;;
    --dir) OPENCODE_DIR="$2"; shift 2;;
    --delay) RECONNECT_DELAY="$2"; shift 2;;
    *) echo "Unknown: $1"; exit 1;;
  esac
done

if [[ -z "$ALIAS" ]]; then
  echo "Usage: $0 --alias <alias> [--url http://...] [--bin ~/opencode-v1] [--dir ~/opencode-test]"
  exit 1
fi

log() { echo "[$(date +%H:%M:%S)] [bridge:$ALIAS] $*"; }

# ── 获取并执行 inbox 任务 ──
process_inbox() {
  local inbox_json
  inbox_json=$(curl -s --max-time 10 "$COMMHUB_URL/mcp" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"get_inbox\",\"arguments\":{\"alias\":\"$ALIAS\",\"limit\":5}}}" 2>/dev/null)

  if [[ -z "$inbox_json" ]]; then
    log "WARN: get_inbox failed"
    return
  fi

  # 解析消息列表
  local messages
  messages=$(echo "$inbox_json" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    result = d.get('result', {})
    content = result.get('content', [{}])
    text = content[0].get('text', '{}') if content else '{}'
    parsed = json.loads(text)
    msgs = parsed.get('messages', [])
    for m in msgs:
        print(json.dumps(m))
except Exception as e:
    pass
" 2>/dev/null)

  if [[ -z "$messages" ]]; then
    log "no messages in inbox"
    return
  fi

  while IFS= read -r msg_line; do
    local msg_id msg_content msg_from msg_priority
    msg_id=$(echo "$msg_line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    msg_content=$(echo "$msg_line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('content',''))" 2>/dev/null)
    msg_from=$(echo "$msg_line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('from_session','hub'))" 2>/dev/null)
    msg_priority=$(echo "$msg_line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('priority','normal'))" 2>/dev/null)

    if [[ -z "$msg_content" ]]; then continue; fi

    log "← task from=$msg_from priority=$msg_priority: ${msg_content:0:80}"

    # ACK 消息
    curl -s --max-time 5 "$COMMHUB_URL/mcp" \
      -H "Content-Type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"ack_inbox\",\"arguments\":{\"alias\":\"$ALIAS\",\"message_id\":\"$msg_id\"}}}" > /dev/null 2>&1

    # 构建 prompt：包含任务上下文 + CommHub 工具使用指引
    local prompt="你是 $ALIAS，收到来自 ${msg_from} 的任务（priority: ${msg_priority}）：

${msg_content}

执行完后用 commhub_send_task 工具回复 ${msg_from} 汇报结果，用 commhub_report_status 上报你的状态。"

    log "→ launching opencode --prompt ..."

    # 执行 opencode --prompt（非交互，自带 MCP 工具）
    cd "$OPENCODE_DIR" && timeout 300 "$OPENCODE_BIN" --prompt "$prompt" >> /tmp/opencode-bridge-output.log 2>&1 &
    local oc_pid=$!
    log "→ opencode PID=$oc_pid"

    # 不等待完成，继续处理下一条（并发执行）
  done <<< "$messages"
}

# ── SSE 监听主循环 ──
log "starting: alias=$ALIAS url=$COMMHUB_URL bin=$OPENCODE_BIN dir=$OPENCODE_DIR"

while true; do
  SSE_URL="$COMMHUB_URL/events/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$ALIAS'))" 2>/dev/null || echo "$ALIAS")"
  log "connecting SSE: $SSE_URL"

  CURL_ARGS=(-N -s --no-buffer --max-time 0)
  [[ -n "$TOKEN" ]] && CURL_ARGS+=(-H "Authorization: Bearer $TOKEN")

  curl "${CURL_ARGS[@]}" "$SSE_URL" 2>/dev/null | while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" == ":"* ]] && continue

    if [[ "$line" == data:* ]]; then
      DATA="${line#data: }"
      EVENT_TYPE=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('type',''))" 2>/dev/null || echo "")

      case "$EVENT_TYPE" in
        connected)
          log "SSE connected"
          ;;
        new_task|new_message)
          FROM=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('from','hub'))" 2>/dev/null || echo "hub")
          PRIORITY=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('priority','normal'))" 2>/dev/null || echo "normal")
          log "← $EVENT_TYPE from=$FROM priority=$PRIORITY"
          process_inbox
          ;;
        broadcast)
          log "← broadcast"
          process_inbox
          ;;
        *)
          [[ -n "$EVENT_TYPE" ]] && log "ignored: $EVENT_TYPE"
          ;;
      esac
    fi
  done

  log "SSE disconnected, reconnecting in ${RECONNECT_DELAY}s..."
  sleep "$RECONNECT_DELAY"
done

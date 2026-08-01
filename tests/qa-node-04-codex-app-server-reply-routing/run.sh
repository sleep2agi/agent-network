#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"

export HOME=/tmp/anethome
export COMMHUB_DB=/tmp/commhub-qa-node-04.db
HUB_PORT=9224
HUB_BASE="http://127.0.0.1:$HUB_PORT"
REPORT="/app/docs/tests/report-test-node04-codex-app-server-reply-routing.txt"
ADMIN_PW="StrongPassw0rd"
START_MS=$(date +%s%3N)
ASSERTIONS=0

cleanup() {
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$(dirname "$REPORT")"
: > "$REPORT"

log() {
  echo "$*"
  echo "$*" >> "$REPORT"
}

pass_assert() {
  ASSERTIONS=$((ASSERTIONS + 1))
}

mcp_call() {
  local tok="$1" name="$2" args="$3"
  local body
  body=$(jq -nc --arg n "$name" --argjson a "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  curl -sS -X POST "$HUB_BASE/mcp" \
    -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "$body" \
    | sed -n 's/^data: //p' | head -1 \
    | jq -r '.result.content[0].text // empty'
}

register_node() {
  local alias="$1" resume="$2"
  local ntok arg rs
  ntok=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
    -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
    -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"$alias\"}" | jq -r '.token')
  [[ "$ntok" == ntok_* ]] || { log "FAIL: ntok not minted for $alias"; exit 1; }
  arg=$(jq -nc --arg net "$NET_ID" --arg alias "$alias" --arg resume "$resume" \
    '{resume_id:$resume,alias:$alias,status:"idle",network_id:$net}')
  rs=$(mcp_call "$ntok" "report_status" "$arg")
  echo "$rs" | jq -e '.ok == true' >/dev/null || { log "FAIL: report_status $alias: $rs"; exit 1; }
  echo "$ntok"
}

task_row() {
  local tid="$1"
  curl -fsS "$HUB_BASE/api/tasks?task_id=$tid&network_id=$NET_ID" \
    -H "Authorization: Bearer $UTOK" | jq -c '.tasks[0]'
}

reply_message_count() {
  local content="$1"
  curl -fsS "$HUB_BASE/api/messages?limit=100" -H "Authorization: Bearer $UTOK" \
    | jq --arg c "$content" '[.messages[] | select(.type == "reply" and .content == $c)] | length'
}

fixed_reply_route() {
  local tok="$1" target="$2" text="$3" parent="$4" from_alias="$5" failed="${6:-false}"
  local status exists arg task priority
  status=$(mcp_call "$tok" "get_all_status" '{}')
  exists=$(echo "$status" | jq --arg target "$target" 'any((.sessions // [])[]; .alias == $target)')
  if [[ "$exists" == "true" ]]; then
    if [[ "$failed" == "true" ]]; then
      task="⚠️ $text"
      priority="high"
    else
      task="$text"
      priority="normal"
    fi
    arg=$(jq -nc --arg alias "$target" --arg task "$task" --arg priority "$priority" --arg from "$from_alias" --arg parent "$parent" \
      '{alias:$alias,task:$task,priority:$priority,from_session:$from,parent_task_id:$parent}')
    mcp_call "$tok" "send_task" "$arg"
  else
    arg=$(jq -nc --arg alias "$target" --arg text "$text" --arg from "$from_alias" --arg parent "$parent" --arg status "$([[ "$failed" == "true" ]] && echo failed || echo replied)" \
      '{alias:$alias,text:$text,from_session:$from,in_reply_to:$parent,status:$status}')
    mcp_call "$tok" "send_reply" "$arg"
  fi
}

log "# qa-node-04 codex-app-server reply routing"
log "[0] start isolated hub"
safe_rm_rf "$HOME/.commhub" "$HOME/.anet/server" "$COMMHUB_DB"
cd /app/server
HOST=127.0.0.1 PORT="$HUB_PORT" bun run src/index.ts >/tmp/hub.log 2>&1 &
HUB_PID=$!
for _ in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null || { log "FAIL: hub did not start"; cat /tmp/hub.log; exit 1; }

log "[1] register dashboard user and network"
REG=$(curl -fsS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\",\"email\":\"admin@example.test\"}")
UTOK=$(echo "$REG" | jq -r '.token // empty')
[[ "$UTOK" == utok_* ]] || { log "FAIL: register did not return utok: $REG"; exit 1; }
NET_RESP=$(curl -fsS -X POST "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d '{"name":"node04-net"}')
NET_ID=$(echo "$NET_RESP" | jq -r '.network.network_id // .network_id // empty')
[[ -n "$NET_ID" && "$NET_ID" != "null" ]] || { log "FAIL: network create: $NET_RESP"; exit 1; }
pass_assert

log "[2] register codex-app-server receiver and peer sender sessions"
CODEX_NTOK=$(register_node "codex-node" "resume-codex-node")
PEER_NTOK=$(register_node "peer-agent" "resume-peer-agent")
SESSION_COUNT=$(mcp_call "$CODEX_NTOK" "get_all_status" '{}' | jq '.sessions | length')
log "sessions visible in isolated hub: $SESSION_COUNT"
[[ "$SESSION_COUNT" -ge 2 ]] || { log "FAIL: sessions not visible"; exit 1; }
pass_assert

log "[3] witnessed-red: dashboard from_name=admin is not a routable node session"
DASH_TASK=$(curl -fsS -X POST "$HUB_BASE/api/task" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"codex-node\",\"task\":\"dashboard asks codex\",\"priority\":\"normal\",\"network_id\":\"$NET_ID\",\"from\":\"admin\"}")
DASH_TASK_ID=$(echo "$DASH_TASK" | jq -r '.task_id // .message_id')
RED_TEXT="[codex-node] red reply should be dropped by old send_task"
RED_ARG=$(jq -nc --arg alias "admin" --arg task "$RED_TEXT" --arg from "codex-node" --arg parent "$DASH_TASK_ID" \
  '{alias:$alias,task:$task,priority:"normal",from_session:$from,parent_task_id:$parent}')
RED_RAW=$(mcp_call "$CODEX_NTOK" "send_task" "$RED_ARG" || true)
RED_MSG_COUNT=$(reply_message_count "$RED_TEXT")
RED_ROW=$(task_row "$DASH_TASK_ID")
ADMIN_SESSION_COUNT=$(mcp_call "$CODEX_NTOK" "get_all_status" '{}' | jq '[.sessions[] | select(.alias=="admin")] | length')
log "WITNESSED_RED_RAW_SEND_TASK_TO_ADMIN=$RED_RAW"
log "WITNESSED_RED_ADMIN_SESSION_COUNT=$ADMIN_SESSION_COUNT"
log "WITNESSED_RED_REPLY_MESSAGE_COUNT=$RED_MSG_COUNT"
log "WITNESSED_RED_PARENT_TASK_ROW=$RED_ROW"
[[ "$ADMIN_SESSION_COUNT" -eq 0 ]] || { log "FAIL: test invalid, admin unexpectedly routable"; exit 1; }
[[ "$RED_MSG_COUNT" -eq 0 ]] || { log "FAIL: old send_task unexpectedly created dashboard-visible reply"; exit 1; }
[[ "$(echo "$RED_ROW" | jq -r '.status')" == "delivered" ]] || { log "FAIL: red parent task should remain delivered"; exit 1; }
pass_assert

log "[4] fixed wire route: dashboard source falls back to send_reply and is dashboard-visible"
FIX_TEXT="[codex-node] fixed dashboard reply"
FIX_RAW=$(fixed_reply_route "$CODEX_NTOK" "admin" "$FIX_TEXT" "$DASH_TASK_ID" "codex-node")
FIX_MSG_COUNT=$(reply_message_count "$FIX_TEXT")
FIX_ROW=$(task_row "$DASH_TASK_ID")
log "FIX_DASHBOARD_RAW=$FIX_RAW"
log "FIX_DASHBOARD_REPLY_MESSAGE_COUNT=$FIX_MSG_COUNT"
log "FIX_DASHBOARD_PARENT_TASK_ROW=$FIX_ROW"
[[ "$FIX_MSG_COUNT" -ge 1 ]] || { log "FAIL: fixed dashboard reply not visible in /api/messages"; exit 1; }
[[ "$(echo "$FIX_ROW" | jq -r '.status')" == "replied" ]] || { log "FAIL: fixed parent task should be replied"; exit 1; }
[[ "$(echo "$FIX_ROW" | jq -r '.result')" == "$FIX_TEXT" ]] || { log "FAIL: fixed parent task result mismatch"; exit 1; }
pass_assert

log "[5] fixed wire route: agent peer remains send_task-routed, including failed priority marker"
PEER_SEND_ARG=$(jq -nc --arg alias "codex-node" --arg task "peer asks codex" --arg from "peer-agent" \
  '{alias:$alias,task:$task,priority:"normal",from_session:$from}')
PEER_TASK_RAW=$(mcp_call "$PEER_NTOK" "send_task" "$PEER_SEND_ARG")
PEER_TASK_ID=$(echo "$PEER_TASK_RAW" | jq -r '.task_id // .message_id')
PEER_REPLY_TEXT="[codex-node] reply routed as peer task"
PEER_REPLY_RAW=$(fixed_reply_route "$CODEX_NTOK" "peer-agent" "$PEER_REPLY_TEXT" "$PEER_TASK_ID" "codex-node" true)
PEER_INBOX=$(mcp_call "$PEER_NTOK" "get_inbox" '{"alias":"peer-agent","limit":20}')
PEER_REPLY_TASK_COUNT=$(echo "$PEER_INBOX" | jq --arg c "⚠️ $PEER_REPLY_TEXT" '[.messages[] | select(.type=="task" and .content==$c and .priority=="high" and .from_session=="codex-node")] | length')
PEER_REPLY_MSG_COUNT=$(reply_message_count "$PEER_REPLY_TEXT")
log "FIX_PEER_RAW=$PEER_REPLY_RAW"
log "FIX_PEER_INBOX=$PEER_INBOX"
log "FIX_PEER_HIGH_FAILURE_TASK_COUNT=$PEER_REPLY_TASK_COUNT"
log "FIX_PEER_REPLY_MESSAGE_COUNT=$PEER_REPLY_MSG_COUNT"
[[ "$PEER_REPLY_TASK_COUNT" -ge 1 ]] || { log "FAIL: peer reply was not delivered as high-priority failure task to peer-agent"; exit 1; }
[[ "$PEER_REPLY_MSG_COUNT" -eq 0 ]] || { log "FAIL: peer route over-fixed into dashboard send_reply path"; exit 1; }
pass_assert

END_MS=$(date +%s%3N)
DURATION_MS=$((END_MS - START_MS))
log "PASS qa-node-04 codex-app-server reply routing"
log "Assertions: $ASSERTIONS/5"
log "Duration_ms: $DURATION_MS"

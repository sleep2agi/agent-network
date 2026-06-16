#!/usr/bin/env bash
set -euo pipefail

export HOME=/tmp/anethome
export COMMHUB_DB=/tmp/commhub-qa18.db
HUB_PORT=9218
HUB_BASE="http://127.0.0.1:$HUB_PORT"
REPORT="/app/docs/tests/report-qa-hub-18-delivery-semantics.md"


# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
cleanup() {
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$(dirname "$REPORT")"
cat > "$REPORT" <<'REPORT'
# qa-hub-18-delivery-semantics

Status: RUNNING
REPORT

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
  local ntok
  ntok=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
    -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
    -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"$alias\"}" | jq -r '.token')
  local arg
  arg=$(jq -nc --arg net "$NET_ID" --arg alias "$alias" --arg resume "$resume" \
    '{resume_id:$resume,alias:$alias,status:"idle",network_id:$net}')
  mcp_call "$ntok" "report_status" "$arg" | jq -e '.ok == true' >/dev/null
  echo "$ntok"
}

task_status() {
  local tid="$1"
  curl -fsS "$HUB_BASE/api/tasks?task_id=$tid&network_id=$NET_ID" \
    -H "Authorization: Bearer $UTOK" | jq -r '.tasks[0].status // empty'
}

task_result() {
  local tid="$1"
  curl -fsS "$HUB_BASE/api/tasks?task_id=$tid&network_id=$NET_ID" \
    -H "Authorization: Bearer $UTOK" | jq -r '.tasks[0].result // empty'
}

echo "[0] start local hub"
safe_rm_rf "$HOME/.commhub" "$HOME/.anet/server" "$COMMHUB_DB"
cd /app/server
HOST=127.0.0.1 PORT="$HUB_PORT" bun run src/index.ts >/tmp/hub.log 2>&1 &
HUB_PID=$!
for _ in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null || { echo "FAIL: hub did not start"; cat /tmp/hub.log; exit 1; }

echo "[1] register user and nodes"
RESP=$(curl -fsS -X POST "$HUB_BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"qa18","password":"StrongPassw0rd!"}')
UTOK=$(echo "$RESP" | jq -r '.token // empty')
NET_ID=$(echo "$RESP" | jq -r '.network_id // empty')
[[ "$UTOK" == utok_* && -n "$NET_ID" ]] || { echo "FAIL: registration"; echo "$RESP"; exit 1; }

LIVE_NTOK=$(register_node "agent-live" "qa18-live")
OFF_NTOK=$(register_node "agent-offline" "qa18-offline")
OFF_ARG=$(jq -nc --arg net "$NET_ID" '{resume_id:"qa18-offline",alias:"agent-offline",status:"offline",network_id:$net}')
mcp_call "$OFF_NTOK" "report_status" "$OFF_ARG" | jq -e '.ok == true' >/dev/null

echo "[2] REST /api/task missing alias returns 404 and no queue"
HTTP_CODE=$(jq -n --arg net "$NET_ID" '{alias:"ghost-rest",task:"missing rest",network_id:$net}' \
  | curl -sS -o /tmp/rest-missing.json -w "%{http_code}" -X POST "$HUB_BASE/api/task" \
      -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' --data-binary @-)
[[ "$HTTP_CODE" == "404" ]] || { echo "FAIL: missing REST code $HTTP_CODE"; cat /tmp/rest-missing.json; exit 1; }
jq -e '.ok == false and .error == "alias_not_found" and .queued == false' /tmp/rest-missing.json >/dev/null

echo "[3] MCP send_task missing alias returns alias_not_found"
ARG=$(jq -nc --arg net "$NET_ID" '{alias:"ghost-mcp",task:"missing mcp",network_id:$net,from_session:"agent-live"}')
MISSING_TASK=$(mcp_call "$LIVE_NTOK" "send_task" "$ARG")
echo "$MISSING_TASK" | jq -e '.ok == false and .error == "alias_not_found" and .queued == false' >/dev/null

echo "[4] REST /api/task offline alias queues but reports alias_offline"
HTTP_CODE=$(jq -n --arg net "$NET_ID" '{alias:"agent-offline",task:"offline rest",network_id:$net}' \
  | curl -sS -o /tmp/rest-offline.json -w "%{http_code}" -X POST "$HUB_BASE/api/task" \
      -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' --data-binary @-)
[[ "$HTTP_CODE" == "202" ]] || { echo "FAIL: offline REST code $HTTP_CODE"; cat /tmp/rest-offline.json; exit 1; }
REST_OFF_ID=$(jq -r '.task_id // empty' /tmp/rest-offline.json)
jq -e '.ok == false and .error == "alias_offline" and .queued == true and (.task_id == .message_id)' /tmp/rest-offline.json >/dev/null
[[ "$(task_status "$REST_OFF_ID")" == "delivered" ]] || { echo "FAIL: offline REST task not queued"; exit 1; }

echo "[5] MCP send_task offline alias queues but reports alias_offline"
ARG=$(jq -nc --arg net "$NET_ID" '{alias:"agent-offline",task:"offline mcp",network_id:$net,from_session:"agent-live"}')
OFF_TASK=$(mcp_call "$LIVE_NTOK" "send_task" "$ARG")
echo "$OFF_TASK" | jq -e '.ok == false and .error == "alias_offline" and .queued == true and .message_id' >/dev/null
OFF_TASK_ID=$(echo "$OFF_TASK" | jq -r '.message_id')
[[ "$(task_status "$OFF_TASK_ID")" == "delivered" ]] || { echo "FAIL: offline MCP task not queued"; exit 1; }

echo "[6] MCP send_message missing/offline semantics"
ARG=$(jq -nc '{alias:"ghost-msg",message:"hello",from_session:"agent-live"}')
mcp_call "$LIVE_NTOK" "send_message" "$ARG" | jq -e '.ok == false and .error == "alias_not_found" and .queued == false' >/dev/null
ARG=$(jq -nc '{alias:"agent-offline",message:"queued hello",from_session:"agent-live"}')
OFF_MSG=$(mcp_call "$LIVE_NTOK" "send_message" "$ARG")
echo "$OFF_MSG" | jq -e '.ok == false and .error == "alias_offline" and .queued == true and .message_id' >/dev/null
ARG=$(jq -nc '{alias:"agent-offline",limit:20}')
mcp_call "$OFF_NTOK" "get_inbox" "$ARG" | jq -e '[.messages[] | select(.content=="queued hello")] | length == 1' >/dev/null

echo "[7] send_reply missing task is structured error"
ARG=$(jq -nc '{alias:"agent-live",text:"ghost reply",in_reply_to:"missing-task-id",status:"replied",from_session:"agent-live"}')
mcp_call "$LIVE_NTOK" "send_reply" "$ARG" | jq -e '.ok == false and .error == "reply_task_not_found" and .reply_queued == false' >/dev/null

echo "[8] send_reply terminal task is structured error and does not overwrite"
LIVE_SEND=$(jq -n --arg net "$NET_ID" '{alias:"agent-live",task:"reply once",network_id:$net}' \
  | curl -fsS -X POST "$HUB_BASE/api/task" \
      -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' --data-binary @-)
LIVE_TASK_ID=$(echo "$LIVE_SEND" | jq -r '.task_id')
ARG=$(jq -nc --arg tid "$LIVE_TASK_ID" '{alias:"qa18",text:"first",in_reply_to:$tid,status:"replied",from_session:"agent-live"}')
mcp_call "$LIVE_NTOK" "send_reply" "$ARG" | jq -e '.ok == true' >/dev/null
[[ "$(task_result "$LIVE_TASK_ID")" == "first" ]] || { echo "FAIL: first reply not applied"; exit 1; }
ARG=$(jq -nc --arg tid "$LIVE_TASK_ID" '{alias:"qa18",text:"second",in_reply_to:$tid,status:"replied",from_session:"agent-live"}')
TERM_REPLY=$(mcp_call "$LIVE_NTOK" "send_reply" "$ARG")
echo "$TERM_REPLY" | jq -e '.ok == false and .error == "reply_task_terminal" and .reply_queued == false and .task_status == "replied"' >/dev/null
[[ "$(task_result "$LIVE_TASK_ID")" == "first" ]] || { echo "FAIL: terminal reply overwrote result"; exit 1; }

cat > "$REPORT" <<REPORT
# qa-hub-18-delivery-semantics

Status: PASS

Verified:

- REST /api/task missing alias returns 404 alias_not_found and does not queue.
- MCP send_task missing alias returns alias_not_found and does not queue.
- REST /api/task offline alias returns 202 alias_offline with queued=true and task_id/message_id.
- MCP send_task offline alias returns alias_offline with queued=true and writes task.
- MCP send_message missing/offline aliases report alias_not_found vs alias_offline.
- send_reply missing task returns reply_task_not_found.
- send_reply terminal task returns reply_task_terminal and does not overwrite result.
REPORT

echo "PASS qa-hub-18-delivery-semantics"

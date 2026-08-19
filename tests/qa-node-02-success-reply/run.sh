#!/usr/bin/env bash
# qa-node-02-success-reply — agent-node 成功回复路径
# 用户故事：admin 给 agent 派 task → agent 处理完用 send_reply 回 → task 状态变 'replied' + result 落库
# 用 mock-via-MCP（直接 curl 打 send_reply）代替真 agent + 真 LLM，性价比远高于 e2e。
set -euo pipefail
# 绑了还要看得见（#1092）：报告里没有这一行，就没法把这次运行钉到某个提交上。
printf 'source_commit=%s\n' "${SOURCE_COMMIT:-unknown}"

export HOME=/tmp/anethome

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
mkdir -p "$HOME" /tmp/work
cd /tmp/work

ADMIN_PW="StrongPassw0rd"
HUB_PORT=9200
HUB_BASE="http://127.0.0.1:$HUB_PORT"

cleanup() { kill "${HUB_PID:-0}" 2>/dev/null || true; }
trap cleanup EXIT

npm install -g @sleep2agi/agent-network@preview >/tmp/npm-install.log 2>&1
anet -v >/dev/null

# MCP helper — POST /mcp tools/call, unwrap SSE-framed response, return tool .result.content[0].text JSON
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

echo "[0] start hub"
safe_rm_rf "$HOME/.anet/server" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$HUB_BASE/health" >/dev/null

echo "[1] login admin → UTOK"
UTOK=""
for i in {1..20}; do
  LOGIN_RESP=$(curl -sS -X POST "$HUB_BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}")
  UTOK=$(echo "$LOGIN_RESP" | jq -r '.token // empty')
  [[ "$UTOK" == utok_* ]] && break
  sleep 0.5
done
if [[ "$UTOK" != utok_* ]]; then
  echo "FAIL: admin login never returned utok. last response:"; echo "$LOGIN_RESP"
  echo "--- hub.log tail ---"; tail -40 /tmp/hub.log
  exit 1
fi

echo "[2] admin creates network → NET_ID"
NET_RESP=$(curl -sS -X POST "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d '{"name":"node02-net"}')
NET_ID=$(echo "$NET_RESP" | jq -r '.network.network_id // .network_id // empty')
[[ -n "$NET_ID" ]] || { echo "FAIL: no network_id, resp=$NET_RESP"; exit 1; }
echo "  network_id=$NET_ID"

echo "[3] mint NTOK for mock agent (alias=mock-echo)"
NTOK_RESP=$(curl -sS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"mock-echo\"}")
NTOK=$(echo "$NTOK_RESP" | jq -r '.token // empty')
[[ "$NTOK" == ntok_* ]] || { echo "FAIL: ntok shape, resp=$NTOK_RESP"; exit 1; }

echo "[4] mock agent reports idle (registers session row)"
ARG=$(jq -nc --arg net "$NET_ID" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-000000000006",alias:"mock-echo",status:"idle",network_id:$net}')
RS=$(mcp_call "$NTOK" "report_status" "$ARG")
echo "$RS" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status not ok: $RS"; exit 1; }

echo "[5] admin sends task to mock-echo"
TASK_RESP=$(curl -fsS -X POST "$HUB_BASE/api/task" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"mock-echo\",\"task\":\"ping-r6\",\"priority\":\"normal\",\"network_id\":\"$NET_ID\",\"from\":\"admin\"}")
TASK_ID=$(echo "$TASK_RESP" | jq -r '.message_id')
[[ -n "$TASK_ID" && "$TASK_ID" != "null" ]] || { echo "FAIL: no task id, resp=$TASK_RESP"; exit 1; }
echo "  task_id=$TASK_ID"

echo "[6] verify task state 'delivered' before reply"
PRE=$(curl -fsS "$HUB_BASE/api/tasks?task_id=$TASK_ID&network_id=$NET_ID" \
  -H "Authorization: Bearer $UTOK" | jq -r '.tasks[0].status')
[[ "$PRE" == "delivered" ]] || { echo "FAIL: pre-reply status should be delivered, got $PRE"; exit 1; }

echo "[7] mock agent sends success reply via MCP"
REPLY_TEXT="pong-r6 success-path"
ARG=$(jq -nc --arg alias "admin" --arg t "$REPLY_TEXT" --arg irt "$TASK_ID" \
  '{alias:$alias,text:$t,in_reply_to:$irt,status:"replied",from_session:"mock-echo"}')
SR=$(mcp_call "$NTOK" "send_reply" "$ARG")
echo "$SR" | jq -e '.ok == true' >/dev/null || { echo "FAIL: send_reply not ok: $SR"; exit 1; }

echo "[8] verify task state 'replied' + result text matches"
sleep 0.2  # write+read race insurance
ROW=$(curl -fsS "$HUB_BASE/api/tasks?task_id=$TASK_ID&network_id=$NET_ID" \
  -H "Authorization: Bearer $UTOK")
STATUS=$(echo "$ROW" | jq -r '.tasks[0].status')
RESULT=$(echo "$ROW" | jq -r '.tasks[0].result')
COMPLETED=$(echo "$ROW" | jq -r '.tasks[0].completed_at')
[[ "$STATUS" == "replied" ]] || { echo "FAIL: status should be replied, got $STATUS"; exit 1; }
[[ "$RESULT" == "$REPLY_TEXT" ]] || { echo "FAIL: result mismatch. got '$RESULT' expected '$REPLY_TEXT'"; exit 1; }
[[ "$COMPLETED" != "null" && -n "$COMPLETED" ]] || { echo "FAIL: completed_at not set"; exit 1; }

echo "[9] verify reply lands in /api/messages for admin (visibility from sender side)"
MSG_COUNT=$(curl -fsS "$HUB_BASE/api/messages?limit=20" -H "Authorization: Bearer $UTOK" \
  | jq "[.messages[] | select(.content==\"$REPLY_TEXT\")] | length")
[[ "$MSG_COUNT" -ge 1 ]] || { echo "FAIL: reply not in /api/messages"; exit 1; }

echo "PASS qa-node-02 success-reply (delivered → send_reply → replied + result + completed_at + visibility)"

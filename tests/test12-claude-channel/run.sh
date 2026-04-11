#!/bin/bash

PASS=0
FAIL=0
BASE="http://127.0.0.1:9200"
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
TMP="/tmp/test12-claude-channel"
mkdir -p "$TMP"

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

json_get() {
  python3 -c 'import json,sys; data=json.load(sys.stdin); path=sys.argv[1].split("."); cur=data
for key in path:
    if isinstance(cur, dict):
        cur=cur.get(key, "")
    elif isinstance(cur, list) and key.isdigit():
        idx=int(key); cur=cur[idx] if idx < len(cur) else ""
    else:
        cur=""
        break
print("" if cur is None else cur)' "$1" 2>/dev/null
}

rest() {
  curl -s -H "$REST_AUTH" "$@"
}

mcp_call() {
  local tool="$1"
  local args="$2"
  timeout 10 curl -s -X POST "${BASE}/mcp" \
    -H "Authorization: Bearer ${NTOK}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"t\",\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":${args}}}" 2>/dev/null || true
}

echo ""
echo "═══ Test 12: Claude Channel via CommHub ═══"
echo ""

echo "1. Start CommHub server"
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" bun run src/index.ts >"${TMP}/server.log" 2>&1 &
sleep 4
curl -s "${BASE}/health" | grep -q '"ok":true' && pass "server started" || fail "server start"
echo ""

echo "2. Register user + get ntok_"
REG=$(curl -s -X POST "${BASE}/api/auth/register" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"username":"claudeuser","password":"pass123456"}')
echo "$REG" | grep -q '"ok":true' && pass "user registered" || fail "user register"
UTOK=$(echo "$REG" | json_get "token")
NTOK=$(echo "$REG" | json_get "network_token")
NET_ID=$(echo "$REG" | json_get "network_id")
REST_AUTH="Authorization: Bearer ${UTOK}"
echo "$NTOK" | grep -q '^ntok_' && pass "network token issued" || fail "ntok missing"
[ -n "$NET_ID" ] && pass "network_id available" || fail "network_id missing"
echo ""

echo "3. Agent register via MCP report_status"
REG_STATUS=$(mcp_call "report_status" "{\"resume_id\":\"claude-chan-1\",\"alias\":\"claude-agent\",\"agent\":\"claude-code\",\"status\":\"idle\",\"network_id\":\"${NET_ID}\"}")
echo "$REG_STATUS" | grep -q 'ok\\":true' && pass "report_status idle" || { echo "$REG_STATUS"; fail "report_status idle"; }
sleep 1
rest "${BASE}/api/status?network_id=${NET_ID}" | grep -q '"alias":"claude-agent"' && pass "claude-agent visible in status" || fail "claude-agent status missing"
echo ""

echo "4. SSE connect"
timeout 3 curl -i -N -s \
  -H "Authorization: Bearer ${NTOK}" \
  "${BASE}/events/claude-agent" >"${TMP}/sse.log" 2>&1 &
sleep 1
grep -q 'HTTP/1.1 200' "${TMP}/sse.log" && pass "SSE returned 200" || fail "SSE missing 200"
grep -qi 'text/event-stream' "${TMP}/sse.log" && pass "SSE content-type" || fail "SSE content-type missing"
echo ""

echo "5. send_task to claude-agent"
SEND=$(mcp_call "send_task" "{\"alias\":\"claude-agent\",\"task\":\"Claude channel test task\",\"from_session\":\"orchestrator\",\"network_id\":\"${NET_ID}\"}")
echo "$SEND" | grep -q 'ok\\":true' && pass "send_task accepted" || { echo "$SEND"; fail "send_task"; }
sleep 1
grep -q '"type":"new_task"' "${TMP}/sse.log" && pass "SSE received new_task" || { cat "${TMP}/sse.log"; fail "SSE new_task missing"; }
echo ""

echo "6. Agent inbox"
INBOX=$(mcp_call "get_inbox" "{\"alias\":\"claude-agent\",\"limit\":5,\"network_id\":\"${NET_ID}\"}")
echo "$INBOX" | grep -q 'Claude channel test task' && pass "get_inbox has task" || { echo "$INBOX"; fail "get_inbox missing task"; }
TASK_ID=$(rest "${BASE}/api/tasks?network_id=${NET_ID}" | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data.get("tasks",[{}])[0].get("task_id",""))' 2>/dev/null)
[ -n "$TASK_ID" ] && pass "task_id captured" || fail "task_id missing"
echo ""

echo "7. Agent reply"
REPLY=$(mcp_call "send_reply" "{\"alias\":\"orchestrator\",\"text\":\"Claude Code reply\",\"in_reply_to\":\"${TASK_ID}\",\"status\":\"replied\",\"from_session\":\"claude-agent\",\"network_id\":\"${NET_ID}\"}")
echo "$REPLY" | grep -q 'ok\\":true' && pass "send_reply accepted" || { echo "$REPLY"; fail "send_reply"; }
sleep 1
TASKS=$(rest "${BASE}/api/tasks?network_id=${NET_ID}")
echo "$TASKS" | grep -q '"status":"replied"' && pass "task status replied" || { echo "$TASKS"; fail "task not replied"; }
echo ""

echo "8. API status online"
STATUS_ONLINE=$(rest "${BASE}/api/status?network_id=${NET_ID}")
echo "$STATUS_ONLINE" | grep -q '"alias":"claude-agent"' && echo "$STATUS_ONLINE" | grep -q '"status":"idle"' && pass "/api/status shows claude-agent online" || { echo "$STATUS_ONLINE"; fail "/api/status online"; }
echo ""

echo "9. Agent offline"
OFFLINE=$(mcp_call "report_status" "{\"resume_id\":\"claude-chan-1\",\"alias\":\"claude-agent\",\"agent\":\"claude-code\",\"status\":\"offline\",\"network_id\":\"${NET_ID}\"}")
echo "$OFFLINE" | grep -q 'ok\\":true' && pass "report_status offline" || { echo "$OFFLINE"; fail "report_status offline"; }
sleep 1
STATUS_OFFLINE=$(rest "${BASE}/api/status?network_id=${NET_ID}")
echo "$STATUS_OFFLINE" | grep -q '"alias":"claude-agent"' && echo "$STATUS_OFFLINE" | grep -q '"status":"offline"' && pass "/api/status shows offline" || { echo "$STATUS_OFFLINE"; fail "/api/status offline"; }
echo ""

echo "═══════════════════════════════════"
echo "  Test 12 Result: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1

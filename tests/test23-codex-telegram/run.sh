#!/bin/bash

PASS=0
FAIL=0
BASE="http://127.0.0.1:9200"
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
TMP="/tmp/test23-codex-telegram"
WORKDIR="/tmp/test23-work"
mkdir -p "$TMP" "$WORKDIR/.anet/nodes/codex-commander/channels/telegram"

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
  local token="$1"
  local tool="$2"
  local args="$3"
  timeout 10 curl -s -X POST "${BASE}/mcp" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"t\",\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":${args}}}" 2>/dev/null || true
}

task_id_by_content() {
  local needle="$1"
  rest "${BASE}/api/tasks?network_id=${NET_ID}" | python3 -c 'import json,sys; data=json.load(sys.stdin); needle=sys.argv[1]
for t in data.get("tasks", []):
    if t.get("content") == needle:
        print(t.get("task_id",""))
        break' "$needle" 2>/dev/null
}

wait_for_status() {
  local alias="$1"
  local expected="$2"
  local tries="${3:-10}"
  local i
  for i in $(seq 1 "$tries"); do
    STATUS_JSON=$(rest "${BASE}/api/status?network_id=${NET_ID}")
    if echo "$STATUS_JSON" | grep -q "\"alias\":\"${alias}\"" && echo "$STATUS_JSON" | grep -q "\"status\":\"${expected}\""; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo ""
echo "═══ Test 23: Codex + Telegram Command Room ═══"
echo ""

echo "1. Start CommHub server"
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" bun run src/index.ts >"${TMP}/server.log" 2>&1 &
sleep 4
curl -s "${BASE}/health" | grep -q '"ok":true' && pass "server started" || fail "server start"
echo ""

echo "2. Register user + create ntok_"
REG=$(curl -s -X POST "${BASE}/api/auth/register" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"username":"codextg","password":"pass123456"}')
echo "$REG" | grep -q '"ok":true' && pass "user registered" || fail "user register"
UTOK=$(echo "$REG" | json_get "token")
NTOK=$(echo "$REG" | json_get "network_token")
NET_ID=$(echo "$REG" | json_get "network_id")
REST_AUTH="Authorization: Bearer ${UTOK}"
echo "$NTOK" | grep -q '^ntok_' && pass "network token issued" || fail "network token missing"
[ -n "$NET_ID" ] && pass "network id ready" || fail "network id missing"
echo ""

echo "3. Create codex-sdk node config + telegram channel config"
cat > "${WORKDIR}/.anet/nodes/codex-commander/config.json" <<EOF
{
  "node_id": "node-codex-001",
  "node_name": "codex-commander",
  "alias": "codex-commander",
  "runtime": "codex-sdk",
  "model": "gpt-5.5",
  "network_id": "${NET_ID}",
  "token": "${NTOK}",
  "hub": "${BASE}",
  "channels": ["telegram"]
}
EOF
cat > "${WORKDIR}/.anet/nodes/codex-commander/channels/telegram/.env" <<EOF
TELEGRAM_BOT_TOKEN=123456:fake-bot-token
EOF
cat > "${WORKDIR}/.anet/nodes/codex-commander/channels/telegram/access.json" <<EOF
{"allow":["7612221352"]}
EOF
[ -f "${WORKDIR}/.anet/nodes/codex-commander/config.json" ] && pass "node config written" || fail "node config missing"
[ -f "${WORKDIR}/.anet/nodes/codex-commander/channels/telegram/.env" ] && [ -f "${WORKDIR}/.anet/nodes/codex-commander/channels/telegram/access.json" ] && pass "telegram channel config written" || fail "telegram channel config missing"
echo ""

echo "4. Register codex agent to CommHub (simulate agent-node startup)"
AGENT_STATUS=$(mcp_call "${NTOK}" "report_status" "{\"resume_id\":\"codex-session-1\",\"alias\":\"codex-commander\",\"agent\":\"agent-node:codex\",\"status\":\"idle\",\"node_id\":\"node-codex-001\",\"node_name\":\"codex-commander\",\"session_id\":\"sess-codex-1\",\"config_path\":\"${WORKDIR}/.anet/nodes/codex-commander/config.json\",\"channels\":\"[\\\"telegram\\\"]\",\"model\":\"gpt-5.5\",\"network_id\":\"${NET_ID}\"}")
echo "$AGENT_STATUS" | grep -q 'ok\\":true' && pass "codex agent report_status ok" || { echo "$AGENT_STATUS"; fail "codex agent report_status"; }
if wait_for_status "codex-commander" "idle" 10; then
  pass "codex agent online"
else
  cat "${TMP}/server.log"
  fail "codex agent not online"
fi
STATUS_JSON=$(rest "${BASE}/api/status?network_id=${NET_ID}")
echo "$STATUS_JSON" | python3 -c 'import json,sys; data=json.load(sys.stdin); ok=False
for s in data.get("sessions", []):
    if s.get("alias") == "codex-commander" and s.get("channels") == "[\"telegram\"]":
        ok=True
print("ok" if ok else "fail")' 2>/dev/null | grep -q '^ok$' && pass "status shows telegram channel" || { echo "$STATUS_JSON"; fail "status missing telegram channel"; }
echo ""

echo "5. Register receiver agent"
RECV_STATUS=$(mcp_call "${NTOK}" "report_status" "{\"resume_id\":\"worker-session-1\",\"alias\":\"worker-agent\",\"agent\":\"agent-node:codex\",\"status\":\"idle\",\"node_id\":\"node-worker-001\",\"node_name\":\"worker-agent\",\"session_id\":\"sess-worker-1\",\"channels\":\"[]\",\"model\":\"gpt-5.5-mini\",\"network_id\":\"${NET_ID}\"}")
echo "$RECV_STATUS" | grep -q 'ok\\":true' && pass "receiver report_status ok" || { echo "$RECV_STATUS"; fail "receiver report_status"; }
echo ""

echo "6. Simulate Telegram inbound -> agent receives task"
SEND1=$(mcp_call "${NTOK}" "send_task" "{\"alias\":\"codex-commander\",\"task\":\"Telegram user: 请总结今天任务\",\"from_session\":\"telegram:7612221352\",\"network_id\":\"${NET_ID}\"}")
echo "$SEND1" | grep -q 'ok\\":true' && pass "telegram task dispatched" || { echo "$SEND1"; fail "telegram task dispatch"; }
sleep 1
INBOX1=$(mcp_call "${NTOK}" "get_inbox" "{\"alias\":\"codex-commander\",\"limit\":5}")
echo "$INBOX1" | grep -q 'Telegram user: 请总结今天任务' && pass "codex agent received telegram task" || { echo "$INBOX1"; fail "codex agent inbox missing task"; }
TASK1=$(task_id_by_content "Telegram user: 请总结今天任务")
[ -n "$TASK1" ] && pass "telegram task id captured" || fail "telegram task id missing"
echo ""

echo "7. Agent replies after processing"
REPLY1=$(mcp_call "${NTOK}" "send_reply" "{\"alias\":\"telegram:7612221352\",\"text\":\"已收到，今天重点是测试、修文档、回归验证。\",\"in_reply_to\":\"${TASK1}\",\"status\":\"replied\",\"from_session\":\"codex-commander\"}")
echo "$REPLY1" | grep -q 'ok\\":true' && pass "send_reply ok" || { echo "$REPLY1"; fail "send_reply failed"; }
sleep 1
TASKS1=$(rest "${BASE}/api/tasks?network_id=${NET_ID}")
echo "$TASKS1" | grep -q "\"task_id\":\"${TASK1}\"" && echo "$TASKS1" | grep -q '"status":"replied"' && pass "telegram task marked replied" || { echo "$TASKS1"; fail "telegram task not replied"; }
echo ""

echo "8. Agent sends task to another agent"
SEND2=$(mcp_call "${NTOK}" "send_task" "{\"alias\":\"worker-agent\",\"task\":\"请把今日任务总结整理成三点\",\"from_session\":\"codex-commander\",\"network_id\":\"${NET_ID}\"}")
echo "$SEND2" | grep -q 'ok\\":true' && pass "agent can send task to peer" || { echo "$SEND2"; fail "agent send_task to peer failed"; }
sleep 1
INBOX2=$(mcp_call "${NTOK}" "get_inbox" "{\"alias\":\"worker-agent\",\"limit\":5}")
echo "$INBOX2" | grep -q '请把今日任务总结整理成三点' && pass "peer agent received task" || { echo "$INBOX2"; fail "peer inbox missing task"; }
TASK2=$(task_id_by_content "请把今日任务总结整理成三点")
[ -n "$TASK2" ] && pass "peer task id captured" || fail "peer task id missing"
echo ""

echo "9. Peer replies back to codex agent"
REPLY2=$(mcp_call "${NTOK}" "send_reply" "{\"alias\":\"codex-commander\",\"text\":\"三点总结已整理完成。\",\"in_reply_to\":\"${TASK2}\",\"status\":\"replied\",\"from_session\":\"worker-agent\"}")
echo "$REPLY2" | grep -q 'ok\\":true' && pass "peer send_reply ok" || { echo "$REPLY2"; fail "peer send_reply failed"; }
sleep 1
TASKS2=$(rest "${BASE}/api/tasks?network_id=${NET_ID}")
echo "$TASKS2" | grep -q "\"task_id\":\"${TASK2}\"" && echo "$TASKS2" | grep -q '"status":"replied"' && pass "peer task marked replied" || { echo "$TASKS2"; fail "peer task not replied"; }
CODER_INBOX=$(mcp_call "${NTOK}" "get_inbox" "{\"alias\":\"codex-commander\",\"limit\":10}")
echo "$CODER_INBOX" | grep -q '三点总结已整理完成' && pass "codex agent received peer reply" || { echo "$CODER_INBOX"; fail "codex agent missing peer reply"; }
echo ""

echo "10. Final status checks"
FINAL_STATUS=$(rest "${BASE}/api/status?network_id=${NET_ID}")
echo "$FINAL_STATUS" | grep -q '"alias":"codex-commander"' && echo "$FINAL_STATUS" | grep -q '"status":"idle"' && pass "codex agent still online" || { echo "$FINAL_STATUS"; fail "codex agent offline unexpectedly"; }
echo "$FINAL_STATUS" | grep -q '"alias":"worker-agent"' && pass "peer agent visible in status" || { echo "$FINAL_STATUS"; fail "peer agent missing in status"; }
echo ""

echo "═══════════════════════════════════"
echo "  Test 23 Result: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1

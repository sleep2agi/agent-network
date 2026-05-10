#!/bin/bash

PASS=0
FAIL=0
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
WORKDIR="/tmp/test19"
BASE="http://127.0.0.1:9200"
SERVER_LOG="${WORKDIR}/server.log"
NODE_LOG="${WORKDIR}/agent-b.log"

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

json_get() {
  local expr="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); print($expr)" 2>/dev/null
}

api_json() {
  local method="$1"
  local url="$2"
  local auth="$3"
  local body="${4:-}"
  if [ -n "$body" ]; then
    curl -s -X "$method" "$url" -H "$auth" -H "Content-Type: application/json" -d "$body"
  else
    curl -s -X "$method" "$url" -H "$auth"
  fi
}

mcp_call() {
  local token="$1"
  local tool="$2"
  local args="$3"
  curl -s -X POST "$BASE/mcp" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"test19\",\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":${args}}}"
}

mcp_ok() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
for line in raw.strip().split("\n"):
    if line.startswith("data: "):
        raw = line[6:]
try:
    doc = json.loads(raw)
    text = doc.get("result", {}).get("content", [{}])[0].get("text", "{}")
    payload = json.loads(text)
    print("true" if payload.get("ok") else "false")
except Exception:
    print("false")
'
}

cleanup() {
  kill "${AGENT_PID:-}" 2>/dev/null || true
  wait "${AGENT_PID:-}" 2>/dev/null || true
  kill "${SERVER_PID:-}" 2>/dev/null || true
  wait "${SERVER_PID:-}" 2>/dev/null || true
}

trap cleanup EXIT

mkdir -p "${WORKDIR}/.anet/nodes/agent-b"

echo ""
echo "========================================="
echo "  Real Collaboration + Reconnect Test"
echo "========================================="
echo ""

echo "A1. Start server..."
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" bun run src/index.ts >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
sleep 3
HEALTH=$(curl -s "$BASE/health" 2>/dev/null)
echo "$HEALTH" | grep -q '"ok":true' && pass "server started" || { cat "${SERVER_LOG}"; fail "server failed"; exit 1; }
echo ""

echo "A2. User A register + create network + ntok + invite..."
REG_A=$(curl -s -X POST "$BASE/api/auth/register" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"username":"collab_a","password":"pass123456","email":"a@example.com"}')
echo "$REG_A" | grep -q '"ok":true' && pass "user A registered" || fail "user A register failed"
UTOK_A=$(echo "$REG_A" | json_get "data.get('token','')")
AUTH_A="Authorization: Bearer ${UTOK_A}"
NET_CREATE=$(api_json POST "$BASE/api/networks" "$AUTH_A" '{"name":"team-collab","description":"real collab network"}')
TEAM_NET_ID=$(echo "$NET_CREATE" | json_get "data.get('network_id','')")
echo "$NET_CREATE" | grep -q '"ok":true' && [ -n "$TEAM_NET_ID" ] && pass "user A created network" || { echo "$NET_CREATE"; fail "user A create network failed"; }
NODE_A=$(api_json POST "$BASE/api/auth/node-token" "$AUTH_A" "{\"network_id\":\"${TEAM_NET_ID}\",\"node_name\":\"agent-a\"}")
NTOK_A=$(echo "$NODE_A" | json_get "data.get('token','')")
echo "$NODE_A" | grep -q '"ok":true' && echo "$NTOK_A" | grep -q '^ntok_' && pass "user A created ntok" || { echo "$NODE_A"; fail "user A ntok failed"; }
INV=$(api_json POST "$BASE/api/networks/${TEAM_NET_ID}/invite" "$AUTH_A" '{"role":"member","max_uses":1}')
INVITE_CODE=$(echo "$INV" | json_get "data.get('invite_code','')")
echo "$INV" | grep -q '"ok":true' && [ -n "$INVITE_CODE" ] && pass "invite created" || { echo "$INV"; fail "invite create failed"; }
echo ""

echo "A3. User B register + join by invite..."
REG_B=$(curl -s -X POST "$BASE/api/auth/register" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"username":"collab_b","password":"pass123456","email":"b@example.com"}')
echo "$REG_B" | grep -q '"ok":true' && pass "user B registered" || fail "user B register failed"
UTOK_B=$(echo "$REG_B" | json_get "data.get('token','')")
AUTH_B="Authorization: Bearer ${UTOK_B}"
JOIN=$(api_json POST "$BASE/api/networks/join" "$AUTH_B" "{\"invite_code\":\"${INVITE_CODE}\"}")
JOIN_NET_ID=$(echo "$JOIN" | json_get "data.get('network_id','')")
echo "$JOIN" | grep -q '"ok":true' && [ "$JOIN_NET_ID" = "$TEAM_NET_ID" ] && pass "user B joined A network" || { echo "$JOIN"; fail "user B join failed"; }
NODE_B=$(api_json POST "$BASE/api/auth/node-token" "$AUTH_B" "{\"network_id\":\"${TEAM_NET_ID}\",\"node_name\":\"agent-b\"}")
NTOK_B=$(echo "$NODE_B" | json_get "data.get('token','')")
echo "$NODE_B" | grep -q '"ok":true' && echo "$NTOK_B" | grep -q '^ntok_' && pass "user B created ntok" || { echo "$NODE_B"; fail "user B ntok failed"; }
echo ""

echo "A4. Start B agent-node in http-api mode..."
cat > "${WORKDIR}/.anet/nodes/agent-b/config.json" <<EOF
{
  "alias": "agent-b",
  "node_name": "agent-b",
  "node_id": "n_test19agentb",
  "runtime": "http-api",
  "model": "gpt-4o-mini",
  "hub": "${BASE}",
  "token": "${NTOK_B}",
  "network_id": "${TEAM_NET_ID}"
}
EOF
cd "${WORKDIR}"
timeout 18 agent-node --config "${WORKDIR}/.anet/nodes/agent-b/config.json" --alias agent-b --runtime http-api >"${NODE_LOG}" 2>&1 &
AGENT_PID=$!
sleep 4
grep -q "启动" "${NODE_LOG}" && pass "agent-node started" || { cat "${NODE_LOG}"; fail "agent-node did not start"; }
grep -q "SSE connected" "${NODE_LOG}" && pass "initial SSE connected" || { cat "${NODE_LOG}"; fail "initial SSE missing"; }
echo ""

echo "A5. User A sends task to B agent..."
REPORT_A=$(mcp_call "$NTOK_A" "report_status" "{\"resume_id\":\"agent-a-resume\",\"alias\":\"agent-a\",\"status\":\"idle\",\"network_id\":\"${TEAM_NET_ID}\"}")
[ "$(echo "$REPORT_A" | mcp_ok)" = "true" ] && pass "agent A session registered" || { echo "$REPORT_A"; fail "agent A register failed"; }
TASK_TEXT="collab task from user A"
SEND=$(mcp_call "$NTOK_A" "send_task" "{\"alias\":\"agent-b\",\"task\":\"${TASK_TEXT}\",\"from_session\":\"agent-a\",\"network_id\":\"${TEAM_NET_ID}\"}")
[ "$(echo "$SEND" | mcp_ok)" = "true" ] && pass "user A sent task to B" || { echo "$SEND"; fail "send_task failed"; }
sleep 3
grep -q "← SSE new_task" "${NODE_LOG}" && pass "B agent received SSE task event" || { cat "${NODE_LOG}"; fail "B agent did not receive SSE event"; }
grep -q "${TASK_TEXT}" "${NODE_LOG}" && pass "B agent received task payload" || { cat "${NODE_LOG}"; fail "B agent task payload missing"; }
echo ""

echo "A6. /api/status shows both users' agents..."
STATUS_JSON=$(api_json GET "$BASE/api/status?network_id=${TEAM_NET_ID}" "$AUTH_A")
STATUS_CHECK=$(echo "$STATUS_JSON" | python3 -c '
import json, sys
doc = json.load(sys.stdin)
aliases = {s.get("alias") for s in doc.get("sessions", [])}
print("ok" if {"agent-a", "agent-b"}.issubset(aliases) else ",".join(sorted(a for a in aliases if a)))
')
[ "$STATUS_CHECK" = "ok" ] && pass "status shows agent-a and agent-b" || { echo "$STATUS_JSON"; fail "status missing agents (${STATUS_CHECK})"; }
echo ""

echo "B1. Kill B agent and wait 3s..."
kill "${AGENT_PID}" 2>/dev/null || true
wait "${AGENT_PID}" 2>/dev/null || true
sleep 3
pass "agent-node stopped"
echo ""

echo "B2. Restart B agent with same config..."
timeout 18 agent-node --config "${WORKDIR}/.anet/nodes/agent-b/config.json" --alias agent-b --runtime http-api >>"${NODE_LOG}" 2>&1 &
AGENT_PID=$!
sleep 4
RESTART_COUNT=$(grep -c "已注册到 CommHub" "${NODE_LOG}" || true)
SSE_COUNT=$(grep -c "SSE connected" "${NODE_LOG}" || true)
[ "$RESTART_COUNT" -ge 2 ] && pass "agent re-registered after restart" || { cat "${NODE_LOG}"; fail "agent did not re-register"; }
[ "$SSE_COUNT" -ge 2 ] && pass "SSE reconnected after restart" || { cat "${NODE_LOG}"; fail "SSE did not reconnect"; }
echo ""

echo "B3. Verify agent online again..."
STATUS_B=$(api_json GET "$BASE/api/status?network_id=${TEAM_NET_ID}" "$AUTH_A" | python3 -c '
import json, sys
doc = json.load(sys.stdin)
s = next((x for x in doc.get("sessions", []) if x.get("alias") == "agent-b"), None)
print(s.get("status", "") if s else "")
')
[ "$STATUS_B" = "idle" ] && pass "agent-b online after restart" || { cat "${NODE_LOG}"; fail "agent-b not online after restart (status=${STATUS_B:-missing})"; }
echo ""

echo "========================================="
echo "Result: ${PASS} passed, ${FAIL} failed"
echo "========================================="

[ "${FAIL}" -eq 0 ]

#!/bin/bash

PASS=0
FAIL=0
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
WORKDIR="/tmp/test14"
NODE_LOG="${WORKDIR}/agent-node.log"

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

api_curl() {
  curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "$@"
}

mcp_call() {
  local tool="$1"
  local args="$2"
  curl -s -X POST http://127.0.0.1:9200/mcp \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"test14\",\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":${args}}}"
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

echo ""
echo "========================================="
echo "  agent-node Real Integration Test"
echo "========================================="
echo ""

mkdir -p "${WORKDIR}/.anet/nodes/real-bot"

echo "1. Starting server with COMMHUB_AUTH_TOKEN..."
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" bun run src/index.ts >/tmp/test14-server.log 2>&1 &
SERVER_PID=$!
sleep 3
HEALTH=$(curl -s http://127.0.0.1:9200/health 2>/dev/null)
echo "$HEALTH" | grep -q '"ok":true' && pass "server started" || { cat /tmp/test14-server.log; fail "server failed"; }
echo ""

echo "2. Register user and create ntok_..."
REGISTER=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"realbotuser","password":"test123456","email":"realbot@example.com"}')
echo "$REGISTER" | grep -q '"ok":true' && pass "register succeeded" || fail "register failed"
UTOK=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
NET_ID=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('network_id',''))")
[ -n "$UTOK" ] && pass "utok received" || fail "utok missing"
[ -n "$NET_ID" ] && pass "network_id received" || fail "network_id missing"
NODE_TOKEN_RESP=$(curl -s -X POST http://127.0.0.1:9200/api/auth/node-token \
  -H "Authorization: Bearer ${UTOK}" \
  -H "Content-Type: application/json" \
  -d "{\"network_id\":\"${NET_ID}\",\"node_name\":\"real-bot\"}")
echo "$NODE_TOKEN_RESP" | grep -q '"ok":true' && pass "node-token created" || { echo "$NODE_TOKEN_RESP"; fail "node-token failed"; }
NTOK=$(echo "$NODE_TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
[ -n "$NTOK" ] && echo "$NTOK" | grep -q '^ntok_' && pass "ntok received" || fail "ntok missing"
echo ""

echo "3. Writing config.json for agent-node..."
cat > "${WORKDIR}/.anet/nodes/real-bot/config.json" <<EOF
{
  "alias": "real-bot",
  "node_name": "real-bot",
  "node_id": "n_test14realbot",
  "runtime": "http-api",
  "model": "gpt-4o-mini",
  "hub": "http://127.0.0.1:9200",
  "token": "${NTOK}",
  "network_id": "${NET_ID}"
}
EOF
[ -f "${WORKDIR}/.anet/nodes/real-bot/config.json" ] && pass "config.json written" || fail "config.json missing"
echo ""

echo "4. Starting real agent-node..."
cd "${WORKDIR}"
timeout 10 agent-node --config "${WORKDIR}/.anet/nodes/real-bot/config.json" --alias real-bot --runtime http-api >"${NODE_LOG}" 2>&1 &
AGENT_PID=$!
sleep 4
grep -q "启动" "${NODE_LOG}" && pass "agent-node started" || { cat "${NODE_LOG}"; fail "agent-node did not start"; }
echo ""

echo "5. Verify /api/status shows real-bot online..."
STATUS_ONLINE=$(api_curl http://127.0.0.1:9200/api/status | python3 -c "
import sys, json
doc = json.load(sys.stdin)
s = next((x for x in doc.get('sessions', []) if x.get('alias') == 'real-bot'), None)
print(s.get('status', '') if s else '')
")
[ "$STATUS_ONLINE" = "idle" ] && pass "real-bot online in /api/status" || fail "real-bot not online (status=${STATUS_ONLINE:-missing})"
echo ""

echo "6. Send task to real-bot via MCP..."
SEND=$(mcp_call "send_task" '{"alias":"real-bot","task":"real integration task","from_session":"tester"}')
[ "$(echo "$SEND" | mcp_ok)" = "true" ] && pass "send_task accepted" || fail "send_task failed"
echo ""

echo "7. Verify agent-node attempted processing..."
sleep 3
grep -q "processing" "${NODE_LOG}" && pass "agent-node entered processing path" || fail "processing log missing"
grep -q "http-api 错误\|需要设置 ANTHROPIC_API_KEY\|OPENAI_API_KEY\|MINIMAX_CODING_API_KEY" "${NODE_LOG}" && pass "http-api runtime attempted and errored as expected" || fail "http-api runtime error log missing"
echo ""

echo "8. Verify startup showed user/network info..."
grep -q "user:    realbotuser" "${NODE_LOG}" && pass "startup displayed user info" || fail "user info missing"
grep -q "network:" "${NODE_LOG}" && pass "startup displayed network info" || fail "network info missing"
echo ""

echo "9. Stop agent-node..."
wait "${AGENT_PID}" || true
pass "agent-node process stopped"
echo ""

echo "10. Verify /api/status shows offline..."
sleep 1
STATUS_OFFLINE=$(api_curl http://127.0.0.1:9200/api/status | python3 -c "
import sys, json
doc = json.load(sys.stdin)
s = next((x for x in doc.get('sessions', []) if x.get('alias') == 'real-bot'), None)
print(s.get('status', '') if s else '')
")
[ "$STATUS_OFFLINE" = "offline" ] && pass "real-bot offline after stop" || { cat "${NODE_LOG}"; fail "real-bot not offline (status=${STATUS_OFFLINE:-missing})"; }
echo ""

echo "========================================="
echo "Result: ${PASS} passed, ${FAIL} failed"
echo "========================================="

kill "${SERVER_PID}" 2>/dev/null || true
wait "${SERVER_PID}" 2>/dev/null || true

[ "${FAIL}" -eq 0 ]

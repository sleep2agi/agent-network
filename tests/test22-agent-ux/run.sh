#!/bin/bash

PASS=0
FAIL=0
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
BASE="http://127.0.0.1:9200"
WORKDIR="/tmp/test22"
TEST_HOME="${WORKDIR}/home"
SERVER_LOG="${WORKDIR}/server.log"
ANET_START_LOG="${WORKDIR}/anet-start.log"
NO_TOKEN_LOG="${WORKDIR}/agent-no-token.log"
GOOD_NODE_LOG="${WORKDIR}/agent-good.log"
BAD_HUB_LOG="${WORKDIR}/agent-bad-hub.log"
DEMO_LOG="${WORKDIR}/demo.log"
DEMO_LIVE_LOG="${WORKDIR}/demo-live.log"

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

json_get() {
  local expr="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); print($expr)" 2>/dev/null
}

cleanup() {
  kill "${ANET_PID:-}" 2>/dev/null || true
  wait "${ANET_PID:-}" 2>/dev/null || true
  kill "${GOOD_PID:-}" 2>/dev/null || true
  wait "${GOOD_PID:-}" 2>/dev/null || true
  kill "${NO_TOKEN_PID:-}" 2>/dev/null || true
  wait "${NO_TOKEN_PID:-}" 2>/dev/null || true
  kill "${SERVER_PID:-}" 2>/dev/null || true
  wait "${SERVER_PID:-}" 2>/dev/null || true
}

trap cleanup EXIT

mkdir -p "${WORKDIR}" "${TEST_HOME}"
export HOME="${TEST_HOME}"

echo ""
echo "========================================="
echo "  agent-node / anet UX Test"
echo "========================================="
echo ""

echo "Setup. Start server and prepare config..."
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" bun run src/index.ts >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
sleep 3
HEALTH=$(curl -s "$BASE/health" 2>/dev/null)
echo "$HEALTH" | grep -q '"ok":true' || { cat "${SERVER_LOG}"; echo "server failed"; exit 1; }

REG=$(curl -s -X POST "$BASE/api/auth/register" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"username":"uxuser","password":"pass123456","email":"ux@example.com"}')
UTOK=$(echo "$REG" | json_get "data.get('token','')")
NET_ID=$(echo "$REG" | json_get "data.get('network_id','')")
NET_TOKEN_DEFAULT=$(echo "$REG" | json_get "data.get('network_token','')")
[ -n "$UTOK" ] && [ -n "$NET_ID" ] && [ -n "$NET_TOKEN_DEFAULT" ] || { echo "$REG"; echo "register failed"; exit 1; }

mkdir -p "${HOME}/.anet" "${HOME}/.anet/nodes/ux-bot"
cat > "${HOME}/.anet/config.json" <<EOF
{
  "hub": "${BASE}",
  "token": "${UTOK}",
  "user": { "username": "uxuser" },
  "network_id": "${NET_ID}",
  "network_name": "default"
}
EOF

HOME="${HOME}" anet node create bot-a --runtime claude-agent-sdk >"${WORKDIR}/anet-create.log" 2>&1

cat > "${HOME}/.anet/nodes/ux-bot/config.json" <<EOF
{
  "alias": "ux-bot",
  "node_name": "ux-bot",
  "node_id": "n_test22ux",
  "runtime": "http-api",
  "model": "gpt-4o-mini",
  "hub": "${BASE}",
  "token": "${NET_TOKEN_DEFAULT}",
  "network_id": "${NET_ID}"
}
EOF
echo "  PASS  setup complete"
PASS=$((PASS+1))
echo ""

echo "A1. agent-node --help..."
HELP_OUT=$(agent-node --help 2>&1 || true)
echo "$HELP_OUT" | grep -q "用法:" && echo "$HELP_OUT" | grep -q -- "--alias" && pass "agent-node help is clear" || fail "agent-node help unclear"
echo ""

echo "A2. agent-node -v..."
VERSION_OUT=$(agent-node -v 2>&1 || true)
echo "$VERSION_OUT" | grep -qE '^agent-node v2\.[0-9]+\.[0-9]+-preview\.[0-9]+' && pass "agent-node version shown" || fail "agent-node version missing"
echo ""

echo "A3. agent-node startup output with user/network..."
timeout 6 agent-node --config "${HOME}/.anet/nodes/ux-bot/config.json" --alias ux-bot --runtime http-api >"${GOOD_NODE_LOG}" 2>&1 &
GOOD_PID=$!
sleep 4
grep -q "user:    uxuser" "${GOOD_NODE_LOG}" && grep -q "network:" "${GOOD_NODE_LOG}" && pass "startup shows user/network info" || { cat "${GOOD_NODE_LOG}"; fail "startup user/network info missing"; }
kill "${GOOD_PID}" 2>/dev/null || true
wait "${GOOD_PID}" 2>/dev/null || true
echo ""

echo "A4. startup without token..."
mkdir -p "${WORKDIR}/no-token-home"
HOME="${WORKDIR}/no-token-home" timeout 5 agent-node --alias no-token --runtime http-api --url "${BASE}" >"${NO_TOKEN_LOG}" 2>&1 &
NO_TOKEN_PID=$!
sleep 3
grep -q "未配置 token" "${NO_TOKEN_LOG}" && grep -q "anet login" "${NO_TOKEN_LOG}" && pass "no-token warning is friendly" || { cat "${NO_TOKEN_LOG}"; fail "no-token warning unclear"; }
kill "${NO_TOKEN_PID}" 2>/dev/null || true
wait "${NO_TOKEN_PID}" 2>/dev/null || true
export HOME="${TEST_HOME}"
echo ""

echo "A5. hub unreachable startup..."
COMMHUB_TOKEN="${NET_TOKEN_DEFAULT}" timeout 5 agent-node --alias bad-hub --runtime http-api --url "http://127.0.0.1:9999" >"${BAD_HUB_LOG}" 2>&1 || true
grep -qE "token 验证失败|fetch failed|callCommHub\\(report_status\\) failed after" "${BAD_HUB_LOG}" && pass "hub unreachable error is visible" || { cat "${BAD_HUB_LOG}"; fail "hub unreachable error missing"; }
echo ""

echo "B6. anet node start bot-a..."
HOME="${HOME}" anet node start bot-a >"${ANET_START_LOG}" 2>&1 &
ANET_PID=$!
sleep 4
grep -q 'Starting new session for "bot-a"' "${ANET_START_LOG}" && grep -q 'Token:' "${ANET_START_LOG}" && pass "anet node start output looks normal" || { cat "${ANET_START_LOG}"; fail "anet node start output unclear"; }
echo ""

echo "B7. anet node start missing node..."
MISSING_OUT=$(HOME="${HOME}" anet node start missing-bot 2>&1 || true)
echo "$MISSING_OUT" | grep -q 'Node "missing-bot" not found' && pass "missing node error is clear" || fail "missing node error unclear"
echo ""

echo "B8. anet node stop bot-a..."
STOP_OUT=$(HOME="${HOME}" anet node stop bot-a 2>&1 || true)
echo "$STOP_OUT" | grep -q 'Stopped "bot-a"' && pass "anet node stop output is clear" || { echo "$STOP_OUT"; fail "anet node stop output unclear"; }
wait "${ANET_PID}" 2>/dev/null || true
echo ""

echo "B9. anet logs bot-a..."
LOGS_OUT=$(HOME="${HOME}" anet logs bot-a 2>&1 || true)
echo "$LOGS_OUT" | grep -qE 'last [0-9]+ lines|启动|runtime:' && pass "anet logs shows log content" || { echo "$LOGS_OUT"; fail "anet logs missing"; }
echo ""

echo "C10. anet demo..."
HOME="${HOME}" anet demo >"${DEMO_LOG}" 2>&1 || true
grep -q "Agent Network Dashboard" "${DEMO_LOG}" && grep -qE "Agents Online|\\(no tasks yet\\)|Recent Tasks" "${DEMO_LOG}" && pass "anet demo dashboard format is readable" || { cat "${DEMO_LOG}"; fail "anet demo output unclear"; }
echo ""

echo "C11. anet demo --live..."
HOME="${HOME}" timeout 3 anet demo --live >"${DEMO_LIVE_LOG}" 2>&1 || true
grep -q "Refreshing every" "${DEMO_LIVE_LOG}" && grep -q "Agent Network Dashboard" "${DEMO_LIVE_LOG}" && pass "anet demo --live refreshes" || { cat "${DEMO_LIVE_LOG}"; fail "anet demo --live unclear"; }
echo ""

echo "C12. anet config..."
CONFIG_OUT=$(HOME="${HOME}" anet config 2>&1 || true)
echo "$CONFIG_OUT" | grep -q "hub:" && echo "$CONFIG_OUT" | grep -q "token:" && echo "$CONFIG_OUT" | grep -q "network_id:" && pass "anet config shows complete summary" || { echo "$CONFIG_OUT"; fail "anet config incomplete"; }
echo ""

echo "========================================="
echo "Result: ${PASS} passed, ${FAIL} failed"
echo "========================================="

[ "${FAIL}" -eq 0 ]

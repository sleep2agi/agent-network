#!/bin/bash
# Layer 0 + Layer 2 runtime smoke test

PASS=0
FAIL=0
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
BASE="http://127.0.0.1:9200"
TMP="/tmp/test8-runtime"
mkdir -p "$TMP"

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

api_get() {
  curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "$@"
}

mcp_call() {
  local tool="$1"
  local args="$2"
  timeout 10 curl -s -X POST "${BASE}/mcp" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"t\",\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":${args}}}" 2>/dev/null || true
}

wait_for_status_alias() {
  local alias="$1"
  local timeout_s="${2:-12}"
  local i
  for i in $(seq 1 "$timeout_s"); do
    if api_get "${BASE}/api/status" | grep -q "\"alias\":\"${alias}\""; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo ""
echo "═══ Test 8: Runtime + SSE Smoke ═══"
echo ""

echo "1. Server health"
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" bun run src/index.ts >"${TMP}/server.log" 2>&1 &
sleep 4
curl -s "${BASE}/health" | grep -q '"ok":true' && pass "server started" || fail "server start"
curl -s "${BASE}/health" | grep -q '"transport":"streamable-http"' && pass "streamable HTTP enabled" || fail "transport mode"
echo ""

echo "2. agent-node binary"
agent-node --version 2>&1 | grep -q "agent-node" && pass "agent-node installed" || fail "agent-node missing"
echo ""

echo "3. codex-sdk runtime startup"
if command -v codex >/dev/null 2>&1; then
  timeout 8 agent-node --alias test8-codex --runtime codex-sdk >"${TMP}/codex.log" 2>&1 &
  sleep 5
  if wait_for_status_alias "test8-codex" 8; then
    pass "codex-sdk runtime registered"
  else
    cat "${TMP}/codex.log"
    fail "codex-sdk runtime did not register"
  fi
else
  pass "codex binary absent, codex-sdk startup skipped by design"
fi
echo ""

echo "4. http-api runtime startup"
OPENAI_API_KEY="mock-api-key" timeout 8 agent-node --alias test8-http --runtime http-api --model gpt-4o-mini >"${TMP}/http.log" 2>&1 &
sleep 5
if wait_for_status_alias "test8-http" 8; then
  pass "http-api runtime registered with mock key"
else
  cat "${TMP}/http.log"
  fail "http-api runtime did not register"
fi
echo ""

echo "5. SSE connect"
timeout 10 curl -N -s \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  "${BASE}/events/test8-http" >"${TMP}/sse.log" 2>&1 &
sleep 2
grep -q '"type":"connected"' "${TMP}/sse.log" && pass "SSE connected" || fail "SSE did not connect"
echo ""

echo "6. send_task push"
SEND_RESP=$(mcp_call "send_task" '{"alias":"test8-http","task":"runtime layer2 task","from_session":"test8","priority":"high"}')
sleep 2
if grep -q '"type":"new_task"' "${TMP}/sse.log"; then
  pass "send_task triggered SSE new_task"
else
  echo "$SEND_RESP"
  cat "${TMP}/sse.log"
  fail "send_task did not reach SSE subscriber"
fi
echo ""

echo "7. report_status visibility"
STATUS_RESP=$(mcp_call "report_status" '{"resume_id":"test8-manual","alias":"test8-status","status":"idle","task":"runtime status check"}')
sleep 1
if api_get "${BASE}/api/status" | grep -q '"alias":"test8-status"'; then
  pass "report_status visible in /api/status"
else
  echo "$STATUS_RESP"
  fail "report_status missing from /api/status"
fi
echo ""

echo "═══════════════════════════════════"
echo "  Test 8 Result: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1

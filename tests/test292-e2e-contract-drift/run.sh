#!/usr/bin/env bash
set -uo pipefail

source /repo/tests/lib/response-json.sh

PASS=0
FAIL=0
BASE=http://127.0.0.1:9200
WORK=/tmp/test292-contract

pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }

cleanup() {
  kill "${SERVER_PID:-}" 2>/dev/null || true
  wait "${SERVER_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

SCRIPT=/repo/tests/docker-e2e.sh

grep -Fq 'anet upgrade --no-auto-self --dry-run' "$SCRIPT" \
  && pass "wiring: upgrade probe is explicitly side-effect free" \
  || fail "wiring: upgrade probe may perform a real self-upgrade"

grep -Fq 'response_json_error_is "$GHOST_REPLY" "reply_task_not_found"' "$SCRIPT" \
  && pass "wiring: ghost reply uses structured SSE/JSON error parsing" \
  || fail "wiring: ghost reply still parses the raw transport as plain JSON"

grep -Fq 'response_json_has_result "$AUTH_MCP"' "$SCRIPT" \
  && pass "wiring: MCP initialize uses a structured result predicate" \
  || fail "wiring: MCP initialize still relies on response text tokens"

COMMHUB_DB_PATH=$WORK/commhub.db bun run /repo/server/src/index.ts >$WORK-server.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.2
done

HEALTH=$(curl -fsS "$BASE/health")
if printf '%s' "$HEALTH" | jq -e '.ok == true and (.sse_connections | type == "number") and (has("sse_sessions") | not)' >/dev/null; then
  pass "real Hub: anonymous health exposes count but not session identities"
else
  fail "real Hub: anonymous health contract changed"
fi

WS_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/ws/tmux/nonexistent")
if [[ "$WS_STATUS" == 404 ]]; then
  pass "real Hub: removed tmux WebSocket route is a safe 404"
else
  fail "real Hub: removed tmux WebSocket route returned $WS_STATUS"
fi

REGISTER=$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"username":"contract-owner","password":"contract-pass-123"}')
TOKEN=$(printf '%s' "$REGISTER" | jq -r .token)
NETWORK=$(curl -fsS -X POST "$BASE/api/networks" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"contract-network"}' | jq -r .network_id)

mcp_call() {
  local name=$1 arguments=$2
  curl -fsS -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test292","version":"1"}}}' >/dev/null
  curl -fsS -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$(jq -cn --arg name "$name" --argjson arguments "$arguments" '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:$name,arguments:$arguments}}')"
}

INIT=$(curl -fsS -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test292","version":"1"}}}')
if declare -F response_json_has_result >/dev/null && response_json_has_result "$INIT"; then
  pass "real Hub: structured predicate accepts MCP initialize result"
else
  fail "real Hub: no structured MCP result predicate"
fi

GHOST=$(mcp_call send_reply "$(jq -cn --arg network "$NETWORK" '{alias:"nobody",text:"ghost",in_reply_to:"missing-task",from_session:"contract-owner",network_id:$network}')")
if declare -F response_json_error_is >/dev/null && response_json_error_is "$GHOST" reply_task_not_found; then
  pass "real Hub: structured predicate recognizes exact ghost-reply error"
else
  printf '%s\n' "$GHOST" >&2
  fail "real Hub: exact ghost-reply error was not recognized"
fi

echo "RESULT: $PASS passed, $FAIL failed"
echo "source_commit=$TEST292_CONTRACT_SOURCE_COMMIT"
[[ $FAIL -eq 0 ]]

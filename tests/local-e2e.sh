#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║  Local E2E Test — No Docker Required                  ║
# ║  Tests adapter-refactored server end-to-end            ║
# ║  Usage: bash tests/local-e2e.sh                        ║
# ╚══════════════════════════════════════════════════════╝
PASS=0; FAIL=0; TOTAL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); }
fail() { echo "  ❌ $1${2:+: $2}"; FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); }

PORT=9299
BASE="http://127.0.0.1:$PORT"
TOKEN="localtest$(date +%s)"
DB="/tmp/local-e2e-$$.db"
AUTH="Authorization: Bearer $TOKEN"
MCP_H=(-H "$AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")

cleanup() {
  kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null
  rm -f "$DB"
}
trap cleanup EXIT

echo ""
echo "═══════════════════════════════════════════"
echo "  Local E2E Test Suite"
echo "═══════════════════════════════════════════"
echo ""

# ── Start test server ──
echo "Starting test server on :$PORT..."
cd "$(dirname "$0")/../server"
PORT=$PORT COMMHUB_DB="$DB" COMMHUB_AUTH_TOKEN="$TOKEN" bun run src/index.ts &
SERVER_PID=$!
sleep 3

if ! curl -s "$BASE/health" >/dev/null 2>&1; then
  echo "  ❌ Server failed to start"; exit 1
fi
echo "  Server PID=$SERVER_PID, DB=$DB"
echo ""

# Helper: extract data from SSE MCP response
mcp() {
  local resp
  resp=$(curl -s -X POST "$BASE/mcp" "${MCP_H[@]}" -d "$1" 2>/dev/null)
  # Handle both SSE (event: message\ndata: {...}) and plain JSON
  if echo "$resp" | grep -q "^data:"; then
    echo "$resp" | grep "^data:" | sed 's/^data: //'
  else
    echo "$resp"
  fi
}
json_ok() {
  # Works for both plain JSON {"ok":true} and MCP nested {"result":{"content":[{"text":"{\"ok\":true}"}]}}
  echo "$1" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true|"ok\\"[[:space:]]*:[[:space:]]*true|ok.*true';
}
json_field() { echo "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d$2)" 2>/dev/null; }

# ═══════════════════════════════════════════
#  1. Health & Public Endpoints
# ═══════════════════════════════════════════
echo "1. Health & Public"
R=$(curl -s "$BASE/health")
echo "$R" | grep -q '"ok":true' && pass "GET /health" || fail "GET /health"
echo "$R" | grep -q '"v3_auth":true' && pass "v3_auth enabled" || fail "v3_auth"
echo "$R" | grep -q '"multi_network":true' && pass "multi_network enabled" || fail "multi_network"

R=$(curl -s "$BASE/api/license")
echo "$R" | grep -q 'trial' && pass "GET /api/license (trial)" || fail "license"
echo ""

# ═══════════════════════════════════════════
#  2. V3 Auth System
# ═══════════════════════════════════════════
echo "2. V3 Auth System"
R=$(curl -s -X POST "$BASE/api/auth/register" -H "$AUTH" -H "Content-Type: application/json" -d '{"username":"e2euser","password":"pass123456"}')
json_ok "$R" && pass "POST /api/auth/register" || fail "register" "$R"
V3TOK=$(json_field "$R" "['token']")

R=$(curl -s -X POST "$BASE/api/auth/login" -H "$AUTH" -H "Content-Type: application/json" -d '{"username":"e2euser","password":"pass123456"}')
json_ok "$R" && pass "POST /api/auth/login" || fail "login"
V3TOK=$(json_field "$R" "['token']")
V3H="Authorization: Bearer $V3TOK"

R=$(curl -s "$BASE/api/auth/me" -H "$V3H")
echo "$R" | grep -q 'e2euser' && pass "GET /api/auth/me" || fail "auth/me"

R=$(curl -s -X PUT "$BASE/api/auth/me" -H "$V3H" -H "Content-Type: application/json" -d '{"display_name":"Test User"}')
json_ok "$R" && pass "PUT /api/auth/me" || fail "update profile"

R=$(curl -s -X POST "$BASE/api/auth/password" -H "$V3H" -H "Content-Type: application/json" -d '{"old_password":"pass123456","new_password":"newpass789"}')
json_ok "$R" && pass "POST /api/auth/password" || fail "change password"

# Login with new password
R=$(curl -s -X POST "$BASE/api/auth/login" -H "$AUTH" -H "Content-Type: application/json" -d '{"username":"e2euser","password":"newpass789"}')
json_ok "$R" && pass "login with new password" || fail "new password login"
V3TOK=$(json_field "$R" "['token']")
V3H="Authorization: Bearer $V3TOK"
echo ""

# ═══════════════════════════════════════════
#  3. Token Management
# ═══════════════════════════════════════════
echo "3. Token Management"
R=$(curl -s -X POST "$BASE/api/auth/tokens" -H "$V3H" -H "Content-Type: application/json" -d '{"name":"test-token"}')
json_ok "$R" && pass "POST /api/auth/tokens (create)" || fail "token create"
TOK_ID=$(json_field "$R" "['token_id']")

R=$(curl -s "$BASE/api/auth/tokens" -H "$V3H")
echo "$R" | grep -q 'test-token' && pass "GET /api/auth/tokens (list)" || fail "token list"

if [ -n "$TOK_ID" ]; then
  R=$(curl -s -X DELETE "$BASE/api/auth/tokens/$TOK_ID" -H "$V3H")
  json_ok "$R" && pass "DELETE /api/auth/tokens/:id (revoke)" || fail "token revoke"
fi
echo ""

# ═══════════════════════════════════════════
#  4. Network Management
# ═══════════════════════════════════════════
echo "4. Network Management"
R=$(curl -s "$BASE/api/networks" -H "$V3H")
echo "$R" | grep -q 'default' && pass "GET /api/networks (has default)" || fail "list networks"
NET_ID=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['network_id'])" 2>/dev/null)

R=$(curl -s -X POST "$BASE/api/networks" -H "$V3H" -H "Content-Type: application/json" -d '{"name":"test-net-2","description":"e2e test"}')
json_ok "$R" && pass "POST /api/networks (create)" || fail "create network"
NET2_ID=$(json_field "$R" "['network_id']")

if [ -n "$NET2_ID" ]; then
  R=$(curl -s "$BASE/api/networks/$NET2_ID" -H "$V3H")
  echo "$R" | grep -q 'test-net-2' && pass "GET /api/networks/:id (detail)" || fail "network detail"

  R=$(curl -s -X PUT "$BASE/api/networks/$NET2_ID" -H "$V3H" -H "Content-Type: application/json" -d '{"name":"renamed-net"}')
  json_ok "$R" && pass "PUT /api/networks/:id (rename)" || fail "network rename"

  R=$(curl -s -X DELETE "$BASE/api/networks/$NET2_ID" -H "$V3H")
  json_ok "$R" && pass "DELETE /api/networks/:id (delete)" || fail "network delete"
fi
echo ""

# ═══════════════════════════════════════════
#  5. MCP Tools (via transactions)
# ═══════════════════════════════════════════
echo "5. MCP Tools (adapter + transactions)"
R=$(mcp '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"report_status","arguments":{"resume_id":"e2e-agent-1","alias":"e2e-agent","status":"idle"}}}')
json_ok "$R" && pass "MCP report_status" || fail "report_status"

R=$(mcp '{"jsonrpc":"2.0","id":"2","method":"tools/call","params":{"name":"send_task","arguments":{"alias":"e2e-agent","task":"test task alpha","from_session":"e2e-hub","priority":"high"}}}')
json_ok "$R" && pass "MCP send_task (tx)" || fail "send_task"
TASK_ID=$(echo "$R" | python3 -c "import json,sys; d=json.loads(json.load(sys.stdin)['result']['content'][0]['text']); print(d['message_id'])" 2>/dev/null)

R=$(mcp '{"jsonrpc":"2.0","id":"3","method":"tools/call","params":{"name":"get_inbox","arguments":{"alias":"e2e-agent"}}}')
echo "$R" | grep -q 'test task alpha' && pass "MCP get_inbox" || fail "get_inbox"

R=$(mcp '{"jsonrpc":"2.0","id":"4","method":"tools/call","params":{"name":"send_ack","arguments":{"task_id":"'"$TASK_ID"'","from_session":"e2e-agent"}}}')
json_ok "$R" && pass "MCP send_ack" || fail "send_ack"

R=$(mcp '{"jsonrpc":"2.0","id":"5","method":"tools/call","params":{"name":"get_all_status","arguments":{}}}')
echo "$R" | grep -q 'e2e-agent' && pass "MCP get_all_status (tx)" || fail "get_all_status"

R=$(mcp '{"jsonrpc":"2.0","id":"6","method":"tools/call","params":{"name":"get_session_status","arguments":{"alias":"e2e-agent"}}}')
json_ok "$R" && pass "MCP get_session_status" || fail "get_session_status"

R=$(mcp '{"jsonrpc":"2.0","id":"7","method":"tools/call","params":{"name":"get_task","arguments":{"task_id":"'"$TASK_ID"'"}}}')
json_ok "$R" && pass "MCP get_task" || fail "get_task"

R=$(mcp '{"jsonrpc":"2.0","id":"8","method":"tools/call","params":{"name":"list_tasks","arguments":{"alias":"e2e-agent"}}}')
echo "$R" | grep -q 'test task alpha' && pass "MCP list_tasks" || fail "list_tasks"

R=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":\"9\",\"method\":\"tools/call\",\"params\":{\"name\":\"send_reply\",\"arguments\":{\"alias\":\"e2e-agent\",\"text\":\"done!\",\"in_reply_to\":\"$TASK_ID\",\"from_session\":\"e2e-hub\"}}}")
json_ok "$R" && pass "MCP send_reply (tx)" || fail "send_reply"

R=$(mcp '{"jsonrpc":"2.0","id":"10","method":"tools/call","params":{"name":"send_message","arguments":{"alias":"e2e-agent","message":"hello msg","from_session":"e2e-hub"}}}')
json_ok "$R" && pass "MCP send_message" || fail "send_message"

R=$(mcp '{"jsonrpc":"2.0","id":"11","method":"tools/call","params":{"name":"report_completion","arguments":{"alias":"e2e-agent","task":"test task alpha","result":"completed successfully"}}}')
json_ok "$R" && pass "MCP report_completion (tx)" || fail "report_completion"

# Send another task for retry/cancel/reassign tests
R=$(mcp '{"jsonrpc":"2.0","id":"12","method":"tools/call","params":{"name":"send_task","arguments":{"alias":"e2e-agent","task":"cancel me","from_session":"e2e-hub"}}}')
CANCEL_ID=$(echo "$R" | python3 -c "import json,sys; d=json.loads(json.load(sys.stdin)['result']['content'][0]['text']); print(d['message_id'])" 2>/dev/null)
R=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":\"13\",\"method\":\"tools/call\",\"params\":{\"name\":\"cancel_task\",\"arguments\":{\"task_id\":\"$CANCEL_ID\",\"reason\":\"e2e test\"}}}")
json_ok "$R" && pass "MCP cancel_task" || fail "cancel_task"

R=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":\"14\",\"method\":\"tools/call\",\"params\":{\"name\":\"retry_task\",\"arguments\":{\"task_id\":\"$CANCEL_ID\"}}}")
json_ok "$R" && pass "MCP retry_task (tx)" || fail "retry_task"

R=$(mcp '{"jsonrpc":"2.0","id":"15","method":"tools/call","params":{"name":"report_status","arguments":{"resume_id":"e2e-agent-2","alias":"e2e-agent-2","status":"idle"}}}')
R=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":\"16\",\"method\":\"tools/call\",\"params\":{\"name\":\"reassign_task\",\"arguments\":{\"task_id\":\"$CANCEL_ID\",\"new_alias\":\"e2e-agent-2\"}}}")
json_ok "$R" && pass "MCP reassign_task (tx)" || fail "reassign_task"

R=$(mcp '{"jsonrpc":"2.0","id":"17","method":"tools/call","params":{"name":"broadcast","arguments":{"message":"e2e broadcast"}}}')
json_ok "$R" && pass "MCP broadcast" || fail "broadcast"

R=$(mcp '{"jsonrpc":"2.0","id":"18","method":"tools/call","params":{"name":"get_completions","arguments":{}}}')
json_ok "$R" && pass "MCP get_completions" || fail "get_completions"
echo ""

# ═══════════════════════════════════════════
#  6. REST API Endpoints
# ═══════════════════════════════════════════
echo "6. REST API"
R=$(curl -s "$BASE/api/status" -H "$AUTH"); echo "$R" | grep -q 'e2e-agent' && pass "GET /api/status" || fail "status"
R=$(curl -s "$BASE/api/tasks" -H "$AUTH"); echo "$R" | grep -q 'test task alpha' && pass "GET /api/tasks" || fail "tasks"
R=$(curl -s "$BASE/api/stats" -H "$AUTH"); json_ok "$R" && pass "GET /api/stats" || fail "stats"
R=$(curl -s "$BASE/api/nodes" -H "$AUTH"); json_ok "$R" && pass "GET /api/nodes" || fail "nodes"
R=$(curl -s "$BASE/api/task_events" -H "$AUTH"); json_ok "$R" && pass "GET /api/task_events" || fail "task_events"
R=$(curl -s "$BASE/api/messages" -H "$AUTH"); json_ok "$R" && pass "GET /api/messages" || fail "messages"
R=$(curl -s "$BASE/api/completions" -H "$AUTH"); json_ok "$R" && pass "GET /api/completions" || fail "completions"
R=$(curl -s "$BASE/api/audit-log" -H "$V3H"); json_ok "$R" && pass "GET /api/audit-log" || fail "audit-log"
echo ""

# ═══════════════════════════════════════════
#  Report
# ═══════════════════════════════════════════
echo "═══════════════════════════════════════════"
echo "  RESULT: $PASS passed, $FAIL failed (of $TOTAL)"
echo "═══════════════════════════════════════════"
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1

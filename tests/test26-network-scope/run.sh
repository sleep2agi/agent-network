#!/bin/bash
set -e

PASS=0
FAIL=0
BASE="http://127.0.0.1:9200"
GLOBAL_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
json_get() {
  python3 -c "import json,sys; data=json.load(sys.stdin); cur=data
for key in '$1'.split('.'):
    cur = cur.get(key, '') if isinstance(cur, dict) else ''
print(cur or '')" 2>/dev/null
}

echo ""
echo "========================================="
echo "  Test 26: Network Scope Regression"
echo "========================================="
echo ""

cd /app/server
COMMHUB_DB=/tmp/test26-commhub.db \
COMMHUB_AUTH_TOKEN="$GLOBAL_TOKEN" \
HOST=127.0.0.1 \
bun run src/index.ts &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  if curl -s "$BASE/health" | grep -q '"ok":true'; then
    break
  fi
  sleep 0.5
done

curl -s "$BASE/health" | grep -q '"ok":true' && pass "server health in Docker" || { fail "server failed to start"; exit 1; }

echo "1. Auth boundary..."
STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/status")
[ "$STATUS_CODE" = "401" ] && pass "REST /api/status without token is 401" || fail "REST /api/status without token returned $STATUS_CODE"

echo ""
echo "2. Setup users and networks..."
curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d '{"username":"scope_admin","password":"pass123456"}' >/dev/null

REG_A=$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d '{"username":"scope_a","password":"pass123456"}')
UTOK_A=$(echo "$REG_A" | json_get token)
NTOK_A=$(echo "$REG_A" | json_get network_token)
NET_A=$(echo "$REG_A" | json_get network_id)
UID_A=$(echo "$REG_A" | json_get user.user_id)

REG_B=$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d '{"username":"scope_b","password":"pass123456"}')
UTOK_B=$(echo "$REG_B" | json_get token)
NTOK_B=$(echo "$REG_B" | json_get network_token)
NET_B=$(echo "$REG_B" | json_get network_id)
UID_B=$(echo "$REG_B" | json_get user.user_id)

[ -n "$UTOK_A" ] && [ -n "$NTOK_A" ] && [ -n "$NET_A" ] && [ -n "$UTOK_B" ] && [ -n "$NTOK_B" ] && [ -n "$NET_B" ] \
  && pass "registered non-admin users with network tokens" \
  || { fail "failed to register users: A=$REG_A B=$REG_B"; exit 1; }

echo ""
echo "3. MCP report_status is scoped by network token..."
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"scope-test","version":"1.0"}}}'
mcp_call() {
  local token="$1"
  local tool="$2"
  local args="$3"
  curl -s -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$MCP_INIT" >/dev/null
  curl -s -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
}

RS_A=$(mcp_call "$NTOK_A" "report_status" '{"resume_id":"resume-alpha","alias":"alpha-agent","status":"idle","task":"alpha visible"}')
RS_B=$(mcp_call "$NTOK_B" "report_status" '{"resume_id":"resume-beta","alias":"beta-agent","status":"idle","task":"beta visible"}')
echo "$RS_A$RS_B" | grep -qE 'permission_denied|error' && fail "MCP report_status failed" || pass "MCP report_status accepted for network tokens"

STATUS_A=$(curl -s -H "Authorization: Bearer $UTOK_A" "$BASE/api/status")
echo "$STATUS_A" | grep -q 'alpha-agent' && pass "user A sees own session" || fail "user A missing own session: $STATUS_A"
echo "$STATUS_A" | grep -q 'beta-agent' && fail "user A can see user B session" || pass "user A cannot see user B session"

STATUS_B=$(curl -s -H "Authorization: Bearer $UTOK_B" "$BASE/api/status")
echo "$STATUS_B" | grep -q 'beta-agent' && pass "user B sees own session" || fail "user B missing own session: $STATUS_B"
echo "$STATUS_B" | grep -q 'alpha-agent' && fail "user B can see user A session" || pass "user B cannot see user A session"

echo ""
echo "4. MCP inbox, task, broadcast, and completion isolation..."
mcp_call "$NTOK_A" "send_task" '{"alias":"alpha-agent","task":"secret-from-alpha","from_session":"scope-test"}' >/dev/null
INBOX_A=$(mcp_call "$NTOK_A" "get_inbox" '{"alias":"alpha-agent","limit":20}')
INBOX_B_ALPHA_ALIAS=$(mcp_call "$NTOK_B" "get_inbox" '{"alias":"alpha-agent","limit":20}')
echo "$INBOX_A" | grep -q 'secret-from-alpha' && pass "alpha task visible in alpha inbox" || fail "alpha task missing from alpha inbox"
echo "$INBOX_B_ALPHA_ALIAS" | grep -q 'secret-from-alpha' && fail "beta token can read alpha inbox by alias" || pass "beta token cannot read alpha inbox by alias"

mcp_call "$NTOK_B" "broadcast" '{"message":"broadcast-from-beta"}' >/dev/null
INBOX_A_AFTER_BCAST=$(mcp_call "$NTOK_A" "get_inbox" '{"alias":"alpha-agent","limit":20}')
INBOX_B_AFTER_BCAST=$(mcp_call "$NTOK_B" "get_inbox" '{"alias":"beta-agent","limit":20}')
echo "$INBOX_A_AFTER_BCAST" | grep -q 'broadcast-from-beta' && fail "beta broadcast leaked to alpha" || pass "beta broadcast did not leak to alpha"
echo "$INBOX_B_AFTER_BCAST" | grep -q 'broadcast-from-beta' && pass "beta broadcast reaches beta session" || fail "beta broadcast missing from beta"

mcp_call "$NTOK_A" "report_completion" '{"alias":"alpha-agent","task":"secret-from-alpha","result":"done-alpha"}' >/dev/null
COMP_A=$(curl -s -H "Authorization: Bearer $UTOK_A" "$BASE/api/completions")
COMP_B=$(curl -s -H "Authorization: Bearer $UTOK_B" "$BASE/api/completions")
echo "$COMP_A" | grep -q 'done-alpha' && pass "alpha completion visible to alpha user" || fail "alpha completion missing"
echo "$COMP_B" | grep -q 'done-alpha' && fail "alpha completion leaked to beta user" || pass "alpha completion hidden from beta user"

MSG_A=$(curl -s -H "Authorization: Bearer $UTOK_A" "$BASE/api/messages")
MSG_B=$(curl -s -H "Authorization: Bearer $UTOK_B" "$BASE/api/messages")
echo "$MSG_A" | grep -q 'secret-from-alpha' && pass "alpha messages include alpha task" || fail "alpha messages missing alpha task"
echo "$MSG_B" | grep -q 'secret-from-alpha' && fail "alpha message leaked to beta REST messages" || pass "alpha message hidden from beta REST messages"

echo ""
echo "5. Viewer cannot escalate or write..."
ADD_VIEWER=$(curl -s -X POST "$BASE/api/networks/$NET_A/members" \
  -H "Authorization: Bearer $UTOK_A" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"$UID_B\",\"role\":\"viewer\"}")
echo "$ADD_VIEWER" | grep -q '"ok":true' && pass "added user B as viewer to A network" || fail "could not add viewer: $ADD_VIEWER"

VIEWER_TOKEN=$(curl -s -X POST "$BASE/api/auth/tokens" \
  -H "Authorization: Bearer $UTOK_B" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"viewer-full\",\"network_id\":\"$NET_A\"}")
echo "$VIEWER_TOKEN" | grep -q 'viewer cannot create full-access network tokens' && pass "viewer full-token escalation blocked" || fail "viewer full-token escalation not blocked: $VIEWER_TOKEN"

VIEWER_TASK_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/task" \
  -H "Authorization: Bearer $UTOK_B" \
  -H "Content-Type: application/json" \
  -d "{\"alias\":\"alpha-agent\",\"task\":\"viewer-write\",\"network_id\":\"$NET_A\"}")
[ "$VIEWER_TASK_CODE" = "403" ] && pass "viewer REST task write blocked" || fail "viewer REST task write returned $VIEWER_TASK_CODE"

echo ""
echo "6. CLI syntax/build check in Docker..."
bun build /app/agent-network/bin/cli.ts \
  --outdir /tmp/anet-cli-build \
  --target node \
  --external @sleep2agi/commhub-server \
  --external bun:sqlite \
  --external @inquirer/prompts \
  --external '../../server/*' >/tmp/test26-cli-build.log 2>&1 \
  && pass "agent-network CLI builds in Docker" \
  || { fail "agent-network CLI build failed"; cat /tmp/test26-cli-build.log; }

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="

[ $FAIL -eq 0 ] && exit 0 || exit 1

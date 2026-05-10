#!/bin/bash
set -e
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

BASE="http://127.0.0.1:9200"
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"

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

echo ""
echo "========================================="
echo "  npm Package API Test"
echo "========================================="
echo ""

echo "1. npm install 3 packages"
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview @sleep2agi/commhub-server@preview >/tmp/npm-api-install.log 2>&1
pass "npm packages installed"
anet --version >/dev/null 2>&1 && pass "anet installed" || fail "anet missing"
agent-node --help >/dev/null 2>&1 && pass "agent-node installed" || fail "agent-node missing"
commhub-server --help >/dev/null 2>&1 && pass "commhub-server installed" || fail "commhub-server missing"
echo ""

echo "2. Start server"
COMMHUB_AUTH_TOKEN="$AUTH_TOKEN" commhub-server --port 9200 >/tmp/npm-api-server.log 2>&1 &
sleep 3
curl -s "$BASE/health" | grep -q '"ok":true' && pass "server started" || fail "server start"
echo ""

echo "3. Register + login owner"
REG1=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" -d '{"username":"npmowner","password":"pass123456"}')
echo "$REG1" | grep -q '"ok":true' && pass "owner register" || fail "owner register"
OWNER_UTOK=$(echo "$REG1" | json_get "token")
OWNER_NET_ID=$(echo "$REG1" | json_get "network_id")
[ -n "$OWNER_UTOK" ] && [ -n "$OWNER_NET_ID" ] && pass "owner register returned utok + network_id" || fail "owner register tokens missing"

LOGIN1=$(curl -s -X POST "$BASE/api/auth/login" -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" -d '{"username":"npmowner","password":"pass123456"}')
echo "$LOGIN1" | grep -q '"ok":true' && pass "owner login" || fail "owner login"
OWNER_UTOK=$(echo "$LOGIN1" | json_get "token")
OWNER_AUTH="Authorization: Bearer $OWNER_UTOK"
echo ""

echo "4. Create network + invite code"
NET_RES=$(curl -s -X POST "$BASE/api/networks" -H "$OWNER_AUTH" -H "Content-Type: application/json" -d '{"name":"npm-collab","description":"npm api test"}')
TEST_NET_ID=$(echo "$NET_RES" | json_get "network_id")
echo "$NET_RES" | grep -q '"ok":true' && [ -n "$TEST_NET_ID" ] && pass "owner created network" || fail "owner create network"

INVITE_RES=$(curl -s -X POST "$BASE/api/networks/$TEST_NET_ID/invite" -H "$OWNER_AUTH" -H "Content-Type: application/json" -d '{"role":"member","max_uses":1}')
INVITE_CODE=$(echo "$INVITE_RES" | json_get "invite_code")
echo "$INVITE_RES" | grep -q '"ok":true' && [ -n "$INVITE_CODE" ] && pass "owner created invite" || fail "owner create invite"
echo ""

echo "5. Register second user + join"
REG2=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" -d '{"username":"npmmember","password":"pass123456"}')
echo "$REG2" | grep -q '"ok":true' && pass "member register" || fail "member register"

LOGIN2=$(curl -s -X POST "$BASE/api/auth/login" -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" -d '{"username":"npmmember","password":"pass123456"}')
echo "$LOGIN2" | grep -q '"ok":true' && pass "member login" || fail "member login"
MEMBER_UTOK=$(echo "$LOGIN2" | json_get "token")
MEMBER_AUTH="Authorization: Bearer $MEMBER_UTOK"

JOIN_RES=$(curl -s -X POST "$BASE/api/networks/join" -H "$MEMBER_AUTH" -H "Content-Type: application/json" -d "{\"invite_code\":\"$INVITE_CODE\"}")
echo "$JOIN_RES" | grep -q '"ok":true' && pass "member joined network" || fail "member join network"
echo ""

echo "6. Create ntok"
NTOK_RES=$(curl -s -X POST "$BASE/api/auth/node-token" -H "$OWNER_AUTH" -H "Content-Type: application/json" -d "{\"network_id\":\"$TEST_NET_ID\",\"node_name\":\"npm-bot\"}")
OWNER_NTOK=$(echo "$NTOK_RES" | json_get "token")
echo "$NTOK_RES" | grep -q '"ok":true' && echo "$OWNER_NTOK" | grep -q '^ntok_' && pass "node token created" || fail "node token create"
echo ""

echo "7. Use ntok to call MCP send_task"
mcp_report_ntok='{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"report_status","arguments":{"resume_id":"npm-api-test","alias":"npm-bot","status":"idle","network_id":"'"$TEST_NET_ID"'"}}}'
mcp_send_ntok='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"npm-bot","task":"hello from npm api test","from_session":"npm-test","network_id":"'"$TEST_NET_ID"'"}}}'
NTOK_REPORT=$(curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $OWNER_NTOK" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$mcp_report_ntok")
echo "$NTOK_REPORT" | grep -q 'ok\\":true' && pass "ntok report_status works" || fail "ntok report_status"
NTOK_MCP=$(curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $OWNER_NTOK" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$mcp_send_ntok")
echo "$NTOK_MCP" | grep -q 'ok\\":true' && pass "ntok send_task works" || fail "ntok send_task"
echo ""

echo "8. Use utok to call MCP -> expect 403"
UTOK_STATUS=$(curl -s -o /tmp/npm-api-utok-mcp.txt -w "%{http_code}" -X POST "$BASE/mcp" -H "$OWNER_AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$mcp_send_ntok")
[ "$UTOK_STATUS" = "403" ] && pass "utok blocked from MCP" || fail "utok MCP expected 403 got $UTOK_STATUS"
echo ""

echo "9. Check /api/status and /api/tasks"
STATUS_RES=$(curl -s "$BASE/api/status?network_id=$TEST_NET_ID" -H "$OWNER_AUTH")
TASKS_RES=$(curl -s "$BASE/api/tasks?network_id=$TEST_NET_ID" -H "$OWNER_AUTH")
echo "$STATUS_RES" | grep -q 'npm-bot' && pass "/api/status shows node" || fail "/api/status missing node"
echo "$TASKS_RES" | grep -q 'hello from npm api test' && pass "/api/tasks shows task" || fail "/api/tasks missing task"
echo ""

echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1

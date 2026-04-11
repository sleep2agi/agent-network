#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║  Test 1: New User Experience (npm install → first task)  ║
# ║  Tests: install, server start, register, create, task    ║
# ╚══════════════════════════════════════════════════════╝
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "═══ Test 1: New User Experience ═══"
echo ""

BASE="http://127.0.0.1:9200"

# 1. Server startup
echo "1. Server startup"
cd /app/server && COMMHUB_AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}" bun run src/index.ts &
sleep 3
curl -s "$BASE/health" | grep -q '"ok":true' && pass "server started" || fail "server start"
curl -s "$BASE/health" | grep -q '"v3_auth":true' && pass "v3 auth enabled" || fail "v3 auth"
curl -s "$BASE/health" | grep -q '"multi_network":true' && pass "multi network" || fail "multi network"

# 2. Register first user (should be admin)
echo "2. Registration"
REG=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"newuser","password":"pass123456"}')
echo "$REG" | grep -q '"ok":true' && pass "register" || fail "register"
ROLE=$(echo "$REG" | python3 -c "import json,sys; print(json.load(sys.stdin).get('user',{}).get('role',''))" 2>/dev/null)
[ "$ROLE" = "admin" ] && pass "first user is admin" || fail "first user role: $ROLE"
TOKEN=$(echo "$REG" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "$TOKEN" | grep -q "^utok_" && pass "got user token (utok_)" || fail "token format: $TOKEN"
REST_AUTH="Authorization: Bearer $TOKEN"
NTOK=$(echo "$REG" | python3 -c "import json,sys; print(json.load(sys.stdin).get('network_token',''))" 2>/dev/null)

# 3. Auto-created network
echo "3. Default network"
NETS=$(curl -s "$BASE/api/networks" -H "$REST_AUTH")
echo "$NETS" | grep -q '"default"' && pass "default network created" || fail "no default network"
NET_ID=$(echo "$NETS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('networks',[])[0]['network_id'])" 2>/dev/null)
[ -n "$NET_ID" ] && pass "network_id present" || fail "no network_id"

# 4. Login
echo "4. Login"
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"newuser","password":"pass123456"}')
echo "$LOGIN" | grep -q '"ok":true' && pass "login" || fail "login"
echo "$LOGIN" | grep -q '"utok_' && pass "login returns utok_" || pass "login token (atok_ compat)"
# Update AUTH with fresh token from login (login rotates the old one)
TOKEN=$(echo "$LOGIN" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
REST_AUTH="Authorization: Bearer $TOKEN"

# 5. Auth/me
echo "5. Profile"
ME=$(curl -s "$BASE/api/auth/me" -H "$REST_AUTH")
echo "$ME" | grep -q '"newuser"' && pass "auth/me" || fail "auth/me"
echo "$ME" | grep -q '"networks"' && pass "networks in profile" || fail "no networks"

# 6. License
echo "6. License"
LIC=$(curl -s "$BASE/api/license")
echo "$LIC" | grep -q '"trial"' && pass "trial license" || fail "no trial"
echo "$LIC" | grep -q '"days_left"' && pass "days_left" || fail "no days_left"

# 7. Create node token
echo "7. Node token"
if echo "$NTOK" | grep -q '^ntok_'; then
  pass "register returned network token"
else
  NTOK_RES=$(curl -s -X POST "$BASE/api/auth/node-token" -H "$REST_AUTH" -H "Content-Type: application/json" -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"test-bot\"}")
  NTOK=$(echo "$NTOK_RES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
  echo "$NTOK_RES" | grep -q '"ok":true' && pass "node token created" || fail "node token"
fi
MCP_AUTH="Authorization: Bearer $NTOK"

# 8. MCP tools via node context
echo "8. MCP operations"
MCP_H=(-H "$MCP_AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
mcp() { timeout 5 curl -s -X POST "$BASE/mcp" "${MCP_H[@]}" -d "$1" 2>/dev/null || true; }

R=$(mcp '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"report_status","arguments":{"resume_id":"test-1","alias":"test-bot","status":"idle"}}}')
echo "$R" | grep -qE 'ok.*true' && pass "report_status" || fail "report_status"

R=$(mcp '{"jsonrpc":"2.0","id":"2","method":"tools/call","params":{"name":"send_task","arguments":{"alias":"test-bot","task":"hello world","from_session":"user"}}}')
echo "$R" | grep -qE 'ok.*true' && pass "send_task" || fail "send_task"

R=$(mcp '{"jsonrpc":"2.0","id":"3","method":"tools/call","params":{"name":"get_inbox","arguments":{"alias":"test-bot"}}}')
echo "$R" | grep -q 'hello world' && pass "get_inbox has task" || fail "get_inbox"

# 9. REST endpoints
echo "9. REST APIs"
curl -s "$BASE/api/status" -H "$REST_AUTH" | grep -q 'test-bot' && pass "GET /api/status" || fail "status"
curl -s "$BASE/api/tasks" -H "$REST_AUTH" | grep -q 'hello world' && pass "GET /api/tasks" || fail "tasks"
curl -s "$BASE/api/stats" -H "$REST_AUTH" | grep -q '"ok":true' && pass "GET /api/stats" || fail "stats"

# 10. Password change + re-login
echo "10. Password management"
PW=$(curl -s -X POST "$BASE/api/auth/password" -H "$REST_AUTH" -H "Content-Type: application/json" -d '{"old_password":"pass123456","new_password":"newpass789"}')
echo "$PW" | grep -q '"ok":true' && pass "change password" || fail "change password"
RELOGIN=$(curl -s -X POST "$BASE/api/auth/login" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"newuser","password":"newpass789"}')
echo "$RELOGIN" | grep -q '"ok":true' && pass "login with new password" || fail "new password login"

echo ""
echo "═══════════════════════════════════"
echo "  Test 1 Result: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""
[ $FAIL -eq 0 ] && exit 0 || exit 1

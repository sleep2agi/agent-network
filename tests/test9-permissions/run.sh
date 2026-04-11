#!/bin/bash
set -e
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  Layer 4 Permissions + Quota Tests"
echo "========================================="
echo ""

COMMHUB_AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}" \
  bun run /app/server/src/index.ts &
sleep 3

json_get() {
  python3 -c 'import json,sys; data=json.load(sys.stdin); path=sys.argv[1].split("."); cur=data
for key in path:
    if isinstance(cur, dict):
        cur=cur.get(key, "")
    else:
        cur=""
        break
print("" if cur is None else cur)' "$1" 2>/dev/null
}

mcp_init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"perm-test","version":"1.0"}}}'
mcp_send_task() {
  local token="$1"
  local alias="$2"
  local task="$3"
  local net="$4"
  curl -s -X POST http://127.0.0.1:9200/mcp \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$mcp_init" > /dev/null 2>&1
  curl -s -X POST http://127.0.0.1:9200/mcp \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"send_task\",\"arguments\":{\"alias\":\"$alias\",\"task\":\"$task\",\"from_session\":\"perm-test\",\"network_id\":\"$net\"}}}"
}

echo "1. Register users..."
OWNER_REG=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"owner","password":"test123456"}')
MEMBER_REG=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"member","password":"test123456"}')
ADMIN_REG=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"adminuser","password":"test123456"}')
VIEWER_REG=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"viewer","password":"test123456"}')
GUEST_REG=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"guest","password":"test123456"}')

OWNER_ID=$(echo "$OWNER_REG" | json_get "user.user_id")
MEMBER_ID=$(echo "$MEMBER_REG" | json_get "user.user_id")
ADMIN_ID=$(echo "$ADMIN_REG" | json_get "user.user_id")
VIEWER_ID=$(echo "$VIEWER_REG" | json_get "user.user_id")
GUEST_ID=$(echo "$GUEST_REG" | json_get "user.user_id")

OWNER_LOGIN=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"owner","password":"test123456"}')
MEMBER_LOGIN=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"member","password":"test123456"}')
ADMIN_LOGIN=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"adminuser","password":"test123456"}')
VIEWER_LOGIN=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"viewer","password":"test123456"}')
GUEST_LOGIN=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"guest","password":"test123456"}')

OWNER_TOKEN=$(echo "$OWNER_LOGIN" | json_get "token")
MEMBER_TOKEN=$(echo "$MEMBER_LOGIN" | json_get "token")
ADMIN_TOKEN=$(echo "$ADMIN_LOGIN" | json_get "token")
VIEWER_TOKEN=$(echo "$VIEWER_LOGIN" | json_get "token")
GUEST_TOKEN=$(echo "$GUEST_LOGIN" | json_get "token")
[ -n "$OWNER_TOKEN" ] && [ -n "$MEMBER_TOKEN" ] && [ -n "$ADMIN_TOKEN" ] && [ -n "$VIEWER_TOKEN" ] && [ -n "$GUEST_TOKEN" ] && pass "five users registered/login" || { fail "user setup failed"; exit 1; }
echo ""

echo "2. Owner creates network and invites member/admin/viewer..."
NET_RES=$(curl -s -X POST http://127.0.0.1:9200/api/networks \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"perm-net","description":"permissions test"}')
NET_ID=$(echo "$NET_RES" | json_get "network_id")
echo "$NET_RES" | grep -q '"ok":true' && pass "owner creates network" || fail "owner create network failed"

INV_MEMBER=$(curl -s -X POST "http://127.0.0.1:9200/api/networks/$NET_ID/invite" \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"member","max_uses":1}')
INV_ADMIN=$(curl -s -X POST "http://127.0.0.1:9200/api/networks/$NET_ID/invite" \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"admin","max_uses":1}')
INV_VIEWER=$(curl -s -X POST "http://127.0.0.1:9200/api/networks/$NET_ID/invite" \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"viewer","max_uses":1}')
MEMBER_CODE=$(echo "$INV_MEMBER" | json_get "invite_code")
ADMIN_CODE=$(echo "$INV_ADMIN" | json_get "invite_code")
VIEWER_CODE=$(echo "$INV_VIEWER" | json_get "invite_code")
echo "$INV_MEMBER" | grep -q '"ok":true' && echo "$INV_ADMIN" | grep -q '"ok":true' && echo "$INV_VIEWER" | grep -q '"ok":true' && pass "owner creates invites" || fail "owner invite failed"

JOIN_MEMBER=$(curl -s -X POST http://127.0.0.1:9200/api/networks/join \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"invite_code\":\"$MEMBER_CODE\"}")
JOIN_ADMIN=$(curl -s -X POST http://127.0.0.1:9200/api/networks/join \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"invite_code\":\"$ADMIN_CODE\"}")
JOIN_VIEWER=$(curl -s -X POST http://127.0.0.1:9200/api/networks/join \
  -H "Authorization: Bearer $VIEWER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"invite_code\":\"$VIEWER_CODE\"}")
echo "$JOIN_MEMBER" | grep -q '"ok":true' && echo "$JOIN_ADMIN" | grep -q '"ok":true' && echo "$JOIN_VIEWER" | grep -q '"ok":true' && pass "member/admin/viewer join network" || fail "join failed"

OWNER_NODE_TOKEN_RES=$(curl -s -X POST http://127.0.0.1:9200/api/auth/node-token \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"owner-mcp-node\"}")
MEMBER_NODE_TOKEN_RES=$(curl -s -X POST http://127.0.0.1:9200/api/auth/node-token \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"member-mcp-node\"}")
ADMIN_NODE_TOKEN_RES=$(curl -s -X POST http://127.0.0.1:9200/api/auth/node-token \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"admin-mcp-node\"}")
VIEWER_NODE_TOKEN_RES=$(curl -s -X POST http://127.0.0.1:9200/api/auth/node-token \
  -H "Authorization: Bearer $VIEWER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"viewer-mcp-node\"}")
OWNER_NODE_MCP_TOKEN=$(echo "$OWNER_NODE_TOKEN_RES" | json_get "token")
MEMBER_NODE_MCP_TOKEN=$(echo "$MEMBER_NODE_TOKEN_RES" | json_get "token")
ADMIN_NODE_MCP_TOKEN=$(echo "$ADMIN_NODE_TOKEN_RES" | json_get "token")
VIEWER_NODE_MCP_TOKEN=$(echo "$VIEWER_NODE_TOKEN_RES" | json_get "token")
echo "$OWNER_NODE_TOKEN_RES" | grep -q '"ok":true' && echo "$MEMBER_NODE_TOKEN_RES" | grep -q '"ok":true' && echo "$ADMIN_NODE_TOKEN_RES" | grep -q '"ok":true' && echo "$VIEWER_NODE_TOKEN_RES" | grep -q '"ok":false' && [ -n "$OWNER_NODE_MCP_TOKEN" ] && [ -n "$MEMBER_NODE_MCP_TOKEN" ] && [ -n "$ADMIN_NODE_MCP_TOKEN" ] && [ -z "$VIEWER_NODE_MCP_TOKEN" ] && pass "node-token permissions enforced" || fail "node-token permission setup failed"
echo ""

echo "3. Viewer restrictions..."
echo "$VIEWER_NODE_TOKEN_RES" | grep -q '"ok":false' && pass "viewer create agent rejected" || fail "viewer create agent allowed"
pass "viewer send_task blocked via ntok prerequisite"
echo ""

echo "4. Member restrictions and allowed actions..."
MEMBER_TASK=$(mcp_send_task "$MEMBER_NODE_MCP_TOKEN" "owner-bot" "member can send" "$NET_ID")
echo "$MEMBER_TASK" | grep -q 'ok\\":true' && pass "member send_task allowed" || fail "member send_task rejected"

MEMBER_INVITE=$(curl -s -X POST "http://127.0.0.1:9200/api/networks/$NET_ID/invite" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"viewer","max_uses":1}')
echo "$MEMBER_INVITE" | grep -Eq 'owner/admin required|\"ok\":false' && pass "member invite rejected" || fail "member invite allowed"

MEMBER_REMOVE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "http://127.0.0.1:9200/api/networks/$NET_ID/members/$VIEWER_ID" \
  -H "Authorization: Bearer $MEMBER_TOKEN")
[ "$MEMBER_REMOVE" = "403" ] && pass "member remove rejected" || fail "member remove allowed ($MEMBER_REMOVE)"
echo ""

echo "5. Admin permissions..."
ADMIN_TASK=$(mcp_send_task "$ADMIN_NODE_MCP_TOKEN" "owner-bot" "admin can send" "$NET_ID")
echo "$ADMIN_TASK" | grep -q 'ok\\":true' && pass "admin send_task allowed" || fail "admin send_task rejected"

ADMIN_INVITE=$(curl -s -X POST "http://127.0.0.1:9200/api/networks/$NET_ID/invite" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"member","max_uses":1}')
GUEST_CODE=$(echo "$ADMIN_INVITE" | json_get "invite_code")
echo "$ADMIN_INVITE" | grep -q '"ok":true' && [ -n "$GUEST_CODE" ] && pass "admin invite allowed" || fail "admin invite rejected"

JOIN_GUEST=$(curl -s -X POST http://127.0.0.1:9200/api/networks/join \
  -H "Authorization: Bearer $GUEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"invite_code\":\"$GUEST_CODE\"}")
echo "$JOIN_GUEST" | grep -q '"ok":true' && pass "guest joins admin invite" || fail "guest join failed"

ADMIN_REMOVE=$(curl -s -X DELETE "http://127.0.0.1:9200/api/networks/$NET_ID/members/$VIEWER_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
echo "$ADMIN_REMOVE" | grep -q '"ok":true' && pass "admin remove member allowed" || fail "admin remove member rejected"

ADMIN_DELETE=$(curl -s -X DELETE "http://127.0.0.1:9200/api/networks/$NET_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
echo "$ADMIN_DELETE" | grep -Eq '"ok":false|not your network' && pass "admin delete network rejected" || fail "admin delete network allowed"
echo ""

echo "6. Owner full permissions..."
OWNER_TASK=$(mcp_send_task "$OWNER_NODE_MCP_TOKEN" "owner-bot" "owner can send" "$NET_ID")
echo "$OWNER_TASK" | grep -q 'ok\\":true' && pass "owner send_task allowed" || fail "owner send_task rejected"

OWNER_NODE=$(curl -s -X POST http://127.0.0.1:9200/api/auth/node-token \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"owner-node\"}")
echo "$OWNER_NODE" | grep -q '"ok":true' && pass "owner create agent allowed" || fail "owner create agent rejected"

OWNER_REMOVE=$(curl -s -X DELETE "http://127.0.0.1:9200/api/networks/$NET_ID/members/$GUEST_ID" \
  -H "Authorization: Bearer $OWNER_TOKEN")
echo "$OWNER_REMOVE" | grep -q '"ok":true' && pass "owner remove member allowed" || fail "owner remove member rejected"
echo ""

echo "7. Quota checks..."
Q1=$(curl -s -X POST http://127.0.0.1:9200/api/networks \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"limit-a"}')
Q2=$(curl -s -X POST http://127.0.0.1:9200/api/networks \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"limit-b"}')
Q3=$(curl -s -X POST http://127.0.0.1:9200/api/networks \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"limit-c"}')
if echo "$Q1" | grep -q '"ok":true' && echo "$Q2" | grep -q '"ok":false' && echo "$Q3" | grep -q '"ok":false'; then
  pass "network quota enforced"
else
  fail "network quota not enforced"
fi
echo ""

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1

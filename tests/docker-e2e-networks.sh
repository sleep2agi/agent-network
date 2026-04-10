#!/bin/bash
set -e
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  V3 Network Management + Isolation Tests"
echo "========================================="
echo ""

cd /app/server && bun run src/index.ts &
sleep 3

# Setup: register 2 users
REG_A=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"netuser_a","password":"test123456"}')
TOKEN_A=$(echo "$REG_A" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('token',''))" 2>/dev/null)
# Login to get fresh token
LOGIN_A=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"netuser_a","password":"test123456"}')
TOKEN_A=$(echo "$LOGIN_A" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('token',''))" 2>/dev/null)

REG_B=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"netuser_b","password":"test123456"}')
LOGIN_B=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"netuser_b","password":"test123456"}')
TOKEN_B=$(echo "$LOGIN_B" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('token',''))" 2>/dev/null)

[ -n "$TOKEN_A" ] && [ -n "$TOKEN_B" ] && pass "2 users registered" || { fail "setup failed"; exit 1; }

# 1. Network CRUD
echo "1. Network CRUD..."
NET=$(curl -s -X POST http://127.0.0.1:9200/api/networks -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN_A" -d '{"name":"team-alpha","description":"Alpha team network"}')
echo "$NET" | grep -q '"ok":true' && pass "create network" || fail "create failed"
NET_A_ID=$(echo "$NET" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('network_id',''))" 2>/dev/null)

# Duplicate name
DUP=$(curl -s -X POST http://127.0.0.1:9200/api/networks -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN_A" -d '{"name":"team-alpha"}')
echo "$DUP" | grep -q '"ok":false' && pass "duplicate name rejected" || fail "duplicate accepted"

# User B creates own network
NET_B=$(curl -s -X POST http://127.0.0.1:9200/api/networks -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN_B" -d '{"name":"team-beta"}')
NET_B_ID=$(echo "$NET_B" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('network_id',''))" 2>/dev/null)
[ -n "$NET_B_ID" ] && pass "user B network created" || fail "user B net failed"
echo ""

# 2. Network list per user
echo "2. Network visibility..."
NETS_A=$(curl -s -H "Authorization: Bearer $TOKEN_A" http://127.0.0.1:9200/api/networks)
echo "$NETS_A" | grep -q 'team-alpha' && pass "user A sees alpha" || fail "A missing alpha"
echo "$NETS_A" | grep -q 'team-beta' && fail "A sees B's network!" || pass "A cannot see beta (isolated)"

NETS_B=$(curl -s -H "Authorization: Bearer $TOKEN_B" http://127.0.0.1:9200/api/networks)
echo "$NETS_B" | grep -q 'team-beta' && pass "user B sees beta" || fail "B missing beta"
echo "$NETS_B" | grep -q 'team-alpha' && fail "B sees A's network!" || pass "B cannot see alpha (isolated)"
echo ""

# 3. Network detail + ownership
echo "3. Network ownership..."
DETAIL_A=$(curl -s -H "Authorization: Bearer $TOKEN_A" "http://127.0.0.1:9200/api/networks/$NET_A_ID")
echo "$DETAIL_A" | grep -q '"ok":true' && pass "owner can view own network" || fail "owner view failed"

CROSS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN_B" "http://127.0.0.1:9200/api/networks/$NET_A_ID")
[ "$CROSS" = "403" ] && pass "cross-user access denied (403)" || fail "cross access: $CROSS"
echo ""

# 4. Data isolation via REST
echo "4. Data isolation..."
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"net-test","version":"1.0"}}}'
mcp_call() {
  curl -s -X POST http://127.0.0.1:9200/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$MCP_INIT" > /dev/null 2>&1
  curl -s -X POST http://127.0.0.1:9200/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}

# Send tasks to different networks
mcp_call "send_task" "{\"alias\":\"agent-a\",\"task\":\"alpha only\",\"from_session\":\"tester\",\"network_id\":\"$NET_A_ID\"}" > /dev/null
mcp_call "send_task" "{\"alias\":\"agent-b\",\"task\":\"beta only\",\"from_session\":\"tester\",\"network_id\":\"$NET_B_ID\"}" > /dev/null

# Query by network
TASKS_A=$(curl -s "http://127.0.0.1:9200/api/tasks?network_id=$NET_A_ID")
echo "$TASKS_A" | grep -q 'alpha only' && pass "alpha task in alpha network" || fail "alpha task missing"
echo "$TASKS_A" | grep -q 'beta only' && fail "beta task leaked to alpha!" || pass "beta NOT in alpha"

TASKS_B=$(curl -s "http://127.0.0.1:9200/api/tasks?network_id=$NET_B_ID")
echo "$TASKS_B" | grep -q 'beta only' && pass "beta task in beta network" || fail "beta task missing"
echo "$TASKS_B" | grep -q 'alpha only' && fail "alpha task leaked to beta!" || pass "alpha NOT in beta"
echo ""

# 5. Stats per network
echo "5. Network-scoped stats..."
STATS_A=$(curl -s "http://127.0.0.1:9200/api/stats?network_id=$NET_A_ID")
echo "$STATS_A" | grep -q '"ok":true' && pass "stats for alpha" || fail "stats failed"
echo "$STATS_A" | grep -q "\"network_id\":\"$NET_A_ID\"" && pass "stats scoped to alpha" || pass "stats has network_id"
echo ""

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1

#!/bin/bash
set -euo pipefail
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  V3 Network Management + Isolation Tests"
echo "========================================="
echo ""

(cd /app/server && exec bun run src/index.ts) &
HUB_PID=$!
cleanup() { kill "$HUB_PID" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:9200/health >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS http://127.0.0.1:9200/health >/dev/null

# Setup: register one bootstrap admin, then 2 ordinary users. The first
# registered account is intentionally the global admin and can see every
# network (#94), so it is not a valid tenant-isolation fixture.
curl -fsS -X POST http://127.0.0.1:9200/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"net_bootstrap_admin","password":"test123456"}' >/dev/null

REG_A=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"netuser_a","password":"test123456"}')
TOKEN_A=$(echo "$REG_A" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('token',''))" 2>/dev/null)
# Login to get fresh token
LOGIN_A=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"netuser_a","password":"test123456"}')
TOKEN_A=$(echo "$LOGIN_A" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('token',''))" 2>/dev/null)

REG_B=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"netuser_b","password":"test123456"}')
LOGIN_B=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"netuser_b","password":"test123456"}')
TOKEN_B=$(echo "$LOGIN_B" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('token',''))" 2>/dev/null)

# A separate ordinary owner keeps the delete fixture empty while A/B retain
# their networks for the isolation assertions above.
REG_C=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"netuser_c","password":"test123456"}')
TOKEN_C=$(echo "$REG_C" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('token',''))" 2>/dev/null)

[ -n "$TOKEN_A" ] && [ -n "$TOKEN_B" ] && [ -n "$TOKEN_C" ] \
  && pass "ordinary isolation and delete owners registered after bootstrap admin" \
  || { fail "setup failed"; exit 1; }

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
# #64: mcp_call takes user token as $3 to satisfy V3 auth (RFC-001 rejected master-token writes).
# Each network's send_task is authenticated as the owner of that network.
mcp_call() {
  local tok="$3"
  curl -s -X POST http://127.0.0.1:9200/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $tok" -d "$MCP_INIT" > /dev/null 2>&1
  curl -s -X POST http://127.0.0.1:9200/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $tok" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}

mcp_text_json() {
  python3 -c 'import json,sys
raw=sys.stdin.read().strip()
line=next((line[6:] for line in raw.splitlines() if line.startswith("data: ")), raw)
doc=json.loads(line)
text=doc.get("result",{}).get("content",[{}])[0].get("text","{}")
print(json.dumps(json.loads(text)))'
}

register_agent() {
  local alias=$1 net=$2 owner_token=$3 resume_id=$4
  local ntok report parsed
  ntok=$(curl -fsS -X POST http://127.0.0.1:9200/api/auth/node-token \
    -H "Authorization: Bearer $owner_token" -H "Content-Type: application/json" \
    -d "{\"network_id\":\"$net\",\"node_name\":\"$alias\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))')
  [[ "$ntok" == ntok_* ]] || return 1
  report=$(mcp_call report_status "{\"resume_id\":\"$resume_id\",\"alias\":\"$alias\",\"status\":\"idle\",\"network_id\":\"$net\"}" "$ntok")
  parsed=$(printf '%s' "$report" | mcp_text_json)
  printf '%s' "$parsed" | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True'
}

register_agent agent-a "$NET_A_ID" "$TOKEN_A" net-agent-a-resume
register_agent agent-b "$NET_B_ID" "$TOKEN_B" net-agent-b-resume
pass "network-scoped target aliases registered"

# Send tasks to different networks — each authenticated as the network owner.
SEND_A=$(mcp_call "send_task" "{\"alias\":\"agent-a\",\"task\":\"alpha only\",\"from_session\":\"tester\",\"network_id\":\"$NET_A_ID\"}" "$TOKEN_A" | mcp_text_json)
SEND_B=$(mcp_call "send_task" "{\"alias\":\"agent-b\",\"task\":\"beta only\",\"from_session\":\"tester\",\"network_id\":\"$NET_B_ID\"}" "$TOKEN_B" | mcp_text_json)
printf '%s' "$SEND_A" | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True' \
  && pass "send_task accepted in alpha" || fail "send_task alpha rejected"
printf '%s' "$SEND_B" | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True' \
  && pass "send_task accepted in beta" || fail "send_task beta rejected"

# A valid alias in another network must not make a cross-network write valid.
CROSS_SEND=$(mcp_call "send_task" "{\"alias\":\"agent-b\",\"task\":\"must not cross\",\"from_session\":\"tester\",\"network_id\":\"$NET_B_ID\"}" "$TOKEN_A" | mcp_text_json)
echo "  cross-network response: $CROSS_SEND"
if printf '%s' "$CROSS_SEND" | python3 -c 'import json,sys
d=json.load(sys.stdin); assert d.get("ok") is False and d.get("error") == "access_denied" and "network" in str(d.get("message","")).lower()'; then
  pass "user A cannot send into beta network"
else
  fail "cross-network send was not rejected"
fi

# Query by network — #64: query auth must match network owner (V3 isolation)
TASKS_A=$(curl -s -H "Authorization: Bearer $TOKEN_A" "http://127.0.0.1:9200/api/tasks?network_id=$NET_A_ID")
echo "$TASKS_A" | grep -q 'alpha only' && pass "alpha task in alpha network" || fail "alpha task missing"
echo "$TASKS_A" | grep -q 'beta only' && fail "beta task leaked to alpha!" || pass "beta NOT in alpha"

TASKS_B=$(curl -s -H "Authorization: Bearer $TOKEN_B" "http://127.0.0.1:9200/api/tasks?network_id=$NET_B_ID")
echo "$TASKS_B" | grep -q 'beta only' && pass "beta task in beta network" || fail "beta task missing"
echo "$TASKS_B" | grep -q 'alpha only' && fail "alpha task leaked to beta!" || pass "alpha NOT in beta"
echo ""

# 5. Stats per network — #64: V3 requires auth on /api/stats too
echo "5. Network-scoped stats..."
STATS_A=$(curl -s -H "Authorization: Bearer $TOKEN_A" "http://127.0.0.1:9200/api/stats?network_id=$NET_A_ID")
echo "$STATS_A" | grep -q '"ok":true' && pass "stats for alpha" || fail "stats failed"
echo "$STATS_A" | grep -q "\"network_id\":\"$NET_A_ID\"" && pass "stats scoped to alpha" || pass "stats has network_id"
echo ""

# 6. Network rename
echo "6. Network rename..."
REN=$(curl -s -X PUT "http://127.0.0.1:9200/api/networks/$NET_A_ID" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN_A" \
  -d '{"name":"alpha-renamed"}')
echo "$REN" | grep -q '"ok":true' && pass "rename network" || fail "rename failed"
# Verify in list
NETS_R=$(curl -s -H "Authorization: Bearer $TOKEN_A" http://127.0.0.1:9200/api/networks)
echo "$NETS_R" | grep -q 'alpha-renamed' && pass "renamed name in list" || fail "rename not reflected"
# Duplicate name rejected
# Collide with a network this user ALREADY owns, and read its name back from
# the API instead of assuming what registration called it.
#
# Creating a throwaway network for the collision does not work: the free plan
# caps max_networks_owned at 2 (auth.ts QUOTAS) and this user is already at
# the cap here (auto-created + alpha), so the create returns
# "quota exceeded" and the collision never exists.
DUP_NAME=$(curl -s -H "Authorization: Bearer $TOKEN_A" http://127.0.0.1:9200/api/networks \
  | python3 -c "import json,sys; ns=json.load(sys.stdin).get('networks',[]); print(next((n['network_name'] for n in ns if n['network_id']!='$NET_A_ID'),''))" 2>/dev/null)
[ -n "$DUP_NAME" ] && pass "found an owned network to collide with ($DUP_NAME)" || fail "no second owned network — collision premise absent"
DUP_REN=$(curl -s -X PUT "http://127.0.0.1:9200/api/networks/$NET_A_ID" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN_A" \
  -d "{\"name\":\"$DUP_NAME\"}")
echo "$DUP_REN" | grep -q '"ok":false' && pass "rename to existing name rejected" || fail "dup rename accepted"
echo ""

# 7. Network delete
echo "7. Network delete..."
# Reject the foreign delete without destroying A's populated isolation
# fixture, then use ordinary user C's empty second network for owner delete.
CROSS_DEL=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "http://127.0.0.1:9200/api/networks/$NET_A_ID" -H "Authorization: Bearer $TOKEN_B")
[ "$CROSS_DEL" = "400" ] || [ "$CROSS_DEL" = "403" ] \
  && pass "cross-user delete rejected" || fail "cross-user delete returned $CROSS_DEL"
DEL_NET=$(curl -s -X POST http://127.0.0.1:9200/api/networks \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN_C" \
  -d '{"name":"to-delete"}')
DEL_ID=$(echo "$DEL_NET" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('network_id',''))" 2>/dev/null)
DEL_RES=$(curl -s -X DELETE "http://127.0.0.1:9200/api/networks/$DEL_ID" -H "Authorization: Bearer $TOKEN_C")
echo "$DEL_RES" | grep -q '"ok":true' && pass "owner deletes network" || fail "delete failed"
# Verify gone
NETS_D=$(curl -s -H "Authorization: Bearer $TOKEN_C" http://127.0.0.1:9200/api/networks)
echo "$NETS_D" | grep -q 'to-delete' && fail "deleted network still in list" || pass "deleted network gone"
echo ""

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1

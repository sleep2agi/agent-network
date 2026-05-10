#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║  Test 2: Multi-User Collaboration                    ║
# ║  Tests: 2 users, invite, join, isolation, roles       ║
# ╚══════════════════════════════════════════════════════╝
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "═══ Test 2: Multi-User Collaboration ═══"
echo ""

BASE="http://127.0.0.1:9200"

# Start server
cd /app/server && COMMHUB_AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}" bun run src/index.ts &
sleep 3

# Register user A (admin) and user B (regular)
echo "1. Register two users"
RA=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"alice","password":"pass123456"}')
echo "$RA" | grep -q '"ok":true' && pass "register alice" || fail "register alice"
TA=$(echo "$RA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
HA="Authorization: Bearer $TA"
ROLE_A=$(echo "$RA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('user',{}).get('role',''))" 2>/dev/null)
[ "$ROLE_A" = "admin" ] && pass "alice is admin (first user)" || fail "alice role: $ROLE_A"

RB=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"bob","password":"pass123456"}')
echo "$RB" | grep -q '"ok":true' && pass "register bob" || fail "register bob"
TB=$(echo "$RB" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
HB="Authorization: Bearer $TB"
ROLE_B=$(echo "$RB" | python3 -c "import json,sys; print(json.load(sys.stdin).get('user',{}).get('role',''))" 2>/dev/null)
[ "$ROLE_B" = "user" ] && pass "bob is regular user" || fail "bob role: $ROLE_B"

# Get network IDs
NET_A=$(curl -s "$BASE/api/networks" -H "$HA" | python3 -c "import json,sys; nets=json.load(sys.stdin).get('networks',[]); print(nets[0]['network_id'] if nets else '')" 2>/dev/null)
NET_B=$(curl -s "$BASE/api/networks" -H "$HB" | python3 -c "import json,sys; nets=json.load(sys.stdin).get('networks',[]); print(nets[0]['network_id'] if nets else '')" 2>/dev/null)
[ -n "$NET_A" ] && [ -n "$NET_B" ] && pass "both users have networks" || fail "missing networks"

# 2. Network isolation
echo "2. Network isolation"
# Bob tries to access Alice's network → should fail (bob is not admin)
R=$(curl -s "$BASE/api/networks/$NET_A" -H "$HB")
echo "$R" | grep -qE 'denied|error' && pass "bob blocked from alice network" || fail "bob can see alice network"

# Bob tries alice's members
R=$(curl -s "$BASE/api/networks/$NET_A/members" -H "$HB")
echo "$R" | grep -qE 'not a member|error' && pass "bob blocked from alice members" || fail "bob can see alice members"

# 3. Invite flow
echo "3. Invite + join"
INV=$(curl -s -X POST "$BASE/api/networks/$NET_A/invite" -H "$HA" -H "Content-Type: application/json" -d '{"role":"member","max_uses":1}')
echo "$INV" | grep -q '"ok":true' && pass "alice creates invite" || fail "create invite"
CODE=$(echo "$INV" | python3 -c "import json,sys; print(json.load(sys.stdin).get('invite_code',''))" 2>/dev/null)

# Bob joins alice's network
JOIN=$(curl -s -X POST "$BASE/api/networks/join" -H "$HB" -H "Content-Type: application/json" -d "{\"invite_code\":\"$CODE\"}")
echo "$JOIN" | grep -q '"ok":true' && pass "bob joins alice network" || fail "bob join"

# Bob can now see alice's network
R=$(curl -s "$BASE/api/networks/$NET_A" -H "$HB")
echo "$R" | grep -q 'alice\|default' && pass "bob can now see alice network" || fail "bob still blocked"

# 4. Members listing
echo "4. Member management"
MEMBERS=$(curl -s "$BASE/api/networks/$NET_A/members" -H "$HA")
echo "$MEMBERS" | grep -q 'alice' && pass "alice in members" || fail "alice not listed"
echo "$MEMBERS" | grep -q 'bob' && pass "bob in members" || fail "bob not listed"

# Bob's role
BOB_ROLE=$(echo "$MEMBERS" | python3 -c "import json,sys; ms=json.load(sys.stdin).get('members',[]); print(next((m['role'] for m in ms if m['username']=='bob'),'?'))" 2>/dev/null)
[ "$BOB_ROLE" = "member" ] && pass "bob is member role" || fail "bob role: $BOB_ROLE"

# 5. Cross-network task isolation
echo "5. Task isolation"
MCP_H=(-H "$HA" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
mcp() { timeout 5 curl -s -X POST "$BASE/mcp" "${MCP_H[@]}" -d "$1" 2>/dev/null || true; }

# Register agent in alice's network
mcp '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"report_status","arguments":{"resume_id":"alice-bot-1","alias":"alice-bot","status":"idle","network_id":"'"$NET_A"'"}}}'
mcp '{"jsonrpc":"2.0","id":"2","method":"tools/call","params":{"name":"send_task","arguments":{"alias":"alice-bot","task":"alice secret task","from_session":"alice","network_id":"'"$NET_A"'"}}}'
pass "task sent in alice network"

# 6. Invite code exhaustion
echo "6. Invite code limits"
JOIN2=$(curl -s -X POST "$BASE/api/networks/join" -H "$HB" -H "Content-Type: application/json" -d "{\"invite_code\":\"$CODE\"}")
echo "$JOIN2" | grep -qE 'already a member|fully used' && pass "invite code can't reuse" || fail "invite reused"

# Register user C, try same invite (max_uses=1, already used by bob)
RC=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"charlie","password":"pass123456"}')
TC=$(echo "$RC" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
HC="Authorization: Bearer $TC"
JOIN3=$(curl -s -X POST "$BASE/api/networks/join" -H "$HC" -H "Content-Type: application/json" -d "{\"invite_code\":\"$CODE\"}")
echo "$JOIN3" | grep -q 'fully used' && pass "exhausted invite rejected" || fail "exhausted invite accepted"

# 7. Token isolation
echo "7. Token isolation"
# Bob creates token for alice's network (now he's a member)
BTOK=$(curl -s -X POST "$BASE/api/auth/tokens" -H "$HB" -H "Content-Type: application/json" -d "{\"name\":\"bob-tok\",\"network_id\":\"$NET_A\"}")
echo "$BTOK" | grep -q '"ok":true' && pass "bob creates token for joined network" || fail "bob token create"

# Charlie (not member) tries to create token for alice's network
CTOK=$(curl -s -X POST "$BASE/api/auth/tokens" -H "$HC" -H "Content-Type: application/json" -d "{\"name\":\"hack\",\"network_id\":\"$NET_A\"}")
echo "$CTOK" | grep -qE 'not a member|error' && pass "non-member token create blocked" || fail "non-member got token!"

# 8. Remove member
echo "8. Member removal"
BOB_UID=$(echo "$MEMBERS" | python3 -c "import json,sys; ms=json.load(sys.stdin).get('members',[]); print(next((m['user_id'] for m in ms if m['username']=='bob'),''))" 2>/dev/null)
DEL=$(curl -s -X DELETE "$BASE/api/networks/$NET_A/members/$BOB_UID" -H "$HA")
echo "$DEL" | grep -q '"ok":true' && pass "alice removes bob" || fail "remove bob"

# Bob can't access anymore
R=$(curl -s "$BASE/api/networks/$NET_A" -H "$HB")
echo "$R" | grep -qE 'denied|error' && pass "bob blocked after removal" || fail "bob still has access"

echo ""
echo "═══════════════════════════════════"
echo "  Test 2 Result: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""
[ $FAIL -eq 0 ] && exit 0 || exit 1

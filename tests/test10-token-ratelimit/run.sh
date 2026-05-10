#!/bin/bash
set -e
PASS=0
FAIL=0
BASE="http://127.0.0.1:9200"
DB_PATH="/root/.commhub/commhub.db"

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

json_get() {
  local expr="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); print($expr)" 2>/dev/null
}

mcp_call() {
  local token="$1"
  local tool="$2"
  local args_json="$3"
  curl -s -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test10","version":"1.0"}}}' \
    > /dev/null 2>&1 || true
  curl -s -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"2\",\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args_json}}"
}

echo ""
echo "========================================="
echo "  Test 10: Token Boundaries + Rate Limit"
echo "========================================="
echo ""

COMMHUB_AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}" bun run /app/server/src/index.ts &
sleep 3

echo "1. Setup users and networks..."
REG_A=$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d '{"username":"tokenuser","password":"pass123456"}')
echo "$REG_A" | grep -q '"ok":true' && pass "register tokenuser" || { fail "register tokenuser"; exit 1; }
UTOK=$(echo "$REG_A" | json_get "data.get('token','')")
NTOK_DEFAULT=$(echo "$REG_A" | json_get "data.get('network_token','')")
NET1=$(echo "$REG_A" | json_get "data.get('network_id','')")
LOGIN_A=$(curl -s -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"username":"tokenuser","password":"pass123456"}')
UTOK=$(echo "$LOGIN_A" | json_get "data.get('token','')")

NET2_RES=$(curl -s -X POST "$BASE/api/networks" -H "Authorization: Bearer $UTOK" -H "Content-Type: application/json" -d '{"name":"second-net"}')
NET2=$(echo "$NET2_RES" | json_get "data.get('network_id','')")
NODE2=$(curl -s -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" -H "Content-Type: application/json" -d "{\"network_id\":\"$NET2\",\"node_name\":\"worker-net2\"}")
NTOK_NET2=$(echo "$NODE2" | json_get "data.get('token','')")

REG_B=$(curl -s -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d '{"username":"otheruser","password":"pass123456"}')
NET_OTHER=$(echo "$REG_B" | json_get "data.get('network_id','')")

[ -n "$UTOK" ] && [ -n "$NTOK_DEFAULT" ] && [ -n "$NET1" ] && [ -n "$NET2" ] && [ -n "$NTOK_NET2" ] && [ -n "$NET_OTHER" ] \
  && pass "setup tokens and networks" || { fail "setup tokens and networks"; exit 1; }
echo ""

echo "2. Dual token boundary..."
ME=$(curl -s -H "Authorization: Bearer $UTOK" "$BASE/api/auth/me")
echo "$ME" | grep -q '"ok":true' && pass "utok can access /api/auth/me" || fail "utok auth/me"
NETS=$(curl -s -H "Authorization: Bearer $UTOK" "$BASE/api/networks")
echo "$NETS" | grep -q '"ok":true' && pass "utok can access /api/networks" || fail "utok networks"

UTOK_MCP=$(mcp_call "$UTOK" "report_status" "{\"resume_id\":\"utok-test\",\"alias\":\"utok-agent\",\"status\":\"idle\",\"network_id\":\"$NET1\"}")
echo "$UTOK_MCP" | grep -q '"ok":false\|"error"' && pass "utok blocked from MCP tool" || fail "utok unexpectedly allowed MCP tool"

NTOK_MCP=$(mcp_call "$NTOK_DEFAULT" "report_status" "{\"resume_id\":\"ntok-test\",\"alias\":\"node-a\",\"status\":\"idle\",\"network_id\":\"$NET1\"}")
STATUS_NODE_A=$(curl -s -H "Authorization: Bearer $UTOK" "$BASE/api/status?network_id=$NET1")
echo "$STATUS_NODE_A" | grep -q 'node-a' && pass "ntok can operate MCP in bound network" || fail "ntok MCP failed"

NTOK_CROSS=$(mcp_call "$NTOK_DEFAULT" "report_status" "{\"resume_id\":\"ntok-cross\",\"alias\":\"node-cross\",\"status\":\"idle\",\"network_id\":\"$NET2\"}")
STATUS_NET2=$(curl -s -H "Authorization: Bearer $UTOK" "$BASE/api/status?network_id=$NET2")
echo "$STATUS_NET2" | grep -q 'node-cross' && fail "ntok wrote into other network" || pass "ntok cannot affect other network"
STATUS_NET1=$(curl -s -H "Authorization: Bearer $UTOK" "$BASE/api/status?network_id=$NET1")
echo "$STATUS_NET1" | grep -q 'node-cross' && pass "ntok stays bound to original network" || fail "ntok did not land in bound network"

OTHER_NET=$(curl -s -H "Authorization: Bearer $NTOK_DEFAULT" "$BASE/api/networks")
echo "$OTHER_NET" | grep -q 'second-net' && fail "ntok can list unrelated networks" || pass "ntok only sees bound network"
echo ""

echo "3. Revoked and expired tokens..."
FULL_CREATE=$(curl -s -X POST "$BASE/api/auth/tokens" -H "Authorization: Bearer $UTOK" -H "Content-Type: application/json" -d '{"name":"revoked-soon"}')
FULL_TOKEN=$(echo "$FULL_CREATE" | json_get "data.get('token','')")
FULL_ID=$(echo "$FULL_CREATE" | json_get "data.get('token_id','')")
[ -n "$FULL_TOKEN" ] && [ -n "$FULL_ID" ] && pass "create full token" || fail "create full token"

REVOKE=$(curl -s -X DELETE "$BASE/api/auth/tokens/$FULL_ID" -H "Authorization: Bearer $UTOK")
echo "$REVOKE" | grep -q '"ok":true' && pass "revoke token API" || fail "revoke token API"
REVOKED_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $FULL_TOKEN" "$BASE/api/auth/me")
[ "$REVOKED_CODE" = "401" ] && pass "revoked token rejected immediately" || fail "revoked token still works ($REVOKED_CODE)"

EXP_CREATE=$(curl -s -X POST "$BASE/api/auth/tokens" -H "Authorization: Bearer $UTOK" -H "Content-Type: application/json" -d '{"name":"expire-soon"}')
EXP_TOKEN=$(echo "$EXP_CREATE" | json_get "data.get('token','')")
EXP_ID=$(echo "$EXP_CREATE" | json_get "data.get('token_id','')")
python3 - "$DB_PATH" "$EXP_ID" <<'PY'
import sqlite3, sys
db_path, token_id = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
conn.execute("UPDATE api_tokens SET expires_at = datetime('now', '-1 minute') WHERE token_id = ?", (token_id,))
conn.commit()
conn.close()
PY
EXP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $EXP_TOKEN" "$BASE/api/networks")
[ "$EXP_CODE" = "401" ] && pass "expired token rejected" || fail "expired token still works ($EXP_CODE)"
echo ""

echo "4. Rate limit..."
for i in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/login" \
    -H "Content-Type: application/json" -H "X-Forwarded-For: 9.9.9.9" \
    -d '{"username":"tokenuser","password":"wrongpass"}')
  [ "$code" = "401" ] || { fail "login attempt $i expected 401 got $code"; break; }
done
LOGIN_11=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" -H "X-Forwarded-For: 9.9.9.9" \
  -d '{"username":"tokenuser","password":"wrongpass"}')
[ "$LOGIN_11" = "429" ] && pass "11th login attempt hits 429" || fail "11th login attempt expected 429 got $LOGIN_11"

for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/register" \
    -H "Content-Type: application/json" -H "X-Forwarded-For: 8.8.8.8" \
    -d "{\"username\":\"rlreg$i\",\"password\":\"pass123456\"}")
  [ "$code" = "200" ] || { fail "register attempt $i expected 200 got $code"; break; }
done
REG_31=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" -H "X-Forwarded-For: 8.8.8.8" \
  -d '{"username":"rlreg31","password":"pass123456"}')
[ "$REG_31" = "429" ] && pass "31st register attempt hits 429" || fail "31st register attempt expected 429 got $REG_31"
echo ""

echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1

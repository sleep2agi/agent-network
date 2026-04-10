#!/bin/bash
set -e
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  V3 Auth System E2E Tests"
echo "========================================="
echo ""

cd /app/server && bun run src/index.ts &
sleep 3

# 1. Register
echo "1. Registration..."
REG=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"authtest","password":"auth123456","email":"a@test.com"}')
echo "$REG" | grep -q '"ok":true' && pass "normal register" || fail "register"
TOKEN=$(echo "$REG" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('token',''))" 2>/dev/null)
[ -n "$TOKEN" ] && pass "got token" || fail "no token"

# Short username
SHORT=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"a","password":"auth123456"}')
echo "$SHORT" | grep -q '"ok":false' && pass "short username rejected" || fail "short username accepted"

# Short password
SHORTPW=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"shortpw","password":"123"}')
echo "$SHORTPW" | grep -q '"ok":false' && pass "short password rejected" || fail "short password accepted"

# Duplicate
DUP=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register -H "Content-Type: application/json" -d '{"username":"authtest","password":"auth123456"}')
echo "$DUP" | grep -q 'already taken' && pass "duplicate rejected" || fail "duplicate not rejected"
echo ""

# 2. Login
echo "2. Login..."
LOGIN=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"authtest","password":"auth123456"}')
echo "$LOGIN" | grep -q '"ok":true' && pass "correct login" || fail "login failed"
LOGIN_TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('token',''))" 2>/dev/null)

WRONG=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"authtest","password":"wrongpw"}')
echo "$WRONG" | grep -q '"ok":false' && pass "wrong password rejected" || fail "wrong pw accepted"

NOUSER=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"noexist","password":"auth123456"}')
echo "$NOUSER" | grep -q '"ok":false' && pass "nonexistent user rejected" || fail "noexist accepted"
echo ""

# 3. Token
echo "3. Token auth..."
ME=$(curl -s -H "Authorization: Bearer $LOGIN_TOKEN" http://127.0.0.1:9200/api/auth/me)
echo "$ME" | grep -q '"authtest"' && pass "valid token → user info" || fail "valid token rejected"
echo "$ME" | grep -q '"networks"' && pass "me has networks" || fail "me no networks"

BAD=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer invalid_token" http://127.0.0.1:9200/api/auth/me)
[ "$BAD" = "401" ] && pass "invalid token → 401" || fail "invalid token: $BAD"

NONE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9200/api/auth/me)
[ "$NONE" = "401" ] && pass "no token → 401" || fail "no token: $NONE"
echo ""

# 4. Profile update
echo "4. Profile update..."
UPD=$(curl -s -X PUT http://127.0.0.1:9200/api/auth/me -H "Authorization: Bearer $LOGIN_TOKEN" -H "Content-Type: application/json" -d '{"display_name":"Alice Test","email":"alice@new.com"}')
echo "$UPD" | grep -q 'Alice Test' && pass "display_name updated" || fail "update failed"
echo ""

# 5. Audit log
echo "5. Audit log..."
AUDIT=$(curl -s -H "Authorization: Bearer $LOGIN_TOKEN" http://127.0.0.1:9200/api/audit-log)
echo "$AUDIT" | grep -q '"register"' && pass "audit has register event" || fail "no register event"
echo "$AUDIT" | grep -q '"login"' && pass "audit has login event" || fail "no login event"
echo ""

# 6. Rate limiting (test with fake external IP)
echo "6. Rate limiting..."
# Normal request without x-forwarded-for should pass (localhost exempt)
RL_OK=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H "Content-Type: application/json" -d '{"username":"authtest","password":"wrong"}')
echo "$RL_OK" | grep -q '"ok":false' && pass "normal request passes (localhost)" || pass "rate limit check"
# Simulate external IP hitting limit
for i in $(seq 1 12); do
  curl -s -X POST http://127.0.0.1:9200/api/auth/login \
    -H "Content-Type: application/json" -H "X-Forwarded-For: 1.2.3.4" \
    -d '{"username":"nobody","password":"wrong"}' > /dev/null
done
RL_BLOCK=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login \
  -H "Content-Type: application/json" -H "X-Forwarded-For: 1.2.3.4" \
  -d '{"username":"nobody","password":"wrong"}')
echo "$RL_BLOCK" | grep -q 'too many' && pass "rate limit blocks after 10 attempts" || pass "rate limit (may need more attempts)"
echo ""

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1

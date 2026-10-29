#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║  Test 3: Security + Boundaries                       ║
# ║  Tests: injection, auth bypass, rate limit, fuzz      ║
# ╚══════════════════════════════════════════════════════╝
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "═══ Test 3: Security + Boundaries ═══"
echo ""

# 🔴 这一行不是装饰：门（check-l1-sha-binding）要的是「这次运行钉在哪个提交上」。
# 照 tests/test746-setup-bun-pin/run.sh:8 的最强写法 —— 断言 40 位小写十六进制，
# 拿不到就退出；否则 qa.sh 不传 --build-arg 时会**静默**跑在一个钉不住的构建上。
[[ "${SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "❌ SOURCE_COMMIT must be one full lowercase Git SHA (got: ${SOURCE_COMMIT:-<unset>})" >&2
  exit 1
}
printf 'source_commit=%s\n' "$SOURCE_COMMIT"

BASE="http://127.0.0.1:9200"

cd /app/server && COMMHUB_AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}" bun run src/index.ts &

# Wait for server to be healthy (up to 15s)
for i in $(seq 1 30); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "$BASE/health" >/dev/null 2>&1 || { echo "❌ server failed to start"; exit 1; }

# Register a user for testing
REG=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"sectest","password":"pass123456"}')
TOKEN=$(echo "$REG" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
AUTH="Authorization: Bearer $TOKEN"

# 1. Auth bypass attempts
echo "1. Auth bypass"
R=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/status")
[ "$R" = "401" ] && pass "no token → 401" || fail "no token → $R"

R=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/status" -H "Authorization: Bearer fake_token_123")
[ "$R" = "401" ] && pass "fake token → 401" || fail "fake token → $R"

R=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/status" -H "Authorization: Bearer ")
[ "$R" = "401" ] && pass "empty bearer → 401" || fail "empty bearer → $R"

curl -s "$BASE/health" | grep -q '"ok":true' && pass "health no auth needed" || fail "health requires auth"

# 2. SQL injection
echo "2. SQL injection"
R=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"admin\"; DROP TABLE users; --","password":"pass123456"}')
echo "$R" | grep -qE 'error|invalid' && pass "SQL injection in username blocked" || fail "SQL injection not blocked"

R=$(curl -s -X POST "$BASE/api/auth/login" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"\" OR 1=1 --","password":"x"}')
echo "$R" | grep -q '"ok":false' && pass "SQL injection in login blocked" || fail "login SQL injection"

# Verify DB intact
curl -s "$BASE/api/auth/me" -H "$AUTH" | grep -q '"sectest"' && pass "DB intact after injection" || fail "DB corrupted"

# 3. Input validation
echo "3. Input validation"
# Long username
LONG=$(python3 -c "print('A'*10000)")
R=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d "{\"username\":\"$LONG\",\"password\":\"pass123456\"}")
echo "$R" | grep -qE 'error|too long' && pass "long username rejected" || fail "long username accepted"

# Short password
R=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"shortpw","password":"12"}')
# 🔴 2026-08-31：原判据是 `grep -q 'at least 6'` —— 它把断言钉在**服务端的一句文案**上。
# 服务端此后把策略从 6 收紧成了分档（server/src/auth.ts）：
#   第一个用户（bootstrap admin，允许好记的默认口令） < 4 → "at least 4 characters"
#   其余用户                                            < 8 → "at least 8 characters"
# 于是这条断言红了，而它的名字叫 `short password accepted` —— **读起来像服务端接受了
# 弱密码，真相相反：策略收紧了，是断言停在旧文案上。** 一个不跑的套件里，
# 这种断言名比它的代码更危险。
#
# 改成判**行为**而不是**文案**：2 位密码必须被拒（ok:false / 有 error），
# 具体最小长度是几由服务端决定，套件不复述。
echo "$R" | python3 -c "
import json,sys
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception: sys.exit(1)
sys.exit(0 if (d.get('ok') is False or d.get('error')) else 1)
" && pass "short password rejected (2 chars)" || fail "short password accepted (2 chars): $R"

# Empty body
R=$(curl -s -X POST "$BASE/api/auth/login" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{}')
echo "$R" | grep -qE 'error|invalid' && pass "empty login body rejected" || fail "empty body accepted"

# Malformed JSON
R=$(curl -s -X POST "$BASE/api/auth/login" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d 'not{json')
echo "$R" | grep -qE 'error|invalid|JSON' && pass "malformed JSON rejected" || fail "malformed JSON accepted"

# Special characters in fields
R=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"<script>alert(1)</script>","password":"pass123456"}')
echo "$R" | grep -qE 'error|invalid' && pass "XSS in username blocked" || fail "XSS in username accepted"

# 4. Token security
echo "4. Token security"
# Create token
TKCR=$(curl -s -X POST "$BASE/api/auth/tokens" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"sec-tok"}')
echo "$TKCR" | grep -q '"ok":true' && pass "create token" || fail "create token"
TK_ID=$(echo "$TKCR" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token_id',''))" 2>/dev/null)

# Revoke it
curl -s -X DELETE "$BASE/api/auth/tokens/$TK_ID" -H "$AUTH" | grep -q '"ok":true' && pass "revoke token" || fail "revoke"

# Use revoked token
REVOKED=$(echo "$TKCR" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
R=$(curl -s "$BASE/api/auth/me" -H "Authorization: Bearer $REVOKED")
echo "$R" | grep -qE 'invalid|401|error' && pass "revoked token rejected" || fail "revoked token still works"

# 5. Cross-user token escalation (通信牛 found this)
echo "5. Privilege escalation"
# Register user B
RB=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer ${COMMHUB_AUTH_TOKEN:-test-auth-token}" -H "Content-Type: application/json" -d '{"username":"victim","password":"pass123456"}')
NET_B=$(echo "$RB" | python3 -c "import json,sys; print(json.load(sys.stdin).get('network_id',''))" 2>/dev/null)

# sectest tries to create token for victim's network
R=$(curl -s -X POST "$BASE/api/auth/tokens" -H "$AUTH" -H "Content-Type: application/json" -d "{\"name\":\"hack\",\"network_id\":\"$NET_B\"}")
echo "$R" | grep -qE 'not a member|error' && pass "cross-network token blocked" || fail "privilege escalation possible!"

# 6. License tampering —— 🔴 2026-10-29 起这条检查改成「端点必须不存在」。
#
# 纯开源版删掉了 license / 激活码体系（PR #3200）：
#   GET  /api/license           → 删除
#   POST /api/license/activate  → 删除（它原本**完全没有鉴权**，还会 DELETE FROM licenses）
# 因此这里不再断言「坏 key 被拒 / 好 key 变 pro」，而是断言「这两条路都走不通」。
# 用「存在性」断言而不是 404：未认证请求会先被全局鉴权拦成 401，
# 只有带令牌才看得到 404（实测两种都试过）。
echo "6. License（已删除，只验证不可达）"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/license/activate" -H "Content-Type: application/json" -d '{"key":"anet-TEST-1234-5678-ABCD"}')
case "$CODE" in
  401|403|404) pass "license activate unreachable (HTTP $CODE)" ;;
  *) fail "license activate still reachable (HTTP $CODE) — the unauthenticated delete-the-table endpoint is back" ;;
esac
CODE2=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/license")
case "$CODE2" in
  401|403|404) pass "license status unreachable (HTTP $CODE2)" ;;
  *) fail "license status still reachable (HTTP $CODE2)" ;;
esac

# 7. MCP without proper auth
echo "7. MCP auth"
MCP_H=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/mcp" "${MCP_H[@]}" -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"get_all_status","arguments":{}}}')
[ "$R" = "401" ] && pass "MCP without token → 401" || fail "MCP no auth → $R"

echo ""
echo "═══════════════════════════════════"
echo "  Test 3 Result: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""
[ $FAIL -eq 0 ] && exit 0 || exit 1

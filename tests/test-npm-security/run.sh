#!/bin/bash
# NPM package security boundary test


# SHA 绑定。🔴 变量名必须能被 scripts/qa.sh:359 的 `^ARG (SOURCE_COMMIT|TEST[0-9]+_SOURCE_COMMIT)`
# 匹配到，否则 qa.sh **不传且不报错**。本套件名里没有数字 ⇒ 只能用裸 SOURCE_COMMIT。
[[ "${SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$SOURCE_COMMIT"

PASS=0
FAIL=0
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

mcp_init_call() {
  local token="$1"
  curl -s -o /tmp/mcp.out -w "%{http_code}" -X POST http://127.0.0.1:9200/mcp \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"npm-security","version":"1.0"}}}'
}

mcp_tool_call() {
  local token="$1"
  local tool="$2"
  local args="$3"
  curl -s -o /tmp/mcp.out -w "%{http_code}" -X POST http://127.0.0.1:9200/mcp \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":${args}}}"
}

mcp_ok() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
for line in raw.strip().split("\n"):
    if line.startswith("data: "):
        raw = line[6:]
try:
    doc = json.loads(raw)
    text = doc.get("result", {}).get("content", [{}])[0].get("text", "{}")
    payload = json.loads(text)
    print("true" if payload.get("ok") else "false")
except Exception:
    print("false")
'
}

echo ""
echo "========================================="
echo "  NPM Security Boundary Test"
echo "========================================="
echo ""

echo "1. npm install 3 published packages..."
npm install -g @sleep2agi/commhub-server@0.5.0-preview.28 @sleep2agi/agent-network@2.0.0-preview.28 @sleep2agi/agent-node@2.1.0-preview.8 >/tmp/npm-install.log 2>&1
[ $? -eq 0 ] && pass "npm packages installed" || { cat /tmp/npm-install.log; fail "npm install failed"; }
anet -v 2>/dev/null | grep -q "preview" && pass "anet installed from npm" || fail "anet missing"
agent-node --version 2>/dev/null | grep -q "agent-node" && pass "agent-node installed from npm" || fail "agent-node missing"
commhub-server --help >/dev/null 2>&1 && pass "commhub-server installed from npm" || fail "commhub-server missing"
echo ""

echo "2. Starting npm-installed server with COMMHUB_AUTH_TOKEN..."
COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" commhub-server >/tmp/commhub-npm.log 2>&1 &
SERVER_PID=$!
sleep 3
HEALTH=$(curl -s http://127.0.0.1:9200/health 2>/dev/null)
echo "$HEALTH" | grep -q '"ok":true' && pass "server started from npm package" || { cat /tmp/commhub-npm.log; fail "server failed to start"; }
echo ""

echo "3. No token -> 401..."
NO_TOKEN_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9200/api/status)
[ "$NO_TOKEN_CODE" = "401" ] && pass "no token rejected" || fail "no token expected 401, got $NO_TOKEN_CODE"
echo ""

echo "4. Fake token -> 401..."
FAKE_TOKEN_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer fake-token" http://127.0.0.1:9200/api/status)
[ "$FAKE_TOKEN_CODE" = "401" ] && pass "fake token rejected" || fail "fake token expected 401, got $FAKE_TOKEN_CODE"
echo ""

echo "5. Register -> utok_ -> MCP should be 403..."
REGISTER=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"npmsecuser","password":"test123456","email":"npmsec@example.com"}')
echo "$REGISTER" | grep -q '"ok":true' && pass "register succeeded" || fail "register failed"
UTOK=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
NETWORK_ID=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('network_id',''))")
[ -n "$UTOK" ] && echo "$UTOK" | grep -q '^utok_' && pass "got utok_" || fail "missing utok_"
UTOK_MCP_CODE=$(mcp_init_call "$UTOK")
grep -q 'cannot access MCP' /tmp/mcp.out && [ "$UTOK_MCP_CODE" = "403" ] && pass "utok_ blocked from MCP" || fail "utok_ MCP boundary broken (code=$UTOK_MCP_CODE)"
echo ""

echo "6. Create ntok_ -> MCP should succeed..."
NODE_TOKEN_RESP=$(curl -s -X POST http://127.0.0.1:9200/api/auth/node-token \
  -H "Authorization: Bearer ${UTOK}" \
  -H "Content-Type: application/json" \
  -d "{\"network_id\":\"${NETWORK_ID}\",\"node_name\":\"npm-node\"}")
echo "$NODE_TOKEN_RESP" | grep -q '"ok":true' && pass "node-token endpoint succeeded" || { echo "$NODE_TOKEN_RESP"; fail "node-token creation failed"; }
NTOK=$(echo "$NODE_TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
[ -n "$NTOK" ] && echo "$NTOK" | grep -q '^ntok_' && pass "got ntok_" || fail "missing ntok_"
NTOK_INIT_CODE=$(mcp_init_call "$NTOK")
[ "$NTOK_INIT_CODE" = "200" ] && grep -q 'serverInfo\|capabilities' /tmp/mcp.out && pass "ntok_ can initialize MCP" || fail "ntok_ MCP init failed (code=$NTOK_INIT_CODE)"
NTOK_TOOL_CODE=$(mcp_tool_call "$NTOK" "report_status" '{"resume_id":"npm-security-1","alias":"npm-sec-agent","status":"idle"}')
[ "$NTOK_TOOL_CODE" = "200" ] && [ "$(cat /tmp/mcp.out | mcp_ok)" = "true" ] && pass "ntok_ can call MCP tool" || fail "ntok_ MCP tool call failed (code=$NTOK_TOOL_CODE)"
echo ""

echo "7. SQL injection attempt -> rejected..."
SQLI=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin' OR 1=1 --\",\"password\":\"test123456\"}")
echo "$SQLI" | grep -q '"ok":false' && echo "$SQLI" | grep -q 'invalid characters' && pass "SQL injection username rejected" || fail "SQL injection not rejected"
echo ""

echo "8. Overlong username -> rejected..."
LONG_NAME=$(python3 -c "print('u'*51)")
TOO_LONG=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${LONG_NAME}\",\"password\":\"test123456\"}")
echo "$TOO_LONG" | grep -q '"ok":false' && echo "$TOO_LONG" | grep -q 'too long' && pass "overlong username rejected" || fail "overlong username not rejected"
echo ""

echo "9. License activation..."
LICENSE=$(curl -s -X POST http://127.0.0.1:9200/api/license/activate \
  -H "Content-Type: application/json" \
  -d '{"key":"anet-TEST-1234-5678-ABCD"}')
echo "$LICENSE" | grep -q '"ok":true' && pass "license activation succeeded" || { echo "$LICENSE"; fail "license activation failed"; }
echo "$LICENSE" | grep -q '"pro"' && pass "license upgraded to pro" || fail "license not upgraded"
echo ""

echo "========================================="
echo "Result: ${PASS} passed, ${FAIL} failed"
echo "========================================="

kill "${SERVER_PID}" 2>/dev/null || true
wait "${SERVER_PID}" 2>/dev/null || true

[ "${FAIL}" -eq 0 ]

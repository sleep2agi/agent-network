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
# ntok_ 是身份边界：from_session 必须等于令牌绑定的节点别名（这里 node_name=npm-bot）。
# 守卫原文见 server/src/tools.ts:29-33 fromIdentityMismatchReply。
mcp_send_ntok='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"npm-bot","task":"hello from npm api test","from_session":"npm-bot","network_id":"'"$TEST_NET_ID"'"}}}'
# 同一条调用，只把 from_session 换成别的节点 —— 这是负向用例，必须被拒。
mcp_spoof_ntok='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"npm-bot","task":"spoofed sender","from_session":"npm-test","network_id":"'"$TEST_NET_ID"'"}}}'
NTOK_REPORT=$(curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $OWNER_NTOK" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$mcp_report_ntok")
echo "$NTOK_REPORT" | grep -q 'ok\\":true' && pass "ntok report_status works" || fail "ntok report_status"
NTOK_MCP=$(curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $OWNER_NTOK" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$mcp_send_ntok")
echo "$NTOK_MCP" | grep -q 'ok\\":true' && pass "ntok send_task works" || fail "ntok send_task"

# 负向：ntok_ 不能冒充别的节点。与上一条唯一的差别就是 from_session。
NTOK_SPOOF=$(curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $OWNER_NTOK" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$mcp_spoof_ntok")
echo "$NTOK_SPOOF" | grep -q 'from_session_identity_mismatch' \
  && pass "ntok cannot spoof another node via from_session" \
  || fail "ntok from_session spoof NOT rejected: $(echo "$NTOK_SPOOF" | head -c 200)"
echo ""

echo "8. utok 可以调 /mcp（V3 有意），但只能触及自己有权限的 network"
# 这里【不】断言 utok 被 403 挡掉。理由写在改动现场 server/src/server.ts:725-728：
#   Dashboard 是以「用户」身份登录的，挡掉 utok_ 它就无法调用 send_task。
# 边界没有消失，它从「传输层拒绝」挪到了「工具层按 network 作用域裁剪」。
# 所以下面断言的是那条【现在真实存在】的边界，而不是「连不上」。
UTOK_STATUS=$(curl -s -o /tmp/npm-api-utok-mcp.txt -w "%{http_code}" -X POST "$BASE/mcp" -H "$OWNER_AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$mcp_send_ntok")
[ "$UTOK_STATUS" = "200" ] && pass "utok reaches /mcp (V3: transport no longer blocks utok)" || fail "utok /mcp expected 200 got $UTOK_STATUS"

# npmmember 加入了 TEST_NET_ID，但在 OWNER_NET_ID（owner 注册时的默认网络）上没有任何角色。
# 下面两条是一组 A/B：同一个 token、同一个工具、同一段 task，【只有 network_id 不同】。
# 正控（能过）存在的意义：若拒绝那条是因为请求本身坏了，这条也会一起红，
# 于是「被拒」就不会被误读成「边界生效」。
mcp_send_own='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"npm-bot","task":"member scope probe","network_id":"'"$TEST_NET_ID"'"}}}'
mcp_send_foreign='{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"npm-bot","task":"member scope probe","network_id":"'"$OWNER_NET_ID"'"}}}'

MEMBER_OWN=$(curl -s -X POST "$BASE/mcp" -H "$MEMBER_AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$mcp_send_own")
echo "$MEMBER_OWN" | grep -q 'ok\\":true' \
  && pass "utok CAN write to a network it joined (positive control)" \
  || fail "utok write to joined network failed: $(echo "$MEMBER_OWN" | head -c 200)"

MEMBER_FOREIGN=$(curl -s -X POST "$BASE/mcp" -H "$MEMBER_AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$mcp_send_foreign")
# 断言这一层【自己】返回的那个错误码，不是任何一种「被拒了」。
# 守卫原文 server/src/tools.ts:95：
#   return role ? { networkId: clientNetId, networkIds: null }
#                : { denied: "access denied to requested network" };
# 写死 access_denied 而不是宽松匹配 /denied/：后者会把「请求本身坏了」也读成「边界生效」。
echo "$MEMBER_FOREIGN" | grep -q 'access_denied' \
  && pass "utok CANNOT write to a network it has no role on (access_denied)" \
  || fail "cross-network write NOT denied by access_denied: $(echo "$MEMBER_FOREIGN" | head -c 200)"
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

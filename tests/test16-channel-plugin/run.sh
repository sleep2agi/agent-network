#!/bin/bash

PASS=0
FAIL=0
BASE="http://127.0.0.1:9200"
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
TMP="/tmp/test16-channel"
WORKDIR="/tmp/test-ch"
mkdir -p "$TMP" "$WORKDIR"

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

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

rest() {
  curl -s -H "$REST_AUTH" "$@"
}

mcp_call() {
  local tool="$1"
  local args="$2"
  timeout 10 curl -s -X POST "${BASE}/mcp" \
    -H "Authorization: Bearer ${NTOK}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"t\",\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":${args}}}" 2>/dev/null || true
}

wait_for_status() {
  local expected="$1"
  local tries="${2:-8}"
  local i
  for i in $(seq 1 "$tries"); do
    STATUS_JSON=$(rest "${BASE}/api/status?network_id=${NET_ID}")
    if echo "$STATUS_JSON" | grep -q "\"alias\":\"test-node\"" && echo "$STATUS_JSON" | grep -q "\"status\":\"${expected}\""; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo ""
echo "═══ Test 16: Channel Plugin ═══"
echo ""

echo "1. Start server"
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" bun run src/index.ts >"${TMP}/server.log" 2>&1 &
sleep 4
curl -s "${BASE}/health" | grep -q '"ok":true' && pass "server started" || fail "server start"
echo ""

echo "2. Register user + create ntok"
REG=$(curl -s -X POST "${BASE}/api/auth/register" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"username":"chanuser","password":"pass123456"}')
echo "$REG" | grep -q '"ok":true' && pass "user registered" || fail "user register"
UTOK=$(echo "$REG" | json_get "token")
NTOK=$(echo "$REG" | json_get "network_token")
NET_ID=$(echo "$REG" | json_get "network_id")
REST_AUTH="Authorization: Bearer ${UTOK}"
echo "$NTOK" | grep -q '^ntok_' && pass "ntok available" || fail "ntok missing"
echo ""

echo "3. Write node config"
mkdir -p "${WORKDIR}/.anet/nodes/test-node"
cat > "${WORKDIR}/.anet/nodes/test-node/config.json" <<EOF
{
  "node_id": "test-node-id",
  "alias": "test-node",
  "network_id": "${NET_ID}",
  "token": "${NTOK}",
  "hub": "${BASE}"
}
EOF
[ -f "${WORKDIR}/.anet/nodes/test-node/config.json" ] && pass "config.json written" || fail "config.json missing"
echo ""

echo "4. Start channel plugin"
cd "${WORKDIR}" && tail -f /dev/null | timeout 10 bun /app/channel/commhub-channel.ts >"${TMP}/plugin.log" 2>&1 &
PLUGIN_PID=$!
sleep 3
[ -n "$PLUGIN_PID" ] && pass "plugin started" || fail "plugin failed to launch"
echo ""

echo "5. Agent online in /api/status"
if wait_for_status "idle" 8; then
  pass "plugin reported online"
else
  cat "${TMP}/plugin.log"
  fail "plugin not online"
fi
STATUS_JSON=$(rest "${BASE}/api/status?network_id=${NET_ID}")
echo "$STATUS_JSON" | grep -q "\"network_id\":\"${NET_ID}\"" && pass "status network_id correct" || { echo "$STATUS_JSON"; fail "status network_id wrong"; }
echo ""

echo "6. Send task via MCP"
SEND=$(mcp_call "send_task" "{\"alias\":\"test-node\",\"task\":\"channel plugin task\",\"from_session\":\"tester\",\"network_id\":\"${NET_ID}\"}")
echo "$SEND" | grep -q 'ok\\":true' && pass "send_task accepted" || { echo "$SEND"; fail "send_task"; }
echo ""

echo "7. Inbox receives task"
INBOX=$(mcp_call "get_inbox" "{\"alias\":\"test-node\",\"limit\":5,\"network_id\":\"${NET_ID}\"}")
if echo "$INBOX" | grep -q 'channel plugin task'; then
  pass "inbox has task"
else
  cat "${TMP}/plugin.log"
  echo "$INBOX"
  fail "inbox missing task"
fi
echo ""

echo "8. Stop plugin"
kill "$PLUGIN_PID" 2>/dev/null || true
wait "$PLUGIN_PID" 2>/dev/null || true
pass "plugin stopped"
echo ""

echo "9. Agent offline in /api/status"
if wait_for_status "offline" 8; then
  pass "plugin reported offline"
else
  cat "${TMP}/plugin.log"
  fail "plugin not offline"
fi
echo ""

echo "═══════════════════════════════════"
echo "  Test 16 Result: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1

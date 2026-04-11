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

mcp_call() {
  local token="$1"
  local payload="$2"
  curl -s -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$payload"
}

report_status() {
  local token="$1"
  local alias="$2"
  local resume="$3"
  local runtime="$4"
  mcp_call "$token" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report_status\",\"arguments\":{\"resume_id\":\"$resume\",\"alias\":\"$alias\",\"status\":\"idle\",\"agent\":\"$runtime\",\"node_id\":\"$alias-node\",\"node_name\":\"$alias\",\"network_id\":\"$NET_ID\"}}}"
}

send_task() {
  local token="$1"
  local target="$2"
  local task="$3"
  local from="$4"
  mcp_call "$token" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"send_task\",\"arguments\":{\"alias\":\"$target\",\"task\":\"$task\",\"from_session\":\"$from\",\"network_id\":\"$NET_ID\"}}}"
}

send_reply() {
  local token="$1"
  local target="$2"
  local text="$3"
  local from="$4"
  local task_id="$5"
  mcp_call "$token" "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"send_reply\",\"arguments\":{\"alias\":\"$target\",\"text\":\"$text\",\"from_session\":\"$from\",\"in_reply_to\":\"$task_id\",\"status\":\"replied\"}}}"
}

get_inbox() {
  local token="$1"
  local alias="$2"
  mcp_call "$token" "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"get_inbox\",\"arguments\":{\"alias\":\"$alias\"}}}"
}

broadcast_msg() {
  local token="$1"
  local msg="$2"
  mcp_call "$token" "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"broadcast\",\"arguments\":{\"message\":\"$msg\",\"network_id\":\"$NET_ID\"}}}"
}

fetch_task_id() {
  local from_name="$1"
  local to_name="$2"
  local content="$3"
  curl -s "$BASE/api/tasks?network_id=$NET_ID&from_name=$from_name&to_name=$to_name&limit=20" -H "$OWNER_AUTH" | \
    python3 -c 'import json,sys; data=json.load(sys.stdin); target=sys.argv[1]
for task in data.get("tasks", []):
    if task.get("content") == target:
        print(task.get("task_id", ""))
        break' "$content" 2>/dev/null || true
}

echo ""
echo "========================================="
echo "  Test 13: Multi Channel Communication"
echo "========================================="
echo ""

echo "1. Start server + register"
cd /app/server && COMMHUB_AUTH_TOKEN="$AUTH_TOKEN" bun run src/index.ts &
sleep 3
curl -s "$BASE/health" | grep -q '"ok":true' && pass "server started" || fail "server start"

REG1=$(curl -s -X POST "$BASE/api/auth/register" -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" -d '{"username":"multiowner","password":"pass123456"}')
echo "$REG1" | grep -q '"ok":true' && pass "owner registered" || fail "owner register"
OWNER_UTOK=$(echo "$REG1" | json_get "token")
OWNER_AUTH="Authorization: Bearer $OWNER_UTOK"

NET_RES=$(curl -s -X POST "$BASE/api/networks" -H "$OWNER_AUTH" -H "Content-Type: application/json" -d '{"name":"multi-channel-net","description":"multi agent comm test"}')
NET_ID=$(echo "$NET_RES" | json_get "network_id")
echo "$NET_RES" | grep -q '"ok":true' && [ -n "$NET_ID" ] && pass "network created" || fail "network create"
echo ""

echo "2. Register 3 agents: agent-a / agent-b / agent-c"
NTOK_A_RES=$(curl -s -X POST "$BASE/api/auth/node-token" -H "$OWNER_AUTH" -H "Content-Type: application/json" -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"agent-a-node\"}")
NTOK_B_RES=$(curl -s -X POST "$BASE/api/auth/node-token" -H "$OWNER_AUTH" -H "Content-Type: application/json" -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"agent-b-node\"}")
NTOK_C_RES=$(curl -s -X POST "$BASE/api/auth/node-token" -H "$OWNER_AUTH" -H "Content-Type: application/json" -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"agent-c-node\"}")
NTOK_A=$(echo "$NTOK_A_RES" | json_get "token")
NTOK_B=$(echo "$NTOK_B_RES" | json_get "token")
NTOK_C=$(echo "$NTOK_C_RES" | json_get "token")
echo "$NTOK_A" | grep -q '^ntok_' && echo "$NTOK_B" | grep -q '^ntok_' && echo "$NTOK_C" | grep -q '^ntok_' && pass "three agent ntok created" || fail "agent ntok create"

RA=$(report_status "$NTOK_A" "agent-a" "resume-a" "claude")
RB=$(report_status "$NTOK_B" "agent-b" "resume-b" "codex")
RC=$(report_status "$NTOK_C" "agent-c" "resume-c" "http-api")
echo "$RA" | grep -q 'ok\\":true' && echo "$RB" | grep -q 'ok\\":true' && echo "$RC" | grep -q 'ok\\":true' && pass "three agents reported status" || fail "agent report_status"
echo ""

echo "3. agent-a -> agent-b send task"
AB_TASK=$(send_task "$NTOK_A" "agent-b" "task from agent-a to agent-b" "agent-a")
AB_TASK_ID=$(fetch_task_id "agent-a" "agent-b" "task from agent-a to agent-b")
echo "$AB_TASK" | grep -q 'ok\\":true' && [ -n "$AB_TASK_ID" ] && pass "agent-a sent task to agent-b" || fail "agent-a -> agent-b"
echo ""

echo "4. agent-b replies to agent-a"
B_INBOX=$(get_inbox "$NTOK_B" "agent-b")
echo "$B_INBOX" | grep -q 'task from agent-a to agent-b' && pass "agent-b received task" || fail "agent-b inbox missing task"

BA_REPLY=$(send_reply "$NTOK_B" "agent-a" "reply from agent-b to agent-a" "agent-b" "$AB_TASK_ID")
echo "$BA_REPLY" | grep -q 'ok\\":true' && pass "agent-b replied to agent-a" || fail "agent-b reply"
echo ""

echo "5. Broadcast to all agents"
BCAST=$(broadcast_msg "$NTOK_A" "broadcast to all agents")
echo "$BCAST" | grep -q 'ok\\":true' && pass "broadcast sent" || fail "broadcast send"
echo ""

echo "6. Verify all agents received broadcast"
A_INBOX=$(get_inbox "$NTOK_A" "agent-a")
B2_INBOX=$(get_inbox "$NTOK_B" "agent-b")
C_INBOX=$(get_inbox "$NTOK_C" "agent-c")
echo "$A_INBOX" | grep -q 'broadcast to all agents' && pass "agent-a got broadcast" || fail "agent-a missing broadcast"
echo "$B2_INBOX" | grep -q 'broadcast to all agents' && pass "agent-b got broadcast" || fail "agent-b missing broadcast"
echo "$C_INBOX" | grep -q 'broadcast to all agents' && pass "agent-c got broadcast" || fail "agent-c missing broadcast"
echo ""

echo "7. agent-a -> agent-c and agent-c replies"
AC_TASK=$(send_task "$NTOK_A" "agent-c" "task from agent-a to agent-c" "agent-a")
AC_TASK_ID=$(fetch_task_id "agent-a" "agent-c" "task from agent-a to agent-c")
echo "$AC_TASK" | grep -q 'ok\\":true' && [ -n "$AC_TASK_ID" ] && pass "agent-a sent task to agent-c" || fail "agent-a -> agent-c"

C2_INBOX=$(get_inbox "$NTOK_C" "agent-c")
echo "$C2_INBOX" | grep -q 'task from agent-a to agent-c' && pass "agent-c received task" || fail "agent-c inbox missing task"

CA_REPLY=$(send_reply "$NTOK_C" "agent-a" "reply from agent-c to agent-a" "agent-c" "$AC_TASK_ID")
echo "$CA_REPLY" | grep -q 'ok\\":true' && pass "agent-c replied to agent-a" || fail "agent-c reply"
echo ""

echo "8. Verify /api/messages communication history"
MSG_RES=$(curl -s "$BASE/api/messages?limit=100")
MSG_OK=$(echo "$MSG_RES" | python3 -c 'import json,sys; data=json.load(sys.stdin); contents=[m.get("content","") for m in data.get("messages",[])]; need=sys.argv[1:]; print("ok" if all(item in contents for item in need) else "missing")' \
  "task from agent-a to agent-b" \
  "reply from agent-b to agent-a" \
  "broadcast to all agents" \
  "task from agent-a to agent-c" \
  "reply from agent-c to agent-a" 2>/dev/null || true)
[ "$MSG_OK" = "ok" ] && pass "/api/messages has full records" || fail "/api/messages incomplete"
echo ""

echo "9. Verify /api/task_events status changes"
EVENT_RES=$(curl -s "$BASE/api/task_events?limit=50")
EVENT_OK=$(echo "$EVENT_RES" | python3 -c 'import json,sys; data=json.load(sys.stdin); events=data.get("events",[]); ids={e.get("task_id","") for e in events}; states={e.get("to_status","") for e in events}; need_ids=set(sys.argv[1:3]); print("ok" if need_ids.issubset(ids) and {"delivered","replied"}.issubset(states) else "missing")' "$AB_TASK_ID" "$AC_TASK_ID" 2>/dev/null || true)
[ "$EVENT_OK" = "ok" ] && pass "/api/task_events has state changes" || fail "/api/task_events incomplete"
echo ""

echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1

#!/bin/bash
set -e
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

BASE="http://127.0.0.1:9200"
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
GLOBAL_AUTH="Authorization: Bearer $AUTH_TOKEN"

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
  curl -s "$BASE/api/tasks?network_id=$NET_ID&limit=50" -H "$GLOBAL_AUTH" | \
    python3 -c 'import json,sys; data=json.load(sys.stdin); fn,tn,content=sys.argv[1:4]
for task in data.get("tasks", []):
    if task.get("from_name")==fn and task.get("to_name")==tn and task.get("content")==content:
        print(task.get("task_id",""))
        break' "$from_name" "$to_name" "$content" 2>/dev/null || true
}

echo ""
echo "========================================="
echo "  Test 24: Codex Commander + MiniMax Workers"
echo "========================================="
echo ""

echo "1. Start server"
cd /app/server && COMMHUB_AUTH_TOKEN="$AUTH_TOKEN" bun run src/index.ts &
sleep 3
curl -s "$BASE/health" | grep -q '"ok":true' && pass "server started" || fail "server start"
echo ""

echo "2. Register user + create network + create ntok"
REG=$(curl -s -X POST "$BASE/api/auth/register" -H "$GLOBAL_AUTH" -H "Content-Type: application/json" -d '{"username":"cmdowner","password":"pass123456"}')
echo "$REG" | grep -q '"ok":true' && pass "user registered" || fail "user register"
UTOK=$(echo "$REG" | json_get "token")
USER_AUTH="Authorization: Bearer $UTOK"

NET_RES=$(curl -s -X POST "$BASE/api/networks" -H "$USER_AUTH" -H "Content-Type: application/json" -d '{"name":"codex-commander-net","description":"multi runtime commander test"}')
NET_ID=$(echo "$NET_RES" | json_get "network_id")
echo "$NET_RES" | grep -q '"ok":true' && [ -n "$NET_ID" ] && pass "network created" || fail "network create"

CMD_NTOK_RES=$(curl -s -X POST "$BASE/api/auth/node-token" -H "$USER_AUTH" -H "Content-Type: application/json" -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"commander-node\"}")
CMD_NTOK=$(echo "$CMD_NTOK_RES" | json_get "token")
echo "$CMD_NTOK" | grep -q '^ntok_' && pass "commander ntok created" || fail "commander ntok create"
echo ""

echo "3. Register commander and workers"
W1_NTOK_RES=$(curl -s -X POST "$BASE/api/auth/node-token" -H "$USER_AUTH" -H "Content-Type: application/json" -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"worker-1-node\"}")
W2_NTOK_RES=$(curl -s -X POST "$BASE/api/auth/node-token" -H "$USER_AUTH" -H "Content-Type: application/json" -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"worker-2-node\"}")
W1_NTOK=$(echo "$W1_NTOK_RES" | json_get "token")
W2_NTOK=$(echo "$W2_NTOK_RES" | json_get "token")
echo "$W1_NTOK" | grep -q '^ntok_' && echo "$W2_NTOK" | grep -q '^ntok_' && pass "worker ntok created" || fail "worker ntok create"

RC=$(report_status "$CMD_NTOK" "commander" "resume-commander" "codex-sdk")
R1=$(report_status "$W1_NTOK" "worker-1" "resume-worker-1" "http-api")
R2=$(report_status "$W2_NTOK" "worker-2" "resume-worker-2" "http-api")
echo "$RC" | grep -q 'ok\\":true' && echo "$R1" | grep -q 'ok\\":true' && echo "$R2" | grep -q 'ok\\":true' && pass "commander and workers registered" || fail "agent report_status"
echo ""

echo "4. commander -> worker-1 send_task"
TASK1_TEXT="task 1 from commander to worker-1"
TASK1_RES=$(send_task "$CMD_NTOK" "worker-1" "$TASK1_TEXT" "commander")
TASK1_ID=$(fetch_task_id "commander" "worker-1" "$TASK1_TEXT")
echo "$TASK1_RES" | grep -q 'ok\\":true' && [ -n "$TASK1_ID" ] && pass "commander sent task to worker-1" || fail "commander -> worker-1"

W1_INBOX=$(get_inbox "$W1_NTOK" "worker-1")
echo "$W1_INBOX" | grep -q "$TASK1_TEXT" && pass "worker-1 received task" || fail "worker-1 inbox missing task"

REPLY1_TEXT="worker-1 completed task 1"
REPLY1_RES=$(send_reply "$W1_NTOK" "commander" "$REPLY1_TEXT" "worker-1" "$TASK1_ID")
echo "$REPLY1_RES" | grep -q 'ok\\":true' && pass "worker-1 replied" || fail "worker-1 reply"
echo ""

echo "5. commander -> worker-2 send_task"
TASK2_TEXT="task 2 from commander to worker-2"
TASK2_RES=$(send_task "$CMD_NTOK" "worker-2" "$TASK2_TEXT" "commander")
TASK2_ID=$(fetch_task_id "commander" "worker-2" "$TASK2_TEXT")
echo "$TASK2_RES" | grep -q 'ok\\":true' && [ -n "$TASK2_ID" ] && pass "commander sent task to worker-2" || fail "commander -> worker-2"

W2_INBOX=$(get_inbox "$W2_NTOK" "worker-2")
echo "$W2_INBOX" | grep -q "$TASK2_TEXT" && pass "worker-2 received task" || fail "worker-2 inbox missing task"

REPLY2_TEXT="worker-2 completed task 2"
REPLY2_RES=$(send_reply "$W2_NTOK" "commander" "$REPLY2_TEXT" "worker-2" "$TASK2_ID")
echo "$REPLY2_RES" | grep -q 'ok\\":true' && pass "worker-2 replied" || fail "worker-2 reply"
echo ""

echo "6. commander broadcasts to workers"
BCAST_TEXT="commander broadcast to all workers"
BCAST_RES=$(broadcast_msg "$CMD_NTOK" "$BCAST_TEXT")
echo "$BCAST_RES" | grep -q 'ok\\":true' && pass "broadcast sent" || fail "broadcast send"

W1_INBOX2=$(get_inbox "$W1_NTOK" "worker-1")
W2_INBOX2=$(get_inbox "$W2_NTOK" "worker-2")
echo "$W1_INBOX2" | grep -q "$BCAST_TEXT" && pass "worker-1 got broadcast" || fail "worker-1 missing broadcast"
echo "$W2_INBOX2" | grep -q "$BCAST_TEXT" && pass "worker-2 got broadcast" || fail "worker-2 missing broadcast"
echo ""

echo "7. Verify /api/tasks scheduling records"
TASKS_RES=$(curl -s "$BASE/api/tasks?network_id=$NET_ID&limit=50" -H "$GLOBAL_AUTH")
TASKS_OK=$(echo "$TASKS_RES" | python3 -c 'import json,sys; data=json.load(sys.stdin); tasks=data.get("tasks",[]); expect={(sys.argv[1],sys.argv[2],sys.argv[3]),(sys.argv[1],sys.argv[4],sys.argv[5])}
seen={(t.get("from_name",""), t.get("to_name",""), t.get("content","")) for t in tasks}
statuses={t.get("status","") for t in tasks}
print("ok" if expect.issubset(seen) and "replied" in statuses else "missing")' \
  "commander" "worker-1" "$TASK1_TEXT" "worker-2" "$TASK2_TEXT" 2>/dev/null || true)
[ "$TASKS_OK" = "ok" ] && pass "/api/tasks has complete records" || fail "/api/tasks incomplete"
echo ""

echo "8. Verify /api/task_events state flow"
EVENT_RES=$(curl -s "$BASE/api/task_events?network_id=$NET_ID&limit=50" -H "$GLOBAL_AUTH")
EVENT_OK=$(echo "$EVENT_RES" | python3 -c 'import json,sys; data=json.load(sys.stdin); events=data.get("events",[]); ids={e.get("task_id","") for e in events}; states={e.get("to_status","") for e in events}; print("ok" if {sys.argv[1],sys.argv[2]}.issubset(ids) and {"delivered","replied"}.issubset(states) else "missing")' "$TASK1_ID" "$TASK2_ID" 2>/dev/null || true)
[ "$EVENT_OK" = "ok" ] && pass "/api/task_events has state flow" || fail "/api/task_events incomplete"
echo ""

echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1

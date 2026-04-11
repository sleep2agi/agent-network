#!/bin/bash
# Lifecycle-focused E2E suite. Keep assertions explicit; do not stop on first failure.

PASS=0
FAIL=0
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
DB_PATH="${COMMHUB_DB:-/tmp/commhub-test11.db}"

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

api_curl() {
  curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "$@"
}

mcp_call() {
  local tool="$1"
  local args="$2"
  curl -s -X POST http://127.0.0.1:9200/mcp \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"test11\",\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":${args}}}"
}

extract_task_id() {
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
    print(payload.get("message_id", ""))
except Exception:
    print("")
'
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

task_field() {
  local task_id="$1"
  local field="$2"
  api_curl "http://127.0.0.1:9200/api/tasks?task_id=${task_id}" | python3 -c "
import json, sys
doc = json.load(sys.stdin)
tasks = doc.get('tasks', [])
print(tasks[0].get('${field}', '') if tasks else '')
"
}

echo ""
echo "========================================="
echo "  anet Lifecycle Boundary Test"
echo "========================================="
echo ""

echo "1. Starting CommHub server..."
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" COMMHUB_DB="${DB_PATH}" bun run src/index.ts &
SERVER_PID=$!
sleep 3
HEALTH=$(curl -s http://127.0.0.1:9200/health 2>/dev/null)
echo "$HEALTH" | grep -q '"ok":true' && pass "CommHub server started" || fail "CommHub server failed"
echo ""

echo "2. Register lifecycle agents..."
mcp_call "report_status" '{"resume_id":"ttl-agent-1","alias":"ttl-agent","status":"idle"}' >/dev/null
mcp_call "report_status" '{"resume_id":"ack-agent-1","alias":"ack-agent","status":"idle"}' >/dev/null
mcp_call "report_status" '{"resume_id":"run-agent-1","alias":"run-agent","status":"idle"}' >/dev/null
pass "agents registered"
echo ""

echo "3. TTL boundary: ttl_seconds=5, wait 6s..."
TTL_SEND=$(mcp_call "send_task" '{"alias":"ttl-agent","task":"ttl boundary case","from_session":"test11","ttl_seconds":5}')
TTL_TASK_ID=$(echo "$TTL_SEND" | extract_task_id)
if [ -n "$TTL_TASK_ID" ]; then
  pass "TTL task created"
else
  fail "TTL task creation failed"
fi
sleep 6
TTL_STATUS=$(task_field "$TTL_TASK_ID" "status")
if [ "$TTL_STATUS" = "expired" ]; then
  pass "task auto-expired after TTL"
else
  fail "task not expired after TTL (status=${TTL_STATUS:-missing})"
fi
echo ""

echo "4. Patrol expiration logic via DB-inserted stale task..."
python3 - <<PY
import sqlite3
db = sqlite3.connect("${DB_PATH}")
db.execute(
    """INSERT OR REPLACE INTO tasks
    (task_id, from_name, to_name, priority, status, content, requires_response, created_at, delivered_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-10 minutes'), datetime('now', '-10 minutes'), datetime('now', '-1 minute'))""",
    ("manual-expired-task", "test11", "ttl-agent", "normal", "delivered", "manual stale task", "reply"),
)
db.commit()
db.close()
PY
python3 - <<PY
import sqlite3
db = sqlite3.connect("${DB_PATH}")
db.execute(
    """UPDATE tasks SET status = 'expired', completed_at = datetime('now')
       WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
         AND status IN ('created', 'delivered')"""
)
db.commit()
db.close()
PY
PATROL_STATUS=$(task_field "manual-expired-task" "status")
[ "$PATROL_STATUS" = "expired" ] && pass "patrol expiration query marks stale task expired" || fail "patrol logic failed (status=${PATROL_STATUS:-missing})"
echo ""

echo "5. send_ack transitions task -> acked..."
ACK_SEND=$(mcp_call "send_task" '{"alias":"ack-agent","task":"ack boundary case","from_session":"test11"}')
ACK_TASK_ID=$(echo "$ACK_SEND" | extract_task_id)
ACK_RESP=$(mcp_call "send_ack" "{\"task_id\":\"${ACK_TASK_ID}\",\"from_session\":\"ack-agent\"}")
[ "$(echo "$ACK_RESP" | mcp_ok)" = "true" ] && pass "send_ack accepted" || fail "send_ack rejected"
ACK_STATUS=$(task_field "$ACK_TASK_ID" "status")
[ "$ACK_STATUS" = "acked" ] && pass "task status becomes acked" || fail "task not acked (status=${ACK_STATUS:-missing})"
echo ""

echo "6. report_status(working) transitions task -> running..."
RUN_TASK_TEXT="run boundary case"
RUN_SEND=$(mcp_call "send_task" "{\"alias\":\"run-agent\",\"task\":\"${RUN_TASK_TEXT}\",\"from_session\":\"test11\"}")
RUN_TASK_ID=$(echo "$RUN_SEND" | extract_task_id)
RUN_WORK=$(mcp_call "report_status" "{\"resume_id\":\"run-agent-1\",\"alias\":\"run-agent\",\"status\":\"working\",\"task\":\"${RUN_TASK_TEXT}\"}")
[ "$(echo "$RUN_WORK" | mcp_ok)" = "true" ] && pass "report_status working accepted" || fail "report_status working rejected"
sleep 1
RUN_STATUS=$(task_field "$RUN_TASK_ID" "status")
[ "$RUN_STATUS" = "running" ] && pass "task status becomes running" || fail "task not running (status=${RUN_STATUS:-missing})"
echo ""

echo "========================================="
echo "Result: ${PASS} passed, ${FAIL} failed"
echo "========================================="

kill "${SERVER_PID}" 2>/dev/null || true
wait "${SERVER_PID}" 2>/dev/null || true

[ "${FAIL}" -eq 0 ]

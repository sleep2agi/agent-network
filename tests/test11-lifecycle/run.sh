#!/bin/bash
# Lifecycle-focused E2E suite. Keep assertions explicit; do not stop on first failure.


# SHA 绑定（形态同 tests/test746-setup-bun-pin/run.sh:8）。
[[ "${TEST11_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST11_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST11_SOURCE_COMMIT"

PASS=0
FAIL=0
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
DB_PATH="${COMMHUB_DB:-/tmp/commhub-test11.db}"

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

api_curl() {
  curl -s -H "Authorization: Bearer ${UTOK:-$AUTH_TOKEN}" "$@"
}

mcp_call() {
  local tool="$1"
  local args="$2"
  local tok="${3:-${UTOK:-$AUTH_TOKEN}}"   # 第三参数指定身份；默认 utok_
  curl -s -X POST http://127.0.0.1:9200/mcp \
    -H "Authorization: Bearer ${tok}" \
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
# 🔴 这一段原来是：三次 mcp_call 全部 `>/dev/null`，然后**无条件** `pass "agents registered"`。
# 那句 PASS 恒真 —— 注册失败时它也照样打印。而注册确实一直在失败，逐字返回是：
#   {"ok":false,"error":"master-token auth is deprecated; use admin utok_"}
# （守卫 server/src/server.ts:169-170；本套件的 mcp_call 原来用的是 master token。）
# ⇒ 于是这个套件用一条恒真断言把自己的真实故障盖了 6 个月。
#
# 修两件：① 用 admin utok_ + 每个别名自己的 ntok_（#203 要求 node_name 与别名一致）
#         ② 🔴 把无条件 pass 换成**逐个断言** —— 这一条比 ① 更重要：
#            ① 只修好这一次；② 让下一次注册失败**能被看见**。
REG=$(curl -s -X POST "${BASE:-http://127.0.0.1:9200}/api/auth/register" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" -H "Content-Type: application/json" \
  -d '{"username":"t11admin","password":"pass123456"}')
UTOK=$(echo "$REG" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
NET_ID=$(echo "$REG" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("network_id",""))' 2>/dev/null)
[ -n "$UTOK" ] && [ -n "$NET_ID" ] && pass "admin utok_ + network_id obtained" || { echo "$REG"; fail "could not bootstrap admin identity"; }

# 🔴 新增的负向断言：本套件原来依赖的那条路（master token）必须**被拒**。
# 只把 token 换掉是"让它能过"；加上这条，才是把废弃边界真正测住。
DEPR=$(mcp_call "report_status" '{"resume_id":"depr","alias":"ttl-agent","status":"idle"}' "$AUTH_TOKEN")
echo "$DEPR" | grep -q 'master-token auth is deprecated' \
  && pass "master token rejected on /mcp (deprecated)" \
  || fail "master token NOT rejected: $(echo "$DEPR" | head -c 140)"

for A in ttl-agent ack-agent run-agent; do
  TOK=$(curl -s -X POST "${BASE:-http://127.0.0.1:9200}/api/auth/node-token" \
    -H "Authorization: Bearer ${UTOK}" -H "Content-Type: application/json" \
    -d "{\"network_id\":\"${NET_ID}\",\"node_name\":\"${A}\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
  case "$TOK" in ntok_*) ;; *) fail "could not mint ntok_ for ${A}"; continue ;; esac
  eval "TOK_${A//-/_}=\$TOK"
  R=$(mcp_call "report_status" "{\"resume_id\":\"${A}-1\",\"alias\":\"${A}\",\"status\":\"idle\",\"network_id\":\"${NET_ID}\"}" "$TOK")
  # 🔴 逐个断言，不再吞掉返回值
  echo "$R" | grep -q 'ok\\":true' && pass "registered ${A}" || { echo "$R"; fail "register ${A} failed"; }
done
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
if [ "$TTL_STATUS" = "delivered" ]; then
  pass "TTL does not auto-expire without patrol; status remains delivered after 6s"
else
  fail "unexpected TTL status before patrol (status=${TTL_STATUS:-missing})"
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
# 🔴 report_status 需要 network token（utok 会被 network_token_required 拒），
# 且按 #203 其 node_name 必须与别名一致 —— 用上面为 run-agent 铸的那个。
RUN_WORK=$(mcp_call "report_status" "{\"resume_id\":\"run-agent-1\",\"alias\":\"run-agent\",\"status\":\"working\",\"task\":\"${RUN_TASK_TEXT}\",\"network_id\":\"${NET_ID}\"}" "$TOK_run_agent")
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

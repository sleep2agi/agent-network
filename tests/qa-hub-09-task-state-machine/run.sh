#!/usr/bin/env bash
# qa-hub-09-task-state-machine — task 状态机完整 schema
# 用户故事 / 协议契约：
#   delivered → replied   (send_reply success path, R6 covered)
#   delivered → failed    (send_reply failure path, docker-e2e SC05 covered)
#   delivered → cancelled (cancel_task path — NOT covered anywhere else)
#   replied/failed/cancelled → * (terminal — silent no-op, R6 finding)
#
# 这条 pin 三个分支 + 终态不可逆契约。
set -euo pipefail

export HOME=/tmp/anethome
mkdir -p "$HOME" /tmp/work
cd /tmp/work

ADMIN_PW="StrongPassw0rd"
HUB_PORT=9200
HUB_BASE="http://127.0.0.1:$HUB_PORT"

cleanup() {
  for p in "${HUB_PID:-}"; do
    [[ -n "$p" && "$p" != "0" ]] && kill "$p" 2>/dev/null || true
  done
  pkill -KILL -f 'commhub-server' 2>/dev/null || true
}
trap cleanup EXIT

mcp_call() {
  local tok="$1" name="$2" args="$3"
  local body
  body=$(jq -nc --arg n "$name" --argjson a "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  curl -sS -X POST "$HUB_BASE/mcp" \
    -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "$body" \
    | sed -n 's/^data: //p' | head -1 \
    | jq -r '.result.content[0].text // empty'
}

# Query a task's status / result / completed_at from /api/tasks
task_field() {
  local utok="$1" net="$2" tid="$3" field="$4"
  curl -fsS "$HUB_BASE/api/tasks?task_id=$tid&network_id=$net" \
    -H "Authorization: Bearer $utok" | jq -r ".tasks[0].$field"
}

# Send task and capture its id
send_task() {
  local utok="$1" net="$2" alias="$3" text="$4"
  curl -fsS -X POST "$HUB_BASE/api/task" \
    -H "Authorization: Bearer $utok" -H 'Content-Type: application/json' \
    -d "{\"alias\":\"$alias\",\"task\":\"$text\",\"priority\":\"normal\",\"network_id\":\"$net\"}" \
    | jq -r '.message_id'
}

npm install -g @sleep2agi/agent-network@preview >/tmp/npm-install.log 2>&1
anet -v >/dev/null

echo "[0] start hub"
rm -rf "$HOME/.anet" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 1; done

echo "[1] admin login (retry)"
UTOK=""
for i in {1..20}; do
  LOGIN=$(curl -sS -X POST "$HUB_BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}")
  UTOK=$(echo "$LOGIN" | jq -r '.token // empty')
  [[ "$UTOK" == utok_* ]] && break
  sleep 0.5
done
[[ "$UTOK" == utok_* ]] || { echo "FAIL: admin login"; exit 1; }

echo "[2] network + ntok + report_status (alias=agent-09)"
NET_RESP=$(curl -fsS -X POST "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d '{"name":"hub09-net"}')
NET_ID=$(echo "$NET_RESP" | jq -r '.network.network_id // .network_id // empty')
NTOK=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"agent-09\"}" | jq -r '.token')
ARG=$(jq -nc --arg net "$NET_ID" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-000000000009",alias:"agent-09",status:"idle",network_id:$net}')
RS=$(mcp_call "$NTOK" "report_status" "$ARG")
echo "$RS" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status: $RS"; exit 1; }

# ─────────────── BRANCH 1: delivered → replied (success path) ───────────────
echo "[3] BRANCH replied: send → send_reply(replied)"
T_REP=$(send_task "$UTOK" "$NET_ID" "agent-09" "task-replied")
[[ "$(task_field "$UTOK" "$NET_ID" "$T_REP" status)" == "delivered" ]] || \
  { echo "FAIL: replied path PRE != delivered"; exit 1; }
ARG=$(jq -nc --arg t "$T_REP" '{alias:"admin",text:"OK reply",in_reply_to:$t,status:"replied",from_session:"agent-09"}')
echo "$(mcp_call "$NTOK" "send_reply" "$ARG")" | jq -e '.ok == true' >/dev/null \
  || { echo "FAIL: send_reply(replied) not ok"; exit 1; }
sleep 0.2
[[ "$(task_field "$UTOK" "$NET_ID" "$T_REP" status)" == "replied" ]] || \
  { echo "FAIL: status not replied"; exit 1; }
[[ "$(task_field "$UTOK" "$NET_ID" "$T_REP" result)" == "OK reply" ]] || \
  { echo "FAIL: result mismatch"; exit 1; }
[[ "$(task_field "$UTOK" "$NET_ID" "$T_REP" completed_at)" != "null" ]] || \
  { echo "FAIL: completed_at not set on replied"; exit 1; }

# ─────────────── BRANCH 2: delivered → failed ───────────────
echo "[4] BRANCH failed: send → send_reply(failed)"
T_FAIL=$(send_task "$UTOK" "$NET_ID" "agent-09" "task-failed")
ARG=$(jq -nc --arg t "$T_FAIL" '{alias:"admin",text:"http 500",in_reply_to:$t,status:"failed",from_session:"agent-09"}')
echo "$(mcp_call "$NTOK" "send_reply" "$ARG")" | jq -e '.ok == true' >/dev/null \
  || { echo "FAIL: send_reply(failed) not ok"; exit 1; }
sleep 0.2
[[ "$(task_field "$UTOK" "$NET_ID" "$T_FAIL" status)" == "failed" ]] || \
  { echo "FAIL: status not failed"; exit 1; }
[[ "$(task_field "$UTOK" "$NET_ID" "$T_FAIL" completed_at)" != "null" ]] || \
  { echo "FAIL: completed_at not set on failed"; exit 1; }

# ─────────────── BRANCH 3: delivered → cancelled ───────────────
echo "[5] BRANCH cancelled: send → cancel_task"
T_CXL=$(send_task "$UTOK" "$NET_ID" "agent-09" "task-cancelled")
[[ "$(task_field "$UTOK" "$NET_ID" "$T_CXL" status)" == "delivered" ]] || \
  { echo "FAIL: cancel PRE != delivered"; exit 1; }
ARG=$(jq -nc --arg t "$T_CXL" '{task_id:$t,reason:"user changed mind",from_session:"admin"}')
# cancel_task needs a network-scoped writer (canWrite). Use NTOK (which is
# bound to NET_ID) — agent-09 cancelling a task targeted at itself.
CXL_RESP=$(mcp_call "$NTOK" "cancel_task" "$ARG")
echo "$CXL_RESP" | jq -e '.ok == true' >/dev/null \
  || { echo "FAIL: cancel_task not ok: $CXL_RESP"; exit 1; }
sleep 0.2
[[ "$(task_field "$UTOK" "$NET_ID" "$T_CXL" status)" == "cancelled" ]] || \
  { echo "FAIL: status not cancelled"; exit 1; }
[[ "$(task_field "$UTOK" "$NET_ID" "$T_CXL" completed_at)" != "null" ]] || \
  { echo "FAIL: completed_at not set on cancelled"; exit 1; }
RESULT=$(task_field "$UTOK" "$NET_ID" "$T_CXL" result)
[[ "$RESULT" == *"changed mind"* ]] || { echo "FAIL: cancel result lost reason, got: $RESULT"; exit 1; }

echo "[6] cancelled inbox auto-acked — get_inbox must NOT contain task-cancelled"
ARG=$(jq -nc '{alias:"agent-09",limit:20}')
INBOX=$(mcp_call "$NTOK" "get_inbox" "$ARG")
LEAK=$(echo "$INBOX" | jq -r '[.messages[] | select(.content=="task-cancelled")] | length')
[[ "$LEAK" -eq 0 ]] || { echo "FAIL: cancelled task still in inbox (count=$LEAK)"; echo "$INBOX" | head -20; exit 1; }

# ─────────────── TERMINAL-STATE NO-OP CONTRACT ───────────────
echo "[7] PIN: send_reply on already-replied task is SILENT no-op"
# R6 抠出的 contract：tools.ts L613-614 WHERE status IN ('created','delivered','acked','running')
# 终态再来 send_reply：response.ok=false 但 DB 不变
ARG=$(jq -nc --arg t "$T_REP" '{alias:"admin",text:"NEW reply trying to overwrite",in_reply_to:$t,status:"replied",from_session:"agent-09"}')
SR2=$(mcp_call "$NTOK" "send_reply" "$ARG")
# send_reply doesn't error visibly — it just inserts inbox row and returns... let's check
# Actually looking at the tool code, it does still log + insert reply inbox row.
# The KEY assertion is that the TASK row's result/status didn't change.
sleep 0.2
[[ "$(task_field "$UTOK" "$NET_ID" "$T_REP" result)" == "OK reply" ]] || \
  { echo "FAIL: terminal task.result was overwritten on second send_reply!"; exit 1; }
[[ "$(task_field "$UTOK" "$NET_ID" "$T_REP" status)" == "replied" ]] || \
  { echo "FAIL: terminal task.status changed on second send_reply"; exit 1; }

echo "[8] PIN: cancel_task on already-cancelled task returns ok:false"
ARG=$(jq -nc --arg t "$T_CXL" '{task_id:$t,reason:"again",from_session:"admin"}')
CXL2=$(mcp_call "$NTOK" "cancel_task" "$ARG")
# cancel_task's WHERE excludes terminal states → changes=0 → ok:false
echo "$CXL2" | jq -e '.ok == false' >/dev/null \
  || { echo "FAIL: cancel_task on terminal task should return ok:false, got: $CXL2"; exit 1; }
# DB state unchanged
[[ "$(task_field "$UTOK" "$NET_ID" "$T_CXL" status)" == "cancelled" ]] || \
  { echo "FAIL: terminal task status changed by re-cancel"; exit 1; }

echo "[9] verify all 3 terminal tasks have completed_at + correct status"
for pair in "$T_REP:replied" "$T_FAIL:failed" "$T_CXL:cancelled"; do
  tid="${pair%%:*}"; want="${pair##*:}"
  got=$(task_field "$UTOK" "$NET_ID" "$tid" status)
  ca=$(task_field "$UTOK" "$NET_ID" "$tid" completed_at)
  [[ "$got" == "$want" ]] || { echo "FAIL: task $tid status=$got want=$want"; exit 1; }
  [[ "$ca" != "null" && -n "$ca" ]] || { echo "FAIL: task $tid completed_at empty"; exit 1; }
done

echo "PASS qa-hub-09 task-state-machine (replied/failed/cancelled all pinned + terminal no-op)"

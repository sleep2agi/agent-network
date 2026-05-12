#!/usr/bin/env bash
# qa-hub-08-restart-persistence — hub 重启不丢状态 + 重新订阅可用
# 用户故事：commhub 滚动重启 / OOM 重启后，
#   1) 已注册的 session 行还在
#   2) inbox 里没 acked 的任务还在
#   3) 重新订阅 SSE 能正常工作
#
# 这是 NODE-04 (agent-node 自重连) 的 hub-side 半边。real anet node CLI 的
# 自动重连逻辑是另一半，需要 NODE-04b 用真 anet node 进程测。
set -euo pipefail

export HOME=/tmp/anethome
mkdir -p "$HOME" /tmp/work
cd /tmp/work

ADMIN_PW="StrongPassw0rd"
HUB_PORT=9200
HUB_BASE="http://127.0.0.1:$HUB_PORT"

cleanup() {
  for p in "${HUB_PID:-}" "${HUB_PID2:-}" "${SSE_PID:-}"; do
    [[ -n "$p" && "$p" != "0" ]] && kill "$p" 2>/dev/null || true
  done
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

npm install -g @sleep2agi/agent-network@preview >/tmp/npm-install.log 2>&1
anet -v >/dev/null

echo "[0] start hub (first time)"
rm -rf "$HOME/.anet/server" "$HOME/.commhub"
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

echo "[2] create network + mint ntok (alias=survive-agent)"
NET_RESP=$(curl -fsS -X POST "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d '{"name":"hub08-net"}')
NET_ID=$(echo "$NET_RESP" | jq -r '.network.network_id // .network_id // empty')
NTOK=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"survive-agent\"}" | jq -r '.token')

echo "[3] survive-agent report_status(idle) — session row created"
ARG=$(jq -nc --arg net "$NET_ID" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-000000000008",alias:"survive-agent",status:"idle",network_id:$net}')
RS=$(mcp_call "$NTOK" "report_status" "$ARG")
echo "$RS" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status: $RS"; exit 1; }

echo "[4] admin sends task #1 (pre-restart, no SSE subscriber → goes to inbox)"
T1=$(curl -fsS -X POST "$HUB_BASE/api/task" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"survive-agent\",\"task\":\"pre-restart-task\",\"priority\":\"normal\",\"network_id\":\"$NET_ID\"}" \
  | jq -r '.message_id')
[[ -n "$T1" && "$T1" != "null" ]] || { echo "FAIL: task1 not sent"; exit 1; }

echo "[5] capture sessions+inbox counts BEFORE restart"
SESSIONS_PRE=$(curl -fsS "$HUB_BASE/api/status?network_id=$NET_ID" \
  -H "Authorization: Bearer $UTOK" | jq '.sessions | length')
TASKS_PRE=$(curl -fsS "$HUB_BASE/api/tasks?network_id=$NET_ID" \
  -H "Authorization: Bearer $UTOK" | jq '.tasks | length')
echo "  pre-restart: $SESSIONS_PRE sessions / $TASKS_PRE tasks"
[[ "$SESSIONS_PRE" -ge 1 ]] || { echo "FAIL: no session pre-restart"; exit 1; }
[[ "$TASKS_PRE" -ge 1 ]] || { echo "FAIL: no task pre-restart"; exit 1; }

echo "[6] KILL hub (anet wrapper spawns bun child → kill both)"
# anet hub start execs bun running commhub-server. SIGTERM to the wrapper
# alone doesn't propagate. Kill both wrapper and bun children by name.
kill -TERM "$HUB_PID" 2>/dev/null || true
pkill -KILL -f 'commhub-server' 2>/dev/null || true
pkill -KILL -f 'anet hub start' 2>/dev/null || true
for i in {1..30}; do
  curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 || break
  sleep 0.2
done
if curl -fsS "$HUB_BASE/health" >/dev/null 2>&1; then
  echo "FAIL: hub did not shut down"; ps auxf | grep -E "(bun|anet|commhub)" | head -10; exit 1
fi
wait "$HUB_PID" 2>/dev/null || true
HUB_PID=0

echo "[7] RESTART hub on same port, same DB"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >>/tmp/hub.log 2>&1 &
HUB_PID2=$!
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$HUB_BASE/health" >/dev/null || { echo "FAIL: hub did not come back"; exit 1; }

echo "[8] login again post-restart (admin password persists)"
UTOK2=""
for i in {1..20}; do
  LOGIN=$(curl -sS -X POST "$HUB_BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}")
  UTOK2=$(echo "$LOGIN" | jq -r '.token // empty')
  [[ "$UTOK2" == utok_* ]] && break
  sleep 0.5
done
[[ "$UTOK2" == utok_* ]] || { echo "FAIL: admin login post-restart"; exit 1; }

echo "[9] PIN: session row + task row survived restart"
SESSIONS_POST=$(curl -fsS "$HUB_BASE/api/status?network_id=$NET_ID" \
  -H "Authorization: Bearer $UTOK2" | jq '[.sessions[] | select(.alias=="survive-agent")] | length')
[[ "$SESSIONS_POST" -ge 1 ]] || { echo "FAIL: survive-agent session missing post-restart"; exit 1; }
TASKS_POST=$(curl -fsS "$HUB_BASE/api/tasks?network_id=$NET_ID" \
  -H "Authorization: Bearer $UTOK2" | jq "[.tasks[] | select(.content==\"pre-restart-task\")] | length")
[[ "$TASKS_POST" -ge 1 ]] || { echo "FAIL: pre-restart-task missing post-restart"; exit 1; }
echo "  ✓ session + task survived (DB persistence works)"

echo "[10] PIN: original NTOK still valid after restart (token hash in DB)"
ARG=$(jq -nc '{alias:"survive-agent",limit:20}')
INBOX=$(mcp_call "$NTOK" "get_inbox" "$ARG")
echo "$INBOX" | jq -e '.ok == true' >/dev/null \
  || { echo "FAIL: original ntok invalid post-restart: $INBOX"; exit 1; }
BACKLOG=$(echo "$INBOX" | jq -r '[.messages[] | select(.content=="pre-restart-task")] | length')
[[ "$BACKLOG" -ge 1 ]] || { echo "FAIL: pre-restart-task not in inbox post-restart"; exit 1; }
echo "  ✓ original ntok works + inbox backlog accessible"

echo "[11] subscribe SSE post-restart (mock-agent reconnects)"
: >/tmp/sse.log
( curl -fsSN -H "Authorization: Bearer $NTOK" \
    "$HUB_BASE/events/survive-agent?network_id=$NET_ID" >>/tmp/sse.log 2>&1 ) &
SSE_PID=$!
for i in {1..20}; do grep -q '"type":"connected"' /tmp/sse.log 2>/dev/null && break; sleep 0.2; done
grep -q '"type":"connected"' /tmp/sse.log || { echo "FAIL: SSE never connected post-restart"; cat /tmp/sse.log; exit 1; }

echo "[12] post-restart task delivery still works"
curl -fsS -X POST "$HUB_BASE/api/task" \
  -H "Authorization: Bearer $UTOK2" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"survive-agent\",\"task\":\"post-restart-task\",\"priority\":\"normal\",\"network_id\":\"$NET_ID\"}" >/dev/null
for i in {1..25}; do grep -q '"type":"new_task"' /tmp/sse.log && break; sleep 0.2; done
grep -q '"type":"new_task"' /tmp/sse.log || { echo "FAIL: SSE did not deliver post-restart task"; cat /tmp/sse.log; exit 1; }

echo "PASS qa-hub-08 restart-persistence (sessions+tasks+ntok+SSE all survived)"

#!/usr/bin/env bash
# qa-hub-07-sse-reconnect — SSE 断后重连契约
# 用户故事：我开 agent，hub 没动但我网络抖了一下断重连，期间发的任务不能丢。
#
# 抠的契约：
#  1. SSE push 是 fire-and-forget — 断开期间的 push 在内存中丢
#  2. 但 inbox 持久化在 DB — 重连后通过 get_inbox 拉回
#  3. 重连后新 push 正常流
set -euo pipefail

export HOME=/tmp/anethome
mkdir -p "$HOME" /tmp/work
cd /tmp/work

ADMIN_PW="StrongPassw0rd"
HUB_PORT=9200
HUB_BASE="http://127.0.0.1:$HUB_PORT"

cleanup() {
  # NEVER pass 0 to kill — it broadcasts to the whole process group and
  # has caused this script to exit non-zero AFTER the PASS line under
  # parallel docker run.
  for p in "${HUB_PID:-}" "${SSE1_PID:-}" "${SSE2_PID:-}"; do
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

echo "[0] start hub"
rm -rf "$HOME/.anet/server" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 1; done

echo "[1] admin login (retry-aware)"
UTOK=""
for i in {1..20}; do
  LOGIN=$(curl -sS -X POST "$HUB_BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}")
  UTOK=$(echo "$LOGIN" | jq -r '.token // empty')
  [[ "$UTOK" == utok_* ]] && break
  sleep 0.5
done
[[ "$UTOK" == utok_* ]] || { echo "FAIL: admin login"; exit 1; }

echo "[2] create network + mint ntok for alias 'subscriber-A'"
NET_RESP=$(curl -fsS -X POST "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d '{"name":"hub07-net"}')
NET_ID=$(echo "$NET_RESP" | jq -r '.network.network_id // .network_id // empty')
[[ -n "$NET_ID" ]] || { echo "FAIL: no net id, resp=$NET_RESP"; exit 1; }
NTOK=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"subscriber-A\"}" | jq -r '.token')
[[ "$NTOK" == ntok_* ]] || { echo "FAIL: ntok"; exit 1; }

echo "[3] subscriber-A reports idle (creates session row)"
ARG=$(jq -nc --arg net "$NET_ID" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-000000000007",alias:"subscriber-A",status:"idle",network_id:$net}')
RS=$(mcp_call "$NTOK" "report_status" "$ARG")
echo "$RS" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status: $RS"; exit 1; }

# ──────────────────────────────────────────────
echo "[4] SSE #1 connect"
: >/tmp/sse1.log
( curl -fsSN -H "Authorization: Bearer $NTOK" \
    "$HUB_BASE/events/subscriber-A?network_id=$NET_ID" >>/tmp/sse1.log 2>&1 ) &
SSE1_PID=$!
for i in {1..20}; do grep -q '"type":"connected"' /tmp/sse1.log 2>/dev/null && break; sleep 0.2; done
grep -q '"type":"connected"' /tmp/sse1.log || { echo "FAIL: SSE1 never connected"; cat /tmp/sse1.log; exit 1; }

echo "[5] admin sends task #1 (subscriber-A online) → SSE1 should push"
T1_RESP=$(curl -fsS -X POST "$HUB_BASE/api/task" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"subscriber-A\",\"task\":\"online-task-1\",\"priority\":\"normal\",\"network_id\":\"$NET_ID\"}")
T1_ID=$(echo "$T1_RESP" | jq -r '.message_id')
for i in {1..25}; do grep -q '"type":"new_task"' /tmp/sse1.log && break; sleep 0.2; done
grep -q '"type":"new_task"' /tmp/sse1.log || { echo "FAIL: SSE1 missed live push"; cat /tmp/sse1.log; exit 1; }

# ──────────────────────────────────────────────
echo "[6] kill SSE #1 (simulate network blip)"
kill "$SSE1_PID" 2>/dev/null || true
wait "$SSE1_PID" 2>/dev/null || true
SSE1_PID=0
sleep 0.3  # let hub notice client gone

echo "[7] admin sends task #2 while subscriber-A has NO SSE connection"
T2_RESP=$(curl -fsS -X POST "$HUB_BASE/api/task" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"subscriber-A\",\"task\":\"offline-task-2\",\"priority\":\"normal\",\"network_id\":\"$NET_ID\"}")
T2_ID=$(echo "$T2_RESP" | jq -r '.message_id')
echo "$T2_RESP" | jq -e '.ok == true' >/dev/null || { echo "FAIL: send during offline failed"; exit 1; }
sleep 0.3  # let inbox row settle

# ──────────────────────────────────────────────
echo "[8] SSE #2 reconnect (same alias, same ntok)"
: >/tmp/sse2.log
( curl -fsSN -H "Authorization: Bearer $NTOK" \
    "$HUB_BASE/events/subscriber-A?network_id=$NET_ID" >>/tmp/sse2.log 2>&1 ) &
SSE2_PID=$!
for i in {1..20}; do grep -q '"type":"connected"' /tmp/sse2.log 2>/dev/null && break; sleep 0.2; done
grep -q '"type":"connected"' /tmp/sse2.log || { echo "FAIL: SSE2 never connected"; cat /tmp/sse2.log; exit 1; }

echo "[9] PIN: SSE #2 did NOT replay task-2 push (fire-and-forget contract)"
sleep 0.5  # ensure no late push
if grep -q '"type":"new_task"' /tmp/sse2.log; then
  echo "UNEXPECTED: SSE2 saw a new_task event. Contract may have changed."
  cat /tmp/sse2.log; exit 1
fi
echo "  → confirmed: SSE pushes are NOT replayed on reconnect. Agent must use get_inbox."

echo "[10] subscriber-A pulls backlog via get_inbox MCP → must include offline-task-2"
ARG=$(jq -nc '{alias:"subscriber-A",limit:20}')
INBOX=$(mcp_call "$NTOK" "get_inbox" "$ARG")
COUNT=$(echo "$INBOX" | jq -r '[.messages[] | select(.content=="offline-task-2")] | length')
[[ "$COUNT" -ge 1 ]] || {
  echo "FAIL: offline-task-2 not in get_inbox backlog"; echo "$INBOX" | jq . | head -40; exit 1
}

echo "[11] admin sends task #3 (subscriber-A reconnected) → SSE2 should push live"
curl -fsS -X POST "$HUB_BASE/api/task" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"subscriber-A\",\"task\":\"online-task-3\",\"priority\":\"normal\",\"network_id\":\"$NET_ID\"}" >/dev/null
for i in {1..25}; do grep -q '"type":"new_task"' /tmp/sse2.log && break; sleep 0.2; done
grep -q '"type":"new_task"' /tmp/sse2.log || { echo "FAIL: SSE2 missed post-reconnect live push"; cat /tmp/sse2.log; exit 1; }

echo "PASS qa-hub-07 sse-reconnect (live push ✓ / offline drop ✓ / get_inbox backlog ✓ / re-live push ✓)"

#!/usr/bin/env bash
# qa-hub-05-roundtrip — register utok → mint ntok → POST /api/task → SSE 收到
# 用户视角 L1 contract test，纯黑盒，不依赖业务源码。
set -euo pipefail

export HOME=/tmp/anethome
mkdir -p "$HOME" /tmp/work
cd /tmp/work

ADMIN_PW="StrongPassw0rd"
HUB_PORT=9200
HUB_BASE="http://127.0.0.1:$HUB_PORT"

cleanup() { kill "${HUB_PID:-0}" "${SSE_PID:-0}" 2>/dev/null || true; }
trap cleanup EXIT

# Install preview CLI
npm install -g @sleep2agi/agent-network@preview >/tmp/npm-install.log 2>&1
anet -v

echo "[0] start hub (no COMMHUB_AUTH_TOKEN, admin bootstrap)"
rm -rf "$HOME/.anet/server" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..120}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 1; done
if ! curl -fsS "$HUB_BASE/health" >/dev/null 2>&1; then
  echo "FAIL: hub never came up; tailing /tmp/hub.log:"
  tail -100 /tmp/hub.log || true
  exit 1
fi

echo "[1] login admin → utok_"
LOGIN_RESP=$(curl -sS -X POST "$HUB_BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}")
UTOK=$(echo "$LOGIN_RESP" | jq -r '.token // empty')
if [[ "$UTOK" != utok_* ]]; then
  echo "FAIL: login did not return utok_; raw response:"; echo "$LOGIN_RESP"
  echo "--- hub.log tail ---"; tail -40 /tmp/hub.log
  exit 1
fi

echo "[2] create network → network_id"
NET_RESP=$(curl -fsS -X POST "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d '{"name":"hub05-net","description":"R2 contract test"}')
NET_ID=$(echo "$NET_RESP" | jq -r '.network.network_id // .network_id // .id // empty')
if [[ -z "$NET_ID" ]]; then
  echo "FAIL: no network_id, raw response:"; echo "$NET_RESP"; exit 1
fi
echo "  network_id=$NET_ID"

echo "[3] mint ntok_ for node 'test-agent'"
NTOK=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"test-agent\"}" | jq -r '.token')
[[ "$NTOK" == ntok_* ]] || { echo "FAIL: ntok shape wrong: $NTOK"; exit 1; }

echo "[4] subscribe SSE on /events/test-agent (background)"
: >/tmp/sse.log
( curl -fsSN -H "Authorization: Bearer $NTOK" \
    "$HUB_BASE/events/test-agent?network_id=$NET_ID" >>/tmp/sse.log 2>&1 ) &
SSE_PID=$!
# Wait for the initial 'connected' line
for i in {1..20}; do grep -q "data:" /tmp/sse.log 2>/dev/null && break; sleep 0.2; done
grep -q "data:" /tmp/sse.log || { echo "FAIL: SSE never opened"; cat /tmp/sse.log; exit 1; }

echo "[5] POST /api/task (utok writes, alias=test-agent)"
TASK_RES=$(curl -fsS -X POST "$HUB_BASE/api/task" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"test-agent\",\"task\":\"hello-r2-hub05\",\"priority\":\"normal\",\"network_id\":\"$NET_ID\"}")
echo "  $TASK_RES" | head -c 200; echo
echo "$TASK_RES" | jq -e '.ok == true' >/dev/null || { echo "FAIL: task send !ok"; exit 1; }

echo "[6] verify task landed in GET /api/tasks (utok scope)"
TASK_ROW=$(curl -fsS "$HUB_BASE/api/tasks?to_name=test-agent&network_id=$NET_ID" \
  -H "Authorization: Bearer $UTOK" | jq -e '.tasks[] | select(.content=="hello-r2-hub05")')
[[ -n "$TASK_ROW" ]] || { echo "FAIL: task not in /api/tasks"; exit 1; }

# Note: SSE *delivery* of the task body requires a pre-registered session
# (server/src/index.ts L836: `if (targetSession) pushEvent(...)`). The
# agent-node CLI would have called report_status on boot, creating that
# row. R3 adds a report_status pre-step to assert SSE delivery end-to-end.
# For R2 we assert only what a black-box hub user can observe from the
# REST + SSE-connection side: connection opens + task lands in DB.
echo "[7] (R3 TODO) assert SSE pushes task body to a pre-registered session"

echo "PASS qa-hub-05 register→mint→send→DB-lands + SSE-connects (R2 scope)"

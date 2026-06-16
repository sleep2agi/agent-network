#!/usr/bin/env bash
# qa-hub-05-roundtrip — register utok → mint ntok → POST /api/task → SSE 收到
# 用户视角 L1 contract test，纯黑盒，不依赖业务源码。
set -euo pipefail

export HOME=/tmp/anethome

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
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
safe_rm_rf "$HOME/.anet/server" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..120}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 1; done
if ! curl -fsS "$HUB_BASE/health" >/dev/null 2>&1; then
  echo "FAIL: hub never came up; tailing /tmp/hub.log:"
  tail -100 /tmp/hub.log || true
  exit 1
fi

echo "[1] login admin → utok_"
# /health may return 200 before admin user is fully bootstrapped — retry up
# to ~10s. Same race surfaced by CI (issue #31 R8) and previously by R2.
UTOK=""
for i in {1..20}; do
  LOGIN_RESP=$(curl -sS -X POST "$HUB_BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}")
  UTOK=$(echo "$LOGIN_RESP" | jq -r '.token // empty')
  [[ "$UTOK" == utok_* ]] && break
  sleep 0.5
done
if [[ "$UTOK" != utok_* ]]; then
  echo "FAIL: login did not return utok_; last response:"; echo "$LOGIN_RESP"
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

echo "[3.5] register session via MCP report_status (so SSE delivery works)"
RESUME_ID="00000000-aaaa-bbbb-cccc-000000000005"
MCP_REQ=$(jq -nc --arg rid "$RESUME_ID" --arg net "$NET_ID" '
  {jsonrpc:"2.0",id:1,method:"tools/call",
   params:{name:"report_status",
           arguments:{resume_id:$rid,alias:"test-agent",status:"idle",network_id:$net}}}')
MCP_RESP=$(curl -sS -X POST "$HUB_BASE/mcp" \
  -H "Authorization: Bearer $NTOK" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-03-26' \
  -d "$MCP_REQ")
# Streamable HTTP may return SSE-framed JSON ("data: {...}") or plain JSON
MCP_JSON=$(echo "$MCP_RESP" | sed -n 's/^data: //p' | head -1)
[[ -z "$MCP_JSON" ]] && MCP_JSON="$MCP_RESP"
INBOX_OK=$(echo "$MCP_JSON" | jq -r '.result.content[0].text // empty' 2>/dev/null | jq -r '.ok // empty' 2>/dev/null)
if [[ "$INBOX_OK" != "true" ]]; then
  echo "FAIL: report_status MCP call did not return ok"
  echo "raw: $MCP_RESP"; exit 1
fi

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

echo "[6] wait up to 5s for SSE to receive new_task push"
for i in {1..25}; do grep -q '"type":"new_task"' /tmp/sse.log && break; sleep 0.2; done
if ! grep -q '"type":"new_task"' /tmp/sse.log; then
  echo "FAIL: SSE never received new_task push"
  echo "--- /tmp/sse.log ---"; cat /tmp/sse.log
  exit 1
fi

echo "[7] verify task landed in GET /api/tasks (utok scope)"
TASK_ROW=$(curl -fsS "$HUB_BASE/api/tasks?to_name=test-agent&network_id=$NET_ID" \
  -H "Authorization: Bearer $UTOK" | jq -e '.tasks[] | select(.content=="hello-r2-hub05")')
[[ -n "$TASK_ROW" ]] || { echo "FAIL: task not in /api/tasks"; exit 1; }

echo "PASS qa-hub-05 register→mint→report_status→send→SSE-push→DB-lands"

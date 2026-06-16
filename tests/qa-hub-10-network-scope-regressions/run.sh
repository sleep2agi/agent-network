#!/usr/bin/env bash
# qa-hub-10-network-scope-regressions — network_id error clarity + SSE isolation
set -euo pipefail

export HOME=/tmp/anethome
HUB_PORT=9210
HUB_BASE="http://127.0.0.1:$HUB_PORT"


# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
cleanup() {
  for p in "${HUB_PID:-}" "${SSE_A_PID:-}" "${SSE_B_PID:-}"; do
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

register_user() {
  local username="$1" password="$2"
  curl -fsS -X POST "$HUB_BASE/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$username\",\"password\":\"$password\"}"
}

wait_for_log() {
  local pattern="$1" file="$2" label="$3"
  for _ in {1..30}; do
    grep -q "$pattern" "$file" 2>/dev/null && return 0
    sleep 0.2
  done
  echo "FAIL: timed out waiting for $label in $file"
  cat "$file" || true
  exit 1
}

assert_no_log() {
  local pattern="$1" file="$2" label="$3"
  sleep 0.8
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo "FAIL: unexpected $label in $file"
    cat "$file"
    exit 1
  fi
}

echo "[0] start local hub from repository source"
safe_rm_rf "$HOME/.commhub" "$HOME/.anet/server"
cd /app/server
HOST=127.0.0.1 PORT="$HUB_PORT" bun run src/index.ts >/tmp/hub.log 2>&1 &
HUB_PID=$!
for _ in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null || { echo "FAIL: hub did not start"; cat /tmp/hub.log; exit 1; }

echo "[1] register two users with separate default networks"
A_RESP=$(register_user aliceA StrongPassw0rdA)
B_RESP=$(register_user bobB StrongPassw0rdB)
UTOK_A=$(echo "$A_RESP" | jq -r '.token // empty')
NTOK_A=$(echo "$A_RESP" | jq -r '.network_token // empty')
NET_A=$(echo "$A_RESP" | jq -r '.network_id // empty')
UTOK_B=$(echo "$B_RESP" | jq -r '.token // empty')
NTOK_B=$(echo "$B_RESP" | jq -r '.network_token // empty')
NET_B=$(echo "$B_RESP" | jq -r '.network_id // empty')
[[ "$UTOK_A" == utok_* && "$NTOK_A" == ntok_* && -n "$NET_A" ]] || { echo "FAIL: user A registration"; echo "$A_RESP"; exit 1; }
[[ "$UTOK_B" == utok_* && "$NTOK_B" == ntok_* && -n "$NET_B" ]] || { echo "FAIL: user B registration"; echo "$B_RESP"; exit 1; }
[[ "$NET_A" != "$NET_B" ]] || { echo "FAIL: networks should differ"; exit 1; }

echo "[2] same alias reports status in both networks"
ARG_A=$(jq -nc --arg net "$NET_A" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-000000000010",alias:"shared-agent",status:"idle",network_id:$net}')
ARG_B=$(jq -nc --arg net "$NET_B" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-000000000011",alias:"shared-agent",status:"idle",network_id:$net}')
RS_A=$(mcp_call "$NTOK_A" "report_status" "$ARG_A")
RS_B=$(mcp_call "$NTOK_B" "report_status" "$ARG_B")
echo "$RS_A" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status A: $RS_A"; exit 1; }
echo "$RS_B" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status B: $RS_B"; exit 1; }

echo "[3] utok send_task without network_id returns actionable missing-network message"
NO_NET_ARGS=$(jq -nc '{alias:"shared-agent",task:"missing-network-id",from_session:"alice-dashboard"}')
NO_NET=$(mcp_call "$UTOK_A" "send_task" "$NO_NET_ARGS")
echo "$NO_NET" | jq -e '.ok == false and .error == "permission_denied" and (.message | contains("network_id required"))' >/dev/null || {
  echo "FAIL: expected network_id required error, got: $NO_NET"
  exit 1
}
if echo "$NO_NET" | jq -r '.message // ""' | grep -q "Viewer role"; then
  echo "FAIL: missing network_id must not be reported as viewer role"
  echo "$NO_NET"
  exit 1
fi

echo "[4] connect two SSE subscribers for same alias in different networks"
: >/tmp/sse-a.log
: >/tmp/sse-b.log
( curl -fsSN -H "Authorization: Bearer $NTOK_A" \
    "$HUB_BASE/events/shared-agent?network_id=$NET_A" >>/tmp/sse-a.log 2>&1 ) &
SSE_A_PID=$!
( curl -fsSN -H "Authorization: Bearer $NTOK_B" \
    "$HUB_BASE/events/shared-agent?network_id=$NET_B" >>/tmp/sse-b.log 2>&1 ) &
SSE_B_PID=$!
wait_for_log '"type":"connected"' /tmp/sse-a.log "SSE A connected"
wait_for_log '"type":"connected"' /tmp/sse-b.log "SSE B connected"

echo "[5] task push in network A must not leak to network B"
: >/tmp/sse-a.log
: >/tmp/sse-b.log
TASK_A=$(jq -nc '{alias:"shared-agent",task:"alpha-only",from_session:"alpha-sender"}')
SEND_A=$(mcp_call "$NTOK_A" "send_task" "$TASK_A")
echo "$SEND_A" | jq -e '.ok == true' >/dev/null || { echo "FAIL: send_task A: $SEND_A"; exit 1; }
wait_for_log '"from":"alpha-sender"' /tmp/sse-a.log "network A task push"
assert_no_log '"from":"alpha-sender"' /tmp/sse-b.log "network A task push leaked to B"

echo "[6] task push in network B must not leak to network A"
: >/tmp/sse-a.log
: >/tmp/sse-b.log
TASK_B=$(jq -nc '{alias:"shared-agent",task:"beta-only",from_session:"beta-sender"}')
SEND_B=$(mcp_call "$NTOK_B" "send_task" "$TASK_B")
echo "$SEND_B" | jq -e '.ok == true' >/dev/null || { echo "FAIL: send_task B: $SEND_B"; exit 1; }
wait_for_log '"from":"beta-sender"' /tmp/sse-b.log "network B task push"
assert_no_log '"from":"beta-sender"' /tmp/sse-a.log "network B task push leaked to A"

echo "[7] broadcast in network A must not push to network B"
: >/tmp/sse-a.log
: >/tmp/sse-b.log
BROADCAST_A=$(jq -nc '{message:"alpha-broadcast"}')
BC_A=$(mcp_call "$NTOK_A" "broadcast" "$BROADCAST_A")
echo "$BC_A" | jq -e '.ok == true and .recipients >= 1' >/dev/null || { echo "FAIL: broadcast A: $BC_A"; exit 1; }
wait_for_log '"type":"broadcast"' /tmp/sse-a.log "network A broadcast"
assert_no_log '"type":"broadcast"' /tmp/sse-b.log "network A broadcast leaked to B"

echo "PASS qa-hub-10 network scope regressions (#67 message ✓ / #54 SSE isolation ✓)"

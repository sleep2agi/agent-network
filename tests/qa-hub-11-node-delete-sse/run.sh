#!/usr/bin/env bash
# qa-hub-11-node-delete-sse — node deletion must push network-scoped SSE event
set -euo pipefail
# 绑了还要看得见（#1092）：报告里没有这一行，就没法把这次运行钉到某个提交上。
printf 'source_commit=%s\n' "${SOURCE_COMMIT:-unknown}"

export HOME=/tmp/anethome
HUB_PORT=9211
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

# #203/#376 之后,report_status 的 alias 必须与 token 绑定的 alias 一致
# (server.ts:733 从 api_tokens.name='node:<alias>' 推导 callerAlias;
#  注册时拿到的 network_token 名字不是 node:…，会回落成**用户名**，
#  于是用它上报任意 alias 一律 alias_identity_mismatch)。
# 所以每个要上报的 alias 都得先铸一个属于它自己的 node token。
# 取法与已注册且长期绿的 qa-hub-05-roundtrip 完全一致。
node_token() {
  local utok="$1" net="$2" alias="$3" tok
  tok=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
    -H "Authorization: Bearer $utok" -H 'Content-Type: application/json' \
    -d "{\"network_id\":\"$net\",\"node_name\":\"$alias\"}" | jq -r '.token // empty')
  [[ "$tok" == ntok_* ]] || { echo "FAIL: node_token($alias) shape wrong: $tok" >&2; exit 1; }
  printf '%s' "$tok"
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
A_RESP=$(register_user alice74 StrongPassw0rdA)
B_RESP=$(register_user bob74 StrongPassw0rdB)
UTOK_A=$(echo "$A_RESP" | jq -r '.token // empty')
NTOK_A=$(echo "$A_RESP" | jq -r '.network_token // empty')
NET_A=$(echo "$A_RESP" | jq -r '.network_id // empty')
UTOK_B=$(echo "$B_RESP" | jq -r '.token // empty')
NTOK_B=$(echo "$B_RESP" | jq -r '.network_token // empty')
NET_B=$(echo "$B_RESP" | jq -r '.network_id // empty')
[[ "$UTOK_A" == utok_* && "$NTOK_A" == ntok_* && -n "$NET_A" ]] || { echo "FAIL: user A registration"; echo "$A_RESP"; exit 1; }
[[ "$UTOK_B" == utok_* && "$NTOK_B" == ntok_* && -n "$NET_B" ]] || { echo "FAIL: user B registration"; echo "$B_RESP"; exit 1; }
[[ "$NET_A" != "$NET_B" ]] || { echo "FAIL: networks should differ"; exit 1; }

echo "[2] same alias reports two distinct node rows"
ARG_A=$(jq -nc --arg net "$NET_A" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-000000000074",alias:"delete-me",status:"idle",network_id:$net,node_id:"node-a-74",node_name:"delete-me",agent:"agent-node:claude-agent",model:"test-model"}')
ARG_B=$(jq -nc --arg net "$NET_B" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-000000000075",alias:"delete-me",status:"idle",network_id:$net,node_id:"node-b-74",node_name:"delete-me",agent:"agent-node:claude-agent",model:"test-model"}')
# 同一 alias 在两个网络各产生一条独立 node 行 —— 本套件要测的语义。
# #203 之后每个网络里的那个同名节点要各自持有自己的 token(见 node_token 注释)。
NODE_TOK_A=$(node_token "$UTOK_A" "$NET_A" "delete-me")
NODE_TOK_B=$(node_token "$UTOK_B" "$NET_B" "delete-me")
RS_A=$(mcp_call "$NODE_TOK_A" "report_status" "$ARG_A")
RS_B=$(mcp_call "$NODE_TOK_B" "report_status" "$ARG_B")
echo "$RS_A" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status A: $RS_A"; exit 1; }
echo "$RS_B" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status B: $RS_B"; exit 1; }

echo "[3] connect SSE for same alias in both networks"
: >/tmp/sse-a.log
: >/tmp/sse-b.log
( curl -fsSN -H "Authorization: Bearer $NTOK_A" \
    "$HUB_BASE/events/delete-me?network_id=$NET_A" >>/tmp/sse-a.log 2>&1 ) &
SSE_A_PID=$!
( curl -fsSN -H "Authorization: Bearer $NTOK_B" \
    "$HUB_BASE/events/delete-me?network_id=$NET_B" >>/tmp/sse-b.log 2>&1 ) &
SSE_B_PID=$!
wait_for_log '"type":"connected"' /tmp/sse-a.log "SSE A connected"
wait_for_log '"type":"connected"' /tmp/sse-b.log "SSE B connected"

echo "[4] delete node A and verify network-scoped node_deleted push"
: >/tmp/sse-a.log
: >/tmp/sse-b.log
DEL_A=$(curl -fsS -X DELETE "$HUB_BASE/api/nodes/node-a-74?network_id=$NET_A" \
  -H "Authorization: Bearer $UTOK_A")
echo "$DEL_A" | jq -e '.ok == true and .deleted == true and .node_id == "node-a-74"' >/dev/null || {
  echo "FAIL: delete response: $DEL_A"
  exit 1
}
wait_for_log '"type":"node_deleted"' /tmp/sse-a.log "node_deleted in network A"
wait_for_log '"node_id":"node-a-74"' /tmp/sse-a.log "node id in network A delete event"
assert_no_log '"type":"node_deleted"' /tmp/sse-b.log "node_deleted leaked to network B"

echo "[5] deleted node/session gone from A; B remains"
NODES_A=$(curl -fsS "$HUB_BASE/api/nodes?network_id=$NET_A" -H "Authorization: Bearer $UTOK_A")
NODES_B=$(curl -fsS "$HUB_BASE/api/nodes?network_id=$NET_B" -H "Authorization: Bearer $UTOK_B")
echo "$NODES_A" | jq -e '[.nodes[]? | select(.node_id=="node-a-74")] | length == 0' >/dev/null || {
  echo "FAIL: node-a-74 still present: $NODES_A"
  exit 1
}
echo "$NODES_B" | jq -e '[.nodes[]? | select(.node_id=="node-b-74")] | length == 1' >/dev/null || {
  echo "FAIL: node-b-74 missing: $NODES_B"
  exit 1
}
STATUS_A=$(curl -fsS "$HUB_BASE/api/status?network_id=$NET_A" -H "Authorization: Bearer $UTOK_A")
echo "$STATUS_A" | jq -e '[.sessions[]? | select(.alias=="delete-me")] | length == 0' >/dev/null || {
  echo "FAIL: deleted session still present: $STATUS_A"
  exit 1
}

echo "PASS qa-hub-11 node-delete-sse (#74 node_deleted push ✓ / network isolation ✓ / stale rows removed ✓)"

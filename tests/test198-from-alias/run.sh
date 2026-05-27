#!/usr/bin/env bash
set -euo pipefail

export HOME=/tmp/anethome
export COMMHUB_DB=/tmp/commhub-from-alias.db
export PORT=19200
BASE="http://127.0.0.1:${PORT}"
REPORT="/repo/docs/tests/p198-from-alias/report-test198-from-alias.txt"
mkdir -p "$(dirname "$REPORT")" "$HOME"

cleanup() { kill "${HUB_PID:-0}" 2>/dev/null || true; }
trap cleanup EXIT

mcp_call() {
  local token="$1" tool="$2" args="$3"
  local body raw json text
  body=$(jq -nc --arg n "$tool" --argjson a "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  raw=$(curl -sS -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "MCP-Protocol-Version: 2025-03-26" \
    -d "$body")
  json=$(echo "$raw" | sed -n 's/^data: //p' | head -1)
  [[ -z "$json" ]] && json="$raw"
  text=$(echo "$json" | jq -r '.result.content[0].text // empty')
  [[ -n "$text" ]] || { echo "empty MCP response for $tool: $raw" >&2; return 1; }
  echo "$text"
}

json_post() {
  local path="$1" token="$2" body="$3"
  curl -sS -X POST "$BASE$path" \
    ${token:+-H "Authorization: Bearer $token"} \
    -H "Content-Type: application/json" \
    -d "$body"
}

{
  echo "# test198-from-alias"
  echo
  echo "Start local commhub from source."
} > "$REPORT"

rm -f "$COMMHUB_DB"
bun run server/src/index.ts >/tmp/commhub.log 2>&1 &
HUB_PID=$!
for _ in {1..80}; do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/health" >/dev/null || { tail -120 /tmp/commhub.log; exit 1; }

ADMIN=$(json_post "/api/auth/register" "" '{"username":"admin","password":"anethub"}')
UTOK=$(echo "$ADMIN" | jq -r '.token // empty')
[[ "$UTOK" == utok_* ]] || { echo "register failed: $ADMIN"; exit 1; }

NET=$(json_post "/api/networks" "$UTOK" '{"name":"from-alias-net"}')
NET_ID=$(echo "$NET" | jq -r '.network.network_id // .network_id // empty')
[[ -n "$NET_ID" ]] || { echo "network failed: $NET"; exit 1; }

NODE=$(json_post "/api/auth/node-token" "$UTOK" "{\"network_id\":\"$NET_ID\",\"node_name\":\"grok测试员\"}")
NTOK=$(echo "$NODE" | jq -r '.token // empty')
[[ "$NTOK" == ntok_* ]] || { echo "node-token failed: $NODE"; exit 1; }

echo "Register current runtime alias with token minted under old alias." >> "$REPORT"
RS=$(mcp_call "$NTOK" "report_status" "$(jq -nc --arg net "$NET_ID" \
  '{resume_id:"r-from-alias-1",alias:"grok测试4",status:"idle",network_id:$net}')")
echo "$RS" | jq -e '.ok == true and .alias == "grok测试4"' >/dev/null || { echo "report_status failed: $RS"; exit 1; }

echo "Send message without from_session, matching native MCP tool calls." >> "$REPORT"
SM=$(mcp_call "$NTOK" "send_message" '{"alias":"总指挥","message":"hello from current alias"}')
echo "$SM" | jq -e '.ok == true' >/dev/null || { echo "send_message failed: $SM"; exit 1; }

MSG=$(mcp_call "$NTOK" "get_inbox" '{"alias":"总指挥","limit":5}')
FROM=$(echo "$MSG" | jq -r '.messages[0].from_session // empty')
[[ "$FROM" == "grok测试4" ]] || {
  echo "FAIL: expected from_session=grok测试4, got $FROM"
  echo "$MSG"
  exit 1
}

echo "Try spoofing from_session with same ntok; server must keep current alias." >> "$REPORT"
ST=$(mcp_call "$NTOK" "send_task" '{"alias":"总指挥","task":"spoof check","from_session":"grok测试员"}')
echo "$ST" | jq -e '.ok == true' >/dev/null || { echo "send_task failed: $ST"; exit 1; }

MSG2=$(mcp_call "$NTOK" "get_inbox" '{"alias":"总指挥","limit":5}')
SPOOF_FROM=$(echo "$MSG2" | jq -r '.messages[] | select(.content=="spoof check") | .from_session' | head -1)
[[ "$SPOOF_FROM" == "grok测试4" ]] || {
  echo "FAIL: spoof check expected from_session=grok测试4, got $SPOOF_FROM"
  echo "$MSG2"
  exit 1
}

{
  echo
  echo "PASS: ntok minted for old alias is reconciled on report_status."
  echo "PASS: native MCP send_message without from_session uses current registered alias."
  echo "PASS: ntok caller cannot spoof from_session to stale alias."
} >> "$REPORT"

cat "$REPORT"

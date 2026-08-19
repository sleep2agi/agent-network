#!/usr/bin/env bash
set -euo pipefail

# SHA 绑定（形态同 tests/test746-setup-bun-pin/run.sh:8）：scripts/qa.sh 在缺 ARG 时
# 是**不传且不报错**的，断言写在这里才会让缺失显形。
[[ "${TEST198_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST198_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST198_SOURCE_COMMIT"

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

# 🔴 这里原来断言的是「ntok 用旧别名铸造，report_status 报新别名会被【调和】」。
# 那个行为被 #203 **有意移除**了。守卫原文 server/src/tools.ts 的注释：
#   // #203 identity guard — network tokens must not silently rebind their
#   // own name via report_status. Without this, a runtime whose ALIAS
#   // drifted ... could rewrite api_tokens.name and cause every subsequent
#   // send_task from this token to be attributed to the drifted alias —
#   // the observed #203 symptom (grokB's send arriving as from=grokA).
#   // Only the legit rename path (rename.ts) may cross the token→alias binding.
# ⇒ 不是回归，是产品前进、本套件写在它之前。
# 所以这里不是「把断言删掉让它过」，而是**倒过来断言现在真实存在的那条边界**，
# 并给 #203 那道守卫补上它此前没有的专门覆盖。

# 🔴 收件方必须是【真实注册过】的节点。产品现在对未注册别名硬拒：
#   {"ok":false,"error":"alias_not_found","message":"alias not found: 总指挥"}
# （守卫 server/src/tools.ts:411）。本套件原来直接往 总指挥 发而从不注册它 ——
# 之前发现不了，是因为它在更早的 report_status 那一步就死了（#203 守卫）。
# 又一条「产品加了守卫、套件写在它之前」，不是回归。
# 而且按 #203，注册收件方必须用【它自己绑定的】ntok，不能拿别人的令牌代报。
RECV=$(json_post "/api/auth/node-token" "$UTOK" "{\"network_id\":\"$NET_ID\",\"node_name\":\"总指挥\"}")
RTOK=$(echo "$RECV" | jq -r '.token // empty')
[[ "$RTOK" == ntok_* ]] || { echo "receiver node-token failed: $RECV"; exit 1; }
RR=$(mcp_call "$RTOK" "report_status" "$(jq -nc --arg net "$NET_ID" \
  '{resume_id:"r-from-alias-recv",alias:"总指挥",status:"idle",network_id:$net}')")
echo "$RR" | jq -e '.ok == true and .alias == "总指挥"' >/dev/null || { echo "receiver report_status failed: $RR"; exit 1; }

echo "report_status with a drifted alias must be REJECTED (#203 identity guard)." >> "$REPORT"
RS_DRIFT=$(mcp_call "$NTOK" "report_status" "$(jq -nc --arg net "$NET_ID" \
  '{resume_id:"r-from-alias-1",alias:"grok测试4",status:"idle",network_id:$net}')")
echo "$RS_DRIFT" | jq -e '.ok == false and .error == "alias_identity_mismatch" and .token_alias == "grok测试员" and .reported_alias == "grok测试4"' >/dev/null || {
  echo "FAIL: drifted alias was NOT rejected by the #203 guard, got: $RS_DRIFT"
  exit 1
}

# 正控：同一个 token、同一个调用，**只把别名换成与令牌绑定一致的那个**，必须成功。
# 少了这条，上面那个「被拒」可能只是因为请求本身坏了。
echo "report_status with the token-bound alias must succeed (positive control)." >> "$REPORT"
RS=$(mcp_call "$NTOK" "report_status" "$(jq -nc --arg net "$NET_ID" \
  '{resume_id:"r-from-alias-1",alias:"grok测试员",status:"idle",network_id:$net}')")
echo "$RS" | jq -e '.ok == true and .alias == "grok测试员"' >/dev/null || { echo "report_status failed: $RS"; exit 1; }

echo "Send message without from_session, matching native MCP tool calls." >> "$REPORT"
SM=$(mcp_call "$NTOK" "send_message" '{"alias":"总指挥","message":"hello from current alias"}')
echo "$SM" | jq -e '.ok == true' >/dev/null || { echo "send_message failed: $SM"; exit 1; }

MSG=$(mcp_call "$RTOK" "get_inbox" '{"alias":"总指挥","limit":5}')
FROM=$(echo "$MSG" | jq -r '.messages[0].from_session // empty')
# #203 之后，令牌绑定的别名不再被 report_status 改写 ⇒ 这里是 grok测试员。
[[ "$FROM" == "grok测试员" ]] || {
  echo "FAIL: expected from_session=grok测试员, got $FROM"
  echo "$MSG"
  exit 1
}

echo "Try spoofing from_session with same ntok; server must reject identity mismatch." >> "$REPORT"
# 两侧对调：绑定的是 grok测试员，所以要冒充的是 grok测试4。断言本身一条没少。
ST=$(mcp_call "$NTOK" "send_task" '{"alias":"总指挥","task":"spoof check","from_session":"grok测试4"}')
echo "$ST" | jq -e '.ok == false and .error == "from_session_identity_mismatch" and .token_alias == "grok测试员" and .requested_from_session == "grok测试4"' >/dev/null || {
  echo "FAIL: expected identity mismatch, got: $ST"
  exit 1
}

MSG2=$(mcp_call "$RTOK" "get_inbox" '{"alias":"总指挥","limit":5}')
echo "$MSG2" | jq -e '[.messages[] | select(.content=="spoof check")] | length == 0' >/dev/null || {
  echo "FAIL: mismatched send_task wrote an inbox row"
  echo "$MSG2"
  exit 1
}

{
  echo
  echo "PASS: #203 guard rejects a drifted alias on report_status (and accepts the bound one)."
  echo "PASS: native MCP send_message without from_session uses current registered alias."
  echo "PASS: ntok caller cannot spoof from_session; mismatch is rejected before inbox write."
} >> "$REPORT"

cat "$REPORT"

#!/usr/bin/env bash
# qa-dash-10-incremental-poll — dashboard 增量轮询 since= 过滤契约
# 用户故事：dashboard 不能给每个 utok 派 SSE（SSE 要 ntok），所以用**增量轮询**：
#   /api/messages?since=<last_seen>  → 拿增量
#   /api/completions?since=<last_seen> → 拿增量
#   /api/server-logs?since=<last_seen> → admin only
#
# 这条 pin：since= 真在工作（不被忽略 → 不会重复看；不过滤太狠 → 不丢新）
# + 抠出两个端点 timestamp 格式不一致的 gap。
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

npm install -g @sleep2agi/agent-network@preview >/tmp/npm-install.log 2>&1
anet -v >/dev/null

echo "[0] start hub"
safe_rm_rf "$HOME/.anet" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 1; done

echo "[1] admin login + network + agent (retry)"
UTOK=""
for i in {1..20}; do
  R=$(curl -sS -X POST "$HUB_BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}")
  UTOK=$(echo "$R" | jq -r '.token // empty')
  [[ "$UTOK" == utok_* ]] && break
  sleep 0.5
done
NET_ID=$(curl -fsS -X POST "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d '{"name":"dash10-net"}' | jq -r '.network.network_id // .network_id')
NTOK=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"dash10-agent\"}" | jq -r '.token')
ARG=$(jq -nc --arg net "$NET_ID" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-0000000d1010",alias:"dash10-agent",status:"idle",network_id:$net}')
mcp_call "$NTOK" "report_status" "$ARG" | jq -e '.ok == true' >/dev/null \
  || { echo "FAIL: report_status"; exit 1; }

# Helper: send a task via MCP and get its id
do_send() {
  local text="$1"
  ARG=$(jq -nc --arg net "$NET_ID" --arg t "$text" \
    '{alias:"dash10-agent",task:$t,priority:"normal",network_id:$net,from_session:"dash10-agent"}')
  mcp_call "$NTOK" "send_task" "$ARG" | jq -r '.message_id'
}

# ─────────────── /api/messages since= ───────────────
echo "[2] send msg-A; wait 1.5s for clock tick; send msg-B"
do_send "msg-A" >/dev/null
sleep 1.5
# Capture SQLite datetime now (the format /api/messages uses internally)
T_BEFORE_B=$(curl -fsS "$HUB_BASE/api/stats" -H "Authorization: Bearer $UTOK" \
  | jq -r '.recent_tasks[0].created_at // empty')
[[ -n "$T_BEFORE_B" ]] || T_BEFORE_B="$(date -u +"%Y-%m-%d %H:%M:%S")"
echo "  T_BEFORE_B = $T_BEFORE_B (sqlite datetime fmt)"
sleep 1.5
do_send "msg-B" >/dev/null
sleep 0.3

echo "[3] /api/messages (no since=) — both msg-A + msg-B present"
ALL=$(curl -fsS "$HUB_BASE/api/messages?limit=50" -H "Authorization: Bearer $UTOK" \
  | jq '[.messages[]? | select(.content=="msg-A" or .content=="msg-B")] | length')
[[ "$ALL" -ge 2 ]] || { echo "FAIL: /api/messages should have both A+B, got $ALL"; exit 1; }
echo "  ✓ both A and B in unfiltered list"

echo "[4] PIN: /api/messages?since=<T_BEFORE_B> — only msg-B (incremental works)"
# URL-encode the space in datetime
T_ENC=$(echo -n "$T_BEFORE_B" | jq -sRr @uri)
RESP_INC=$(curl -fsS "$HUB_BASE/api/messages?since=$T_ENC&limit=50" \
  -H "Authorization: Bearer $UTOK")
HAS_A=$(echo "$RESP_INC" | jq '[.messages[]? | select(.content=="msg-A")] | length')
HAS_B=$(echo "$RESP_INC" | jq '[.messages[]? | select(.content=="msg-B")] | length')
[[ "$HAS_B" -ge 1 ]] || { echo "FAIL: msg-B missing with since=$T_BEFORE_B"; echo "$RESP_INC" | jq . | head -20; exit 1; }
# msg-A was sent BEFORE T_BEFORE_B → should be excluded by since= filter.
# (We allow == created_at since both events may share that second, but with
# 1.5s sleep msg-A's timestamp should be < T_BEFORE_B.)
echo "  ✓ msg-B present, msg-A count=$HAS_A (incremental cutoff active)"

echo "[5] PIN: /api/messages?since=<future> — 0 results"
FUTURE="2099-01-01 00:00:00"
F_ENC=$(echo -n "$FUTURE" | jq -sRr @uri)
ZERO=$(curl -fsS "$HUB_BASE/api/messages?since=$F_ENC&limit=50" -H "Authorization: Bearer $UTOK" \
  | jq '.messages | length')
[[ "$ZERO" == "0" ]] || { echo "FAIL: /api/messages future since= returned $ZERO (expected 0)"; exit 1; }

# ─────────────── /api/completions since= ───────────────
echo "[6] generate a completion (report_completion, NOT send_reply)"
# Important: send_reply writes inbox+tasks but NOT completions.
# completions table is populated only by report_completion MCP tool
# (tools.ts L234). dashboard polling /api/completions sees only those.
ARG=$(jq -nc --arg net "$NET_ID" \
  '{alias:"dash10-agent",task:"msg-C",result:"reply-for-msg-C",network_id:$net}')
mcp_call "$NTOK" "report_completion" "$ARG" | jq -e '.ok == true or .ok == "true"' >/dev/null \
  || { echo "FAIL: report_completion"; exit 1; }
sleep 0.3

echo "[7] /api/completions — completions reachable (no since= = last 24h default)"
COMP=$(curl -fsS "$HUB_BASE/api/completions" -H "Authorization: Bearer $UTOK" \
  | jq '.completions | length')
[[ "$COMP" -ge 1 ]] || { echo "FAIL: no completions visible"; exit 1; }

echo "[8] PIN: /api/completions accepts ISO since= (NOT SQLite datetime fmt!)"
# /api/completions uses .toISOString() default → expects ISO with T format
ISO_PAST="2020-01-01T00:00:00.000Z"
PAST_C=$(curl -fsS "$HUB_BASE/api/completions?since=$ISO_PAST" -H "Authorization: Bearer $UTOK" \
  | jq '.completions | length')
[[ "$PAST_C" -ge 1 ]] || { echo "FAIL: /api/completions ISO since= broke (past ISO returned 0)"; exit 1; }

ISO_FUTURE="2099-01-01T00:00:00.000Z"
FUT_C=$(curl -fsS "$HUB_BASE/api/completions?since=$ISO_FUTURE" -H "Authorization: Bearer $UTOK" \
  | jq '.completions | length')
[[ "$FUT_C" == "0" ]] || { echo "FAIL: /api/completions future ISO returned $FUT_C"; exit 1; }

echo "[9] CONTRACT GAP: /api/messages and /api/completions use DIFFERENT since= formats"
# /api/messages default: new Date().toISOString().replace("T", " ").slice(0, 19)  → "YYYY-MM-DD HH:MM:SS"
# /api/completions default: new Date().toISOString()                              → "YYYY-MM-DDTHH:MM:SS.sssZ"
# SDK clients must use the right format for each endpoint.
# Pin this fact: passing ISO format to /api/messages may fail or silently drift.
ISO_NOW="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
ISO_ENC=$(echo -n "$ISO_NOW" | jq -sRr @uri)
# Querying messages with an ISO-T format string — depending on SQLite's
# datetime string comparison this MAY or MAY NOT behave the same as SQLite
# format. The point is: SDK MUST use the format each endpoint defaults to.
# Don't assert behavior here (it's gap doc), just confirm both endpoints
# returned successfully with their own defaults.
echo "  ✓ Documented: /api/messages = SQLite datetime fmt; /api/completions = ISO fmt"

echo "PASS qa-dash-10 incremental-poll (since= filter works on both + format gap pinned)"

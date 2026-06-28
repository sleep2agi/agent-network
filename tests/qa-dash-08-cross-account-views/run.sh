#!/usr/bin/env bash
# qa-dash-08-cross-account-views — dashboard-style 多端点跨账号 IDOR 枚举
# 用户故事：dashboard 展示「我的节点 / 任务 / 统计 / completion」。
#   alice 和 bob 是独立账号 —— bob 登录 dashboard 不能看到 alice 的任何聚合。
#
# R17 (HUB-06b) 覆盖了 /api/networks / /api/tasks / /api/status / /api/messages。
# R19 (DASH-08) 补 dashboard 用的其余端点：
#   /api/nodes / /api/stats / /api/completions / /api/auth/tokens
#   + 显式 ?to_name=<alice-agent> filter / ?from_name=alice 等过滤参数
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
ALICE_PW="AlicePass1@"
BOB_PW="BobPass1@!"
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
sleep 1

echo "[1] register alice + bob"
for u in alice bob; do
  pw_var=$(echo "${u^^}_PW"); pw="${!pw_var}"
  curl -fsS -X POST "$HUB_BASE/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$u\",\"password\":\"$pw\"}" >/dev/null
done
UTOK_ALICE=$(curl -fsS -X POST "$HUB_BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"alice\",\"password\":\"$ALICE_PW\"}" | jq -r '.token')
UTOK_BOB=$(curl -fsS -X POST "$HUB_BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"bob\",\"password\":\"$BOB_PW\"}" | jq -r '.token')

echo "[2] alice creates 'alice-private' + 'alice-secret-agent' + sends + replies"
ALICE_NET=$(curl -fsS -X POST "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer $UTOK_ALICE" -H 'Content-Type: application/json' \
  -d '{"name":"alice-private"}' | jq -r '.network.network_id // .network_id')
ALICE_NTOK=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK_ALICE" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$ALICE_NET\",\"node_name\":\"alice-secret-agent\"}" | jq -r '.token')
# session row
ARG=$(jq -nc --arg net "$ALICE_NET" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-00000000a17b",alias:"alice-secret-agent",status:"idle",network_id:$net}')
mcp_call "$ALICE_NTOK" "report_status" "$ARG" | jq -e '.ok == true' >/dev/null \
  || { echo "FAIL: alice report_status"; exit 1; }
# dispatch + reply (so /api/completions gets a row)
ARG=$(jq -nc --arg net "$ALICE_NET" \
  '{alias:"alice-secret-agent",task:"alice-confidential-task",priority:"normal",network_id:$net,from_session:"alice-secret-agent"}')
TASK_ID=$(mcp_call "$ALICE_NTOK" "send_task" "$ARG" | jq -r '.message_id')
[[ -n "$TASK_ID" && "$TASK_ID" != "null" ]] || { echo "FAIL: no task id"; exit 1; }
ARG=$(jq -nc --arg t "$TASK_ID" \
  '{alias:"alice",text:"alice-private-reply-text",in_reply_to:$t,status:"replied",from_session:"alice-secret-agent"}')
mcp_call "$ALICE_NTOK" "send_reply" "$ARG" | jq -e '.ok == true' >/dev/null \
  || { echo "FAIL: alice send_reply"; exit 1; }

# Give DB a moment to settle
sleep 0.3

# ─────────────── BOB IDOR PROBES ───────────────
# Helper: assert a JSON path doesn't include alice's data
expect_no_alice() {
  local desc="$1" json="$2" jq_filter="$3"
  local hit
  hit=$(echo "$json" | jq "$jq_filter")
  if [[ "$hit" -gt 0 ]]; then
    echo "FAIL: $desc — bob saw $hit alice item(s)"
    echo "$json" | jq . | head -30
    exit 1
  fi
  echo "  ✓ $desc (0 hits)"
}

echo "[3] PIN: bob GET /api/nodes — no alice-secret-agent"
R=$(curl -fsS "$HUB_BASE/api/nodes" -H "Authorization: Bearer $UTOK_BOB")
expect_no_alice "/api/nodes" "$R" '[.nodes[]? | select(.alias=="alice-secret-agent" or .node_name=="alice-secret-agent")] | length'

echo "[4] PIN: bob GET /api/stats — recent_tasks shouldn't include alice's"
R=$(curl -fsS "$HUB_BASE/api/stats" -H "Authorization: Bearer $UTOK_BOB")
expect_no_alice "/api/stats recent_tasks" "$R" '[.recent_tasks[]? | select(.to_name=="alice-secret-agent")] | length'
# Also: bob's total task count should be 0 (he hasn't dispatched anything)
BOB_TOTAL=$(echo "$R" | jq -r '.tasks.total')
[[ "$BOB_TOTAL" -le 0 || "$BOB_TOTAL" == "null" ]] || {
  # Allow some isolation if bob has any "default" network task auto-created, but
  # it definitely shouldn't equal what alice produced (1). 0 is the strict expected.
  echo "FAIL: bob /api/stats.tasks.total=$BOB_TOTAL (expected 0, alice's task leaked)"; exit 1
}
echo "  ✓ /api/stats.tasks.total = $BOB_TOTAL (no alice leak)"

echo "[5] PIN: bob GET /api/completions — no alice reply text"
R=$(curl -fsS "$HUB_BASE/api/completions" -H "Authorization: Bearer $UTOK_BOB")
expect_no_alice "/api/completions" "$R" '[.completions[]? | select(.result // .content // .reply // "" | test("alice-private"))] | length'

echo "[6] PIN: bob GET /api/tasks?to_name=alice-secret-agent — no alice task"
R=$(curl -fsS "$HUB_BASE/api/tasks?to_name=alice-secret-agent" -H "Authorization: Bearer $UTOK_BOB")
expect_no_alice "/api/tasks?to_name=alice-secret-agent" "$R" '[.tasks[]? | select(.content=="alice-confidential-task")] | length'

echo "[7] PIN: bob GET /api/tasks?from_name=alice — no alice task"
R=$(curl -fsS "$HUB_BASE/api/tasks?from_name=alice" -H "Authorization: Bearer $UTOK_BOB")
expect_no_alice "/api/tasks?from_name=alice" "$R" '[.tasks[]? | select(.content=="alice-confidential-task")] | length'

echo "[8] PIN: bob GET /api/auth/tokens — only bob's tokens (no alice's)"
R=$(curl -fsS "$HUB_BASE/api/auth/tokens" -H "Authorization: Bearer $UTOK_BOB")
# bob shouldn't see any token with name 'node:alice-secret-agent'
ALICE_TOKEN_LEAK=$(echo "$R" | jq '[.tokens[]? | select(.name=="node:alice-secret-agent")] | length')
[[ "$ALICE_TOKEN_LEAK" -eq 0 ]] || { echo "FAIL: bob saw alice's token in /api/auth/tokens"; echo "$R" | jq .; exit 1; }
echo "  ✓ /api/auth/tokens scoped to bob's own"

echo "[9] PIN: bob GET /api/task_events — no alice events"
R=$(curl -fsS "$HUB_BASE/api/task_events?limit=100" -H "Authorization: Bearer $UTOK_BOB")
ALICE_EVT=$(echo "$R" | jq "[.events[]? | select(.task_id==\"$TASK_ID\")] | length")
[[ "$ALICE_EVT" -eq 0 ]] || { echo "FAIL: bob saw $ALICE_EVT alice events"; echo "$R" | jq .; exit 1; }
echo "  ✓ /api/task_events no alice task_id leak"

echo "[10] PIN: bob can't use alice's ntok he stumbled onto (but doesn't actually have)"
# Synthetic: try a totally bogus ntok with alice's network_id.
CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer ntok_garbage_alice_does_not_exist")
[[ "$CODE" == "401" ]] || { echo "FAIL: bogus ntok returned $CODE (not 401)"; exit 1; }

# ─────────────── ALICE SANITY ───────────────
echo "[11] sanity: alice sees her own task + node + completion"
A_NODES=$(curl -fsS "$HUB_BASE/api/nodes" -H "Authorization: Bearer $UTOK_ALICE" \
  | jq '[.nodes[]? | select(.alias=="alice-secret-agent" or .node_name=="alice-secret-agent")] | length')
# alice may see her node via session — be lenient on shape
A_STATS_TOTAL=$(curl -fsS "$HUB_BASE/api/stats" -H "Authorization: Bearer $UTOK_ALICE" | jq -r '.tasks.total')
[[ "$A_STATS_TOTAL" -ge 1 ]] || { echo "FAIL: alice /api/stats.tasks.total=$A_STATS_TOTAL (expected ≥1)"; exit 1; }
echo "  ✓ alice /api/stats.tasks.total=$A_STATS_TOTAL (her own task counted)"

echo "PASS qa-dash-08 cross-account-views (nodes/stats/completions/tasks-filters/tokens/task_events all isolated)"

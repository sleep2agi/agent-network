#!/usr/bin/env bash
# qa-hub-06b-cross-user-isolation — utok 跨用户 IDOR 边界
# 用户故事：alice 和 bob 是两个独立用户。alice 有 private network + tasks。
#   bob 拿自己的 utok：
#     - GET /api/networks 不能看到 alice 的 network
#     - GET /api/tasks 不能看到 alice 的 task
#     - GET /api/status 不能看到 alice 的 agent
#     - GET /api/messages 不能含 alice 的内容
#     - 直接 POST /api/task 到 alice 的 agent → 403/拒
#
# R5 (HUB-06) 测的是 token 撤销。R17 补**跨用户数据隔离** —— OWASP IDOR class。
set -euo pipefail
# 绑了还要看得见（#1092）：报告里没有这一行，就没法把这次运行钉到某个提交上。
printf 'source_commit=%s\n' "${SOURCE_COMMIT:-unknown}"

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

# Wait for hub to fully boot
sleep 1

echo "[1] register alice + bob, get UTOK_ALICE + UTOK_BOB"
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
[[ "$UTOK_ALICE" == utok_* ]] || { echo "FAIL: alice login"; exit 1; }
[[ "$UTOK_BOB" == utok_* ]] || { echo "FAIL: bob login"; exit 1; }

echo "[2] alice creates 'alice-private' network + 'alice-agent' ntok + report_status"
ALICE_NET_RESP=$(curl -fsS -X POST "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer $UTOK_ALICE" -H 'Content-Type: application/json' \
  -d '{"name":"alice-private"}')
ALICE_NET=$(echo "$ALICE_NET_RESP" | jq -r '.network.network_id // .network_id // empty')
[[ -n "$ALICE_NET" ]] || { echo "FAIL: alice net id"; exit 1; }
ALICE_NTOK=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK_ALICE" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$ALICE_NET\",\"node_name\":\"alice-agent\"}" | jq -r '.token')
ARG=$(jq -nc --arg net "$ALICE_NET" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-00000000a17a",alias:"alice-agent",status:"idle",network_id:$net}')
mcp_call "$ALICE_NTOK" "report_status" "$ARG" | jq -e '.ok == true' >/dev/null \
  || { echo "FAIL: alice report_status"; exit 1; }

echo "[3] alice sends a 'top-secret-alice' task to alice-agent"
ARG=$(jq -nc --arg a "alice-agent" --arg t "top-secret-alice-payload" --arg net "$ALICE_NET" \
  '{alias:$a,task:$t,priority:"normal",network_id:$net,from_session:"alice-agent"}')
mcp_call "$ALICE_NTOK" "send_task" "$ARG" | jq -e '.message_id' >/dev/null \
  || { echo "FAIL: alice send_task"; exit 1; }

# ─────────────── BOB's POV ───────────────
echo "[4] PIN: bob's /api/networks does NOT include alice-private"
BOB_NETS=$(curl -fsS "$HUB_BASE/api/networks" -H "Authorization: Bearer $UTOK_BOB" \
  | jq '[.networks[] | select(.network_name=="alice-private")] | length')
[[ "$BOB_NETS" -eq 0 ]] || { echo "FAIL: bob saw alice-private in /api/networks"; exit 1; }

echo "[5] PIN: bob's /api/tasks (no network_id filter) does NOT include alice's task"
BOB_TASKS=$(curl -fsS "$HUB_BASE/api/tasks" -H "Authorization: Bearer $UTOK_BOB" \
  | jq '[.tasks[] | select(.content=="top-secret-alice-payload")] | length')
[[ "$BOB_TASKS" -eq 0 ]] || { echo "FAIL: bob saw alice's task content"; exit 1; }

echo "[6] PIN: bob's /api/status does NOT include alice-agent session"
BOB_SESS=$(curl -fsS "$HUB_BASE/api/status" -H "Authorization: Bearer $UTOK_BOB" \
  | jq '[.sessions[] | select(.alias=="alice-agent")] | length')
[[ "$BOB_SESS" -eq 0 ]] || { echo "FAIL: bob saw alice-agent in /api/status"; exit 1; }

echo "[7] PIN: bob's /api/messages does NOT contain alice's secret"
BOB_MSGS=$(curl -fsS "$HUB_BASE/api/messages?limit=100" -H "Authorization: Bearer $UTOK_BOB" \
  | jq '[.messages[] | select(.content | test("top-secret-alice"))] | length')
[[ "$BOB_MSGS" -eq 0 ]] || { echo "FAIL: bob saw alice's task in /api/messages"; exit 1; }

echo "[8] PIN: bob DIRECT IDOR — query alice's network_id explicitly"
# Even if bob guesses/knows alice's network_id, /api/tasks?network_id= must scope
BOB_DIRECT=$(curl -s -w '\nHTTP_CODE:%{http_code}' \
  "$HUB_BASE/api/tasks?network_id=$ALICE_NET" -H "Authorization: Bearer $UTOK_BOB")
CODE=$(echo "$BOB_DIRECT" | sed -n 's/^HTTP_CODE://p')
BODY=$(echo "$BOB_DIRECT" | grep -v '^HTTP_CODE:')
# Either 403 or empty result — both are acceptable security postures.
# Just NOT alice's task content visible to bob.
if echo "$BODY" | jq -e '.tasks[] | select(.content=="top-secret-alice-payload")' >/dev/null 2>&1; then
  echo "FAIL: bob can read alice's task by guessing network_id (HTTP $CODE)"; exit 1
fi
echo "  ✓ bob can't read alice's tasks via direct network_id IDOR (HTTP $CODE, no leak)"

echo "[9] PIN: bob CANNOT POST /api/task to alice-agent"
BOB_SEND=$(curl -s -o /tmp/bsend.json -w '%{http_code}' \
  -X POST "$HUB_BASE/api/task" \
  -H "Authorization: Bearer $UTOK_BOB" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"alice-agent\",\"task\":\"injection-attempt\",\"priority\":\"normal\",\"network_id\":\"$ALICE_NET\"}")
# Expect 403 permission_denied (or 400) — anything that DOESN'T deliver the task.
if [[ "$BOB_SEND" == "200" ]]; then
  # If 200 returned, verify the task did NOT actually land in alice's inbox
  if curl -fsS "$HUB_BASE/api/tasks?to_name=alice-agent&network_id=$ALICE_NET" \
       -H "Authorization: Bearer $UTOK_ALICE" \
       | jq -e '.tasks[] | select(.content=="injection-attempt")' >/dev/null 2>&1; then
    echo "FAIL: bob injected a task to alice's agent (HTTP 200)"; cat /tmp/bsend.json; exit 1
  fi
fi
[[ "$BOB_SEND" == "403" || "$BOB_SEND" == "400" || "$BOB_SEND" == "200" ]] || \
  { echo "FAIL: unexpected HTTP $BOB_SEND"; exit 1; }
echo "  ✓ bob's cross-tenant send returned HTTP $BOB_SEND, no task injected"

echo "[10] PIN: bob CANNOT mint ntok for alice's network"
BOB_MINT_CODE=$(curl -s -o /tmp/bmint.json -w '%{http_code}' \
  -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK_BOB" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$ALICE_NET\",\"node_name\":\"hostile\"}")
# Expect 403 or {ok:false} body
if [[ "$BOB_MINT_CODE" == "200" ]]; then
  if jq -e '.ok == true' /tmp/bmint.json >/dev/null 2>&1; then
    echo "FAIL: bob minted ntok for alice's network!"; cat /tmp/bmint.json; exit 1
  fi
fi
echo "  ✓ bob's mint-on-alice-network rejected (HTTP $BOB_MINT_CODE)"

# ─────────────── ALICE's POV sanity ───────────────
echo "[11] sanity: alice still sees her own network + task"
ALICE_OWN=$(curl -fsS "$HUB_BASE/api/networks" -H "Authorization: Bearer $UTOK_ALICE" \
  | jq '[.networks[] | select(.network_name=="alice-private")] | length')
[[ "$ALICE_OWN" -ge 1 ]] || { echo "FAIL: alice lost her own network"; exit 1; }
ALICE_OWN_TASK=$(curl -fsS "$HUB_BASE/api/tasks?network_id=$ALICE_NET" \
  -H "Authorization: Bearer $UTOK_ALICE" \
  | jq '[.tasks[] | select(.content=="top-secret-alice-payload")] | length')
[[ "$ALICE_OWN_TASK" -ge 1 ]] || { echo "FAIL: alice lost her own task"; exit 1; }

echo "PASS qa-hub-06b cross-user-isolation (networks/tasks/status/messages/IDOR/inject/mint all isolated)"

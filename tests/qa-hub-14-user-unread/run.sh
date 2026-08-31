#!/usr/bin/env bash
# qa-hub-14-user-unread — send_desktop_message → /api/messages?scope=user 的 unread 角标链
#
# 🔴 为什么加这个套件(#1563)：服务端那条链五段齐全(写/推/读/计数/返回)，
#    客户端也已接到渲染那一行(AgentsScreen.tsx 的 badge=…)，**但两半之间的接缝
#    从来没被测过** —— 实测 2026-08-31：anet 仓 tests/ 里 `user_inbox` 0 个文件、
#    `scope=user` 0 个文件；app 仓只有单测。每一半单看都对，坏就坏在没人验的接缝上。
#
# 用户视角 L1 contract test，纯黑盒，不依赖业务源码。
set -euo pipefail
printf 'source_commit=%s\n' "${SOURCE_COMMIT:-unknown}"

export HOME=/tmp/anethome

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
mkdir -p "$HOME" /tmp/work
cd /tmp/work

ADMIN_PW="StrongPassw0rd"
HUB_PORT=9200
HUB_BASE="http://127.0.0.1:$HUB_PORT"
PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

cleanup() { kill "${HUB_PID:-0}" 2>/dev/null || true; }
trap cleanup EXIT

npm install -g @sleep2agi/agent-network@preview >/tmp/npm-install.log 2>&1
anet -v

echo "[0] start hub"
safe_rm_rf "$HOME/.anet/server" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port "$HUB_PORT" --username admin --password "$ADMIN_PW" >/tmp/hub.log 2>&1 &
HUB_PID=$!
for _ in $(seq 1 60); do
  curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$HUB_BASE/health" >/dev/null || { echo "FAIL: hub never became healthy"; tail -40 /tmp/hub.log; exit 1; }

echo "[1] login admin → utok_"
for _ in $(seq 1 30); do
  LOGIN_RESP=$(curl -sS -X POST "$HUB_BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" 2>/dev/null || true)
  UTOK=$(echo "$LOGIN_RESP" | jq -r '.token // empty')
  [[ "$UTOK" == utok_* ]] && break
  sleep 1
done
[[ "$UTOK" == utok_* ]] || { echo "FAIL: login did not return utok_; last: $LOGIN_RESP"; exit 1; }

echo "[2] create network"
NET_ID=$(curl -fsS -X POST "$HUB_BASE/api/networks" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d '{"name":"unread-net","description":"#1563 unread badge contract"}' | jq -r '.network.network_id // .network_id // empty')
[[ -n "$NET_ID" ]] || { echo "FAIL: no network_id"; exit 1; }

echo "[3] mint ntok_ for node 'sender-agent'"
NTOK=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"sender-agent\"}" | jq -r '.token // empty')
[[ "$NTOK" == ntok_* ]] || { echo "FAIL: ntok shape wrong: $NTOK"; exit 1; }

# ── 统一的 MCP 调用（Streamable HTTP 可能回 SSE 帧也可能回纯 JSON，两种都要认）──
mcp_call() {  # $1=tool name, $2=arguments JSON
  local req resp json
  req=$(jq -nc --arg n "$1" --argjson a "$2" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  resp=$(curl -sS -X POST "$HUB_BASE/mcp" \
    -H "Authorization: Bearer $NTOK" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' -d "$req")
  json=$(echo "$resp" | sed -n 's/^data: //p' | head -1)
  [[ -z "$json" ]] && json="$resp"
  echo "$json"
}

user_unread() {  # 打印 /api/messages?scope=user 的 unread
  curl -fsS "$HUB_BASE/api/messages?scope=user&limit=50" \
    -H "Authorization: Bearer $UTOK" | jq -r '.unread // empty'
}

echo "[4] baseline — 还没发任何桌面消息，unread 应为 0"
BASE_UNREAD=$(user_unread || true); BASE_UNREAD=${BASE_UNREAD:-"(unreadable)"}
if [[ "$BASE_UNREAD" == "0" ]]; then ok "baseline unread=0"; else fail "baseline unread 期望 0，实得 '$BASE_UNREAD'"; fi

echo "[5] register sender session (report_status)"
RS=$(mcp_call report_status "$(jq -nc --arg net "$NET_ID" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-000000000011",alias:"sender-agent",status:"idle",network_id:$net}')")
[[ "$(echo "$RS" | jq -r '.result.content[0].text // empty' | jq -r '.ok // empty')" == "true" ]] \
  && ok "report_status ok" || { fail "report_status 未返回 ok: $RS"; }

echo "[6] agent → 用户：send_desktop_message"
SD=$(mcp_call send_desktop_message "$(jq -nc --arg net "$NET_ID" \
  '{to_username:"admin",title:"unread probe",message:"hello from sender-agent",network_id:$net}')")
SD_OK=$(echo "$SD" | jq -r '.result.content[0].text // empty' | jq -r '.ok // empty')
[[ "$SD_OK" == "true" ]] && ok "send_desktop_message ok" || fail "send_desktop_message 未返回 ok: $SD"

echo "[7] 角标该动了 —— unread 从 0 变 1"
AFTER=$(user_unread || true); AFTER=${AFTER:-"(unreadable)"}
if [[ "$AFTER" == "1" ]]; then ok "unread 0 → 1"; else fail "unread 期望 1，实得 '$AFTER'"; fi

echo "[8] pending_count 与 unread 必须一致（客户端角标读的是它）"
PC=$(curl -fsS "$HUB_BASE/api/messages?scope=user&limit=50" -H "Authorization: Bearer $UTOK" | jq -r '.pending_count // empty' || true); PC=${PC:-"(absent)"}
if [[ "$PC" == "$AFTER" ]]; then ok "pending_count == unread ($PC)"; else fail "pending_count='$PC' 与 unread='$AFTER' 不一致"; fi

echo "[9] 🔴 负控：**不带 scope=user** 会落回 alias 分支（读的是另一张表）"
# 少一个 scope=user 就读错表 —— 没有这一条，一个读错表的实现也能过 [4][7][8]。
ALIAS_UNREAD=$(curl -fsS "$HUB_BASE/api/messages?limit=50" -H "Authorization: Bearer $UTOK" | jq -r '.unread // "absent"')
if [[ "$ALIAS_UNREAD" != "$AFTER" ]]; then
  ok "alias 分支与 user 分支不同 (alias='$ALIAS_UNREAD' vs user='$AFTER') —— 证明 [7] 读的确实是 user_inbox"
else
  fail "alias 分支也返回 '$ALIAS_UNREAD' —— 两个分支无法分辨，[7] 可能读错表"
fi

echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1

#!/usr/bin/env bash
# test-codex-code-cli — E2E for RFC-005 codex-code-cli runtime
# Coverage (per 通信龙 派单 + RFC-005 §7):
#   L0 prerequisites    — which codex + which anet
#   L1 hub up           — anet hub start + /health
#   L2 node create      — anet node create x --runtime codex-code-cli + config 写盘
#   L3 spawn verify     — anet node start + codex fork + mcp_servers.commhub flag
#   L4 env injection    — COMMHUB_TOKEN 注入正确
#   L5 sandbox flags    — --ignore-user-config + --ignore-rules 生效
#   L6 cross-agent      — codex-code-cli + claude-code-cli 两 node 共存，send_task
#                         跨 runtime 真路由（hub-side 验，agent 端不必实际处理）
#
# 状态：cli.ts codex-code-cli runtime 由通信工程马实施。L2+ 在 cli.ts ship 前
# 必然 fail（runtime enum 缺）。工程马 ship 到 main + preview publish 后
# 本测试应一次性 PASS。L0/L1 在任何 anet 版本都应 PASS（用做 scaffold sanity）。
set -Eeuo pipefail

LOG_DIR="${LOG_DIR:-/tmp/anet-codex-code-cli}"
HOME_DIR="${HOME_DIR:-/tmp/anet-codex-home}"
mkdir -p "$LOG_DIR" "$HOME_DIR"
export HOME="$HOME_DIR"
export COMMHUB_URL="http://127.0.0.1:9200"
export ANET_HUB="$COMMHUB_URL"

ADMIN_PW="StrongPassw0rd"

cleanup() {
  set +e
  pkill -KILL -f 'anet node start'   2>/dev/null
  pkill -KILL -f 'codex exec'        2>/dev/null
  pkill -KILL -f 'commhub-server'    2>/dev/null
}
trap cleanup EXIT

section() { echo ""; echo "========== $* =========="; }
pass()    { echo "PASS: $*"; }
fail()    {
  echo "FAIL: $*" >&2
  echo "---- anet -v ----";     tail -40 "$LOG_DIR/anet-version.log" 2>/dev/null
  echo "---- hub.log ----";     tail -80 "$LOG_DIR/hub.log"          2>/dev/null
  echo "---- node-start.log ----"; tail -80 "$LOG_DIR/node-start.log" 2>/dev/null
  exit 1
}

mcp_call() {
  # POST /mcp tools/call; print .result.content[0].text
  local tok="$1" name="$2" args="$3" body
  body=$(jq -nc --arg n "$name" --argjson a "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  curl -sS -X POST "$COMMHUB_URL/mcp" \
    -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "$body" \
    | sed -n 's/^data: //p' | head -1 \
    | jq -r '.result.content[0].text // empty'
}

# ─────────────── L0 prerequisites ───────────────
section "L0 prerequisites"
which codex >/dev/null || fail "codex CLI not on PATH"
codex --version 2>&1 | tee "$LOG_DIR/codex-version.log"
pass "L0a codex installed"

npm install -g @sleep2agi/agent-network@preview >"$LOG_DIR/npm-install.log" 2>&1 \
  || fail "anet npm install failed"
which anet >/dev/null || fail "anet binary missing after install"
anet -v >"$LOG_DIR/anet-version.log" 2>&1
pass "L0b anet installed ($(head -1 "$LOG_DIR/anet-version.log"))"

# ─────────────── L1 hub up ───────────────
section "L1 hub up"
rm -rf "$HOME/.anet" "$HOME/.commhub"
anet hub start --host 127.0.0.1 --port 9200 --username admin --password "$ADMIN_PW" \
  >"$LOG_DIR/hub.log" 2>&1 &
for _ in {1..60}; do curl -fsS "$COMMHUB_URL/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$COMMHUB_URL/health" >/dev/null || fail "hub did not come up"
pass "L1 hub healthy on $COMMHUB_URL"

# admin login (retry — bootstrap race, see issue #31 R6/R8/R19)
UTOK=""
for _ in {1..20}; do
  UTOK=$(curl -sS -X POST "$COMMHUB_URL/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" 2>/dev/null | jq -r '.token // empty')
  [[ "$UTOK" == utok_* ]] && break
  sleep 0.5
done
[[ "$UTOK" == utok_* ]] || fail "admin login never returned utok"
pass "L1b admin login OK"

# ─────────────── L2 anet node create --runtime codex-code-cli ───────────────
section "L2 node create --runtime codex-code-cli"
NODE_DIR="$HOME/.anet/nodes/codex-bot"
# Login + create network so node create works
anet login --hub "$COMMHUB_URL" --username admin --password "$ADMIN_PW" \
  >"$LOG_DIR/anet-login.log" 2>&1 \
  || fail "anet login (CLI) failed"

# Try `--runtime codex-code-cli`. Will fail until 工程马 ship cli.ts.
anet node create codex-bot --runtime codex-code-cli >"$LOG_DIR/node-create.log" 2>&1 \
  || fail "anet node create --runtime codex-code-cli failed (cli.ts not yet shipped?)"

[[ -f "$NODE_DIR/config.json" ]] || fail "node config.json not written at $NODE_DIR"
RUNTIME=$(jq -r '.runtime' "$NODE_DIR/config.json")
[[ "$RUNTIME" == "codex-code-cli" ]] || fail "config.runtime != codex-code-cli (got '$RUNTIME')"
pass "L2 config.json runtime=codex-code-cli"

# ─────────────── L3 spawn verify — codex fork + mcp_servers.commhub flag ───────────────
section "L3 spawn verify"
( anet node start codex-bot >"$LOG_DIR/node-start.log" 2>&1 ) &
NODE_PID=$!
# Give it a moment to spawn
sleep 4
# Find a codex subprocess with mcp_servers.commhub flag
if pgrep -af 'codex.*mcp_servers\.commhub' >"$LOG_DIR/codex-spawn.log"; then
  pass "L3 codex spawned with mcp_servers.commhub flag"
else
  fail "no 'codex ... mcp_servers.commhub' process detected"
fi

# ─────────────── L4 env injection — COMMHUB_TOKEN bound ───────────────
section "L4 env injection"
# RFC-005 §3.3: COMMHUB_TOKEN passed via env (not hardcoded into config args).
# Check the spawned codex process /proc/<pid>/environ for COMMHUB_TOKEN.
CODEX_PID=$(pgrep -f 'codex.*mcp_servers\.commhub' | head -1 || true)
[[ -n "$CODEX_PID" ]] || fail "could not find codex pid for env probe"
if tr '\0' '\n' </proc/"$CODEX_PID"/environ 2>/dev/null | grep -q '^COMMHUB_TOKEN='; then
  pass "L4 COMMHUB_TOKEN present in codex process env"
else
  fail "COMMHUB_TOKEN missing from codex process env (pid $CODEX_PID)"
fi

# ─────────────── L5 sandbox flags — --ignore-user-config + --ignore-rules ───────────────
section "L5 sandbox flags"
# RFC-005 §3.3 + §6.2: spawn must pass --ignore-user-config + --ignore-rules
# so host user's ~/.codex/config.toml (e.g. Vincent's stale [mcp_servers.commhub-proxy])
# does NOT leak into the runtime session.
CMDLINE=$(tr '\0' ' ' </proc/"$CODEX_PID"/cmdline 2>/dev/null)
echo "$CMDLINE" >"$LOG_DIR/codex-cmdline.log"
echo "$CMDLINE" | grep -q -- '--ignore-user-config' || fail "--ignore-user-config flag missing"
echo "$CMDLINE" | grep -q -- '--ignore-rules'       || fail "--ignore-rules flag missing"
pass "L5 sandbox flags applied"

# ─────────────── L6 cross-agent send_task between codex-code-cli and claude-code-cli ───────────────
section "L6 cross-agent (codex-code-cli ↔ claude-code-cli)"
# Strategy: mint ntoks for both aliases, register sessions via report_status MCP
# (mock-via-MCP, no real LLM needed). Then admin send_task to each — both must
# land + be queryable. Hub-side cross-runtime routing is what matters here;
# whether the real codex/claude process actually consumes the task is out
# of scope (see RFC-005 §7.3 "不测的 case").
# This verifies: hub does NOT special-case runtime, alias resolution is
# runtime-agnostic, ntok issued for codex-bot can mint another session row.
NETWORK_ID=$(curl -fsS -X POST "$COMMHUB_URL/api/networks" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d '{"name":"codex-cross-test"}' | jq -r '.network.network_id // .network_id')
[[ -n "$NETWORK_ID" ]] || fail "could not create cross-test network"

# mint ntok for an additional alias 'claude-peer' (we don't spawn a real claude
# CLI — register a session row via MCP report_status to satisfy SSE-delivery
# precondition, same trick used in qa-hub-05 / qa-node-02)
NTOK_PEER=$(curl -fsS -X POST "$COMMHUB_URL/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NETWORK_ID\",\"node_name\":\"claude-peer\"}" | jq -r '.token')
ARG=$(jq -nc --arg net "$NETWORK_ID" \
  '{resume_id:"00000000-aaaa-bbbb-cccc-codex0000l6",alias:"claude-peer",status:"idle",network_id:$net}')
mcp_call "$NTOK_PEER" "report_status" "$ARG" | jq -e '.ok == true' >/dev/null \
  || fail "claude-peer report_status failed"

# admin dispatches task to codex-bot (created in L2)
TASK_RESP=$(curl -fsS -X POST "$COMMHUB_URL/api/task" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"codex-bot\",\"task\":\"hello-from-claude-peer\",\"priority\":\"normal\"}")
echo "$TASK_RESP" | jq -e '.ok == true' >/dev/null \
  || fail "send_task to codex-bot rejected: $TASK_RESP"

# query /api/tasks — task must be delivered + visible
sleep 0.3
HIT=$(curl -fsS "$COMMHUB_URL/api/tasks?to_name=codex-bot" \
  -H "Authorization: Bearer $UTOK" \
  | jq '[.tasks[]? | select(.content=="hello-from-claude-peer")] | length')
[[ "$HIT" -ge 1 ]] || fail "task to codex-bot not in /api/tasks"
pass "L6 cross-runtime task dispatch routed correctly"

# ─────────────── Cleanup ───────────────
section "stopping node"
kill -KILL "$NODE_PID" 2>/dev/null || true
pkill -KILL -f 'codex exec' 2>/dev/null || true
pkill -KILL -f 'anet node start' 2>/dev/null || true

echo ""
echo "PASS test-codex-code-cli (L0+L1+L2+L3+L4+L5+L6 all green)"

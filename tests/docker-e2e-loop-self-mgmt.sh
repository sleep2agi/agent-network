#!/bin/bash
# RFC-025 M4 — agent loop self-management e2e (Docker isolated).
#
# Verifies 通信龙's hard verification line: agent真节点 batch-cancel
# 真触发 confirm-back + cooldown 真挡 + multi-loop 指代消解 + cron-lite
# 三模式 + preflight self-lock prevention. Across all 3 in-scope runtimes
# (claude-agent-sdk / codex-sdk / grok-build-acp).
#
# **Critical isolation** (通信龙 红线):
#   - COMMHUB_DB=/tmp/commhub-loop-m4-$$.db (per-run isolated)
#   - test hub on :9220 (NOT 9200, NOT prod 47.x)
#   - never connects to production hub
#   - safe_rm_rf for all workdir cleanup
#
# What we DO assert: tool-call layer behaviour + parent goalStore state
#   (cooldown/confirm-token/preflight all enforced WITHOUT real LLM fire)
#
# What we deliberately DON'T assert: SDK actually completing LLM-driven
#   task execution after a wake. LLM真 fire 留 M5 single demo run
#   (省 Vincent's "无 Max 军团" token budget).

set -e

SAFE_RM_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/safe-rm.sh"
if [ -f "$SAFE_RM_LIB" ]; then
  source "$SAFE_RM_LIB"
else
  for cand in /app/tests/lib/safe-rm.sh /app/lib/safe-rm.sh; do
    [ -f "$cand" ] && source "$cand" && break
  done
fi
type safe_rm_rf > /dev/null 2>&1 || {
  echo "FATAL: safe-rm.sh not found"
  exit 99
}

PASS=0
FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
section() { echo ""; echo "━━━ $1 ━━━"; }

# ────────────────────────────────────────────────────────────────
# Harness skeleton (per 通信龙 spot-check checkpoint)
# ────────────────────────────────────────────────────────────────

# Isolated test hub — distinct port from #144's 9210 to avoid
# collision when both suites run.
HUB_PORT=9220
HUB_DB="/tmp/commhub-loop-m4-$$.db"

start_isolated_hub() {
  echo "Starting isolated commhub on :$HUB_PORT (DB=$HUB_DB)..."
  safe_rm_rf "$HUB_DB" "${HUB_DB}-wal" "${HUB_DB}-shm" 2>/dev/null || rm -f "$HUB_DB" "${HUB_DB}-wal" "${HUB_DB}-shm" 2>/dev/null
  COMMHUB_DB="$HUB_DB" PORT="$HUB_PORT" \
    bun run /app/server/src/index.ts > /tmp/m4-hub.log 2>&1 &
  HUB_PID=$!
  for i in 1 2 3 4 5; do
    sleep 1
    if curl -sf "http://127.0.0.1:$HUB_PORT/health" > /dev/null 2>&1; then
      pass "test hub :$HUB_PORT ready (PID=$HUB_PID, isolated DB)"
      return 0
    fi
  done
  fail "test hub :$HUB_PORT failed to start"
  cat /tmp/m4-hub.log | tail -20
  exit 1
}

register_test_user() {
  # Returns user_token + network_token to caller via globals.
  local resp
  resp=$(curl -s -X POST "http://127.0.0.1:$HUB_PORT/api/auth/register" \
    -H "Content-Type: application/json" \
    -d '{"username":"m4-tester","password":"M4TestPw123","display_name":"M4 Tester"}')
  USER_TOKEN=$(echo "$resp" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('token',''))")
  NET_TOKEN=$(echo "$resp" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('network_token',''))")
  NET_ID=$(echo "$resp" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('network_id',''))")
  if [ -z "$NET_TOKEN" ]; then
    fail "user register failed: $resp"
    exit 1
  fi
  pass "registered test user (net=${NET_ID:0:12})"
}

# Per-runtime workdir setup. Writes config.json with the given
# runtime + auth token, returns workdir path via stdout.
make_node_workdir() {
  local alias="$1"
  local runtime="$2"
  local workdir="/tmp/m4-${alias}-$$"
  safe_rm_rf "$workdir"
  mkdir -p "$workdir/.anet/nodes/$alias"
  cat > "$workdir/.anet/nodes/$alias/config.json" <<EOF
{
  "alias": "$alias",
  "runtime": "$runtime",
  "hub": "http://127.0.0.1:$HUB_PORT",
  "token": "$NET_TOKEN",
  "network_id": "$NET_ID",
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": true,
    "goalTickMs": "5000",
    "timezone": "Asia/Shanghai"
  }
}
EOF
  echo "$workdir"
}

# Start an agent-node in the background and wait for it to register.
# Bogus API key — we don't need LLM fire for M4 tool-layer checks.
start_node() {
  local alias="$1"
  local runtime="$2"
  local workdir="$3"
  local logfile="/tmp/m4-${alias}.log"
  > "$logfile"
  case "$runtime" in
    claude-agent-sdk)
      ANTHROPIC_API_KEY="m4-bogus" \
        agent-node --alias "$alias" --config "$workdir/.anet/nodes/$alias/config.json" \
        > "$logfile" 2>&1 &
      ;;
    codex-sdk)
      OPENAI_API_KEY="m4-bogus" \
        agent-node --alias "$alias" --config "$workdir/.anet/nodes/$alias/config.json" \
        > "$logfile" 2>&1 &
      ;;
    grok-build-acp)
      XAI_API_KEY="m4-bogus" \
        agent-node --alias "$alias" --config "$workdir/.anet/nodes/$alias/config.json" \
        > "$logfile" 2>&1 &
      ;;
    *)
      fail "unknown runtime: $runtime"
      return 1
      ;;
  esac
  local pid=$!
  echo "$pid" > "/tmp/m4-${alias}.pid"
  # Wait up to 20s for "已注册到 CommHub" / "registered"
  for i in $(seq 1 20); do
    if grep -q "已注册到 CommHub\|registered" "$logfile" 2>/dev/null; then
      pass "node $alias ($runtime) registered (PID=$pid)"
      return 0
    fi
    sleep 1
  done
  fail "node $alias ($runtime) failed to register within 20s"
  tail -30 "$logfile"
  return 1
}

stop_node() {
  local alias="$1"
  local pidfile="/tmp/m4-${alias}.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile")
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  fi
}

# Direct tool invocation against parent agent-node — uses the
# already-running localhost loops HTTP server inside the agent-node
# process. The LOOPS_MCP_URL + LOOPS_MCP_TOKEN are stamped into the
# log by startLoopsHttpServer. For claude runtime we don't have an
# HTTP server (uses in-process SDK MCP) so this helper supports
# codex/grok only.
loops_url_for() {
  local logfile="/tmp/m4-${1}.log"
  grep -oE "http://127.0.0.1:[0-9]+/mcp" "$logfile" | head -1
}

loops_token_for() {
  # Token is process.env.LOOPS_MCP_TOKEN — not logged for security.
  # For M4 we need access. Read it from /proc/<pid>/environ.
  local alias="$1"
  local pidfile="/tmp/m4-${alias}.pid"
  if [ ! -f "$pidfile" ]; then
    echo ""
    return
  fi
  local pid
  pid=$(cat "$pidfile")
  if [ -f "/proc/$pid/environ" ]; then
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep "^LOOPS_MCP_TOKEN=" | cut -d= -f2-
  fi
}

call_loop_tool() {
  local alias="$1"
  local tool="$2"
  local args_json="$3"
  local url
  local token
  url=$(loops_url_for "$alias")
  token=$(loops_token_for "$alias")
  if [ -z "$url" ] || [ -z "$token" ]; then
    echo '{"error":"loops HTTP server not started for this runtime"}'
    return 1
  fi
  curl -s -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $token" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args_json}}"
}

# Read goals.json directly for state assertions.
read_goals_json() {
  local workdir="$1"
  local alias="$2"
  local file="$workdir/.anet/nodes/$alias/goals.json"
  if [ -f "$file" ]; then
    cat "$file"
  else
    echo '{"version":1,"goals":[]}'
  fi
}

cleanup() {
  echo ""
  echo "Cleanup..."
  for alias in loop-claude loop-codex loop-grok; do
    stop_node "$alias" 2>/dev/null
  done
  if [ -n "$HUB_PID" ]; then
    kill "$HUB_PID" 2>/dev/null || true
    wait "$HUB_PID" 2>/dev/null || true
  fi
  safe_rm_rf "$HUB_DB" "${HUB_DB}-wal" "${HUB_DB}-shm" 2>/dev/null || true
}
trap cleanup EXIT

# ────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────

echo ""
echo "=================================================="
echo "  RFC-025 M4 — agent loop self-mgmt e2e matrix"
echo "  isolated hub :$HUB_PORT (DB=$HUB_DB) — NOT prod"
echo "=================================================="

section "Hub + Test User"
start_isolated_hub
register_test_user

# M4 harness skeleton STOPS here for 通信龙 spot-check. After harness
# wiring is ack'd, the 5 test groups (batch-cancel / cooldown /
# multi-loop reference / cron-lite 三模式 / preflight self-lock)
# get layered in × 3 runtimes.
#
# Per-runtime check sketch (to be filled after harness ack):
#   for runtime in claude-agent-sdk codex-sdk grok-build-acp; do
#     alias="loop-${runtime%%-*}"
#     workdir=$(make_node_workdir "$alias" "$runtime")
#     start_node "$alias" "$runtime" "$workdir"
#     run_batch_cancel_test "$alias" "$workdir" "$runtime"
#     run_cooldown_test "$alias" "$workdir" "$runtime"
#     run_multi_loop_ref_test "$alias" "$workdir" "$runtime"
#     run_cron_lite_three_modes_test "$alias" "$workdir" "$runtime"
#     run_preflight_self_lock_test "$alias" "$workdir" "$runtime"
#     stop_node "$alias"
#   done

section "Harness skeleton smoke (claude-agent-sdk only — 通信龙 spot-check checkpoint)"
ALIAS_C="loop-claude"
WORKDIR_C=$(make_node_workdir "$ALIAS_C" "claude-agent-sdk")
start_node "$ALIAS_C" "claude-agent-sdk" "$WORKDIR_C"

# Quickest sanity: goals.json starts empty, then we use commhub to
# send a /loop slash command (existing inbox path) and verify it
# lands in goals.json. Validates the e2e plumbing without LLM fire.
GOAL_COUNT_BEFORE=$(read_goals_json "$WORKDIR_C" "$ALIAS_C" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d.get('goals',[])))")
if [ "$GOAL_COUNT_BEFORE" = "0" ]; then
  pass "goals.json starts empty (clean node)"
else
  fail "goals.json should start empty, got $GOAL_COUNT_BEFORE"
fi

# Send a /loop via commhub directly (mirrors what the agent's own
# tools / CLI / inbox would do). Validates the harness can drive
# goal creation end-to-end via the public API.
RESP=$(curl -s -X POST "http://127.0.0.1:$HUB_PORT/api/task" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NET_TOKEN" \
  -d "{\"alias\":\"$ALIAS_C\",\"task\":\"/loop 5m m4 harness smoke task\",\"priority\":\"normal\",\"from\":\"m4-harness\",\"network_id\":\"$NET_ID\"}")
if echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('ok',False))" 2>/dev/null | grep -q "True"; then
  pass "harness can POST /loop slash command to test hub"
else
  fail "POST /api/task failed: $RESP"
fi

# Wait for node inbox to process + write goals.json
for i in 1 2 3 4 5; do
  sleep 1
  GOAL_COUNT=$(read_goals_json "$WORKDIR_C" "$ALIAS_C" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len([g for g in d.get('goals',[]) if g.get('status')=='active']))" 2>/dev/null || echo "0")
  if [ "$GOAL_COUNT" -ge 1 ]; then
    break
  fi
done

if [ "$GOAL_COUNT" -ge 1 ]; then
  pass "goal landed in goals.json via inbox path (harness can verify state)"
else
  fail "goal did not land within 5s (harness state-verify path broken)"
  echo "--- agent log tail ---"
  tail -30 "/tmp/m4-${ALIAS_C}.log"
fi

stop_node "$ALIAS_C"

echo ""
echo "=================================================="
echo "  Harness skeleton summary: $PASS pass, $FAIL fail"
echo "=================================================="
echo "Results: $PASS passed, $FAIL failed"

if [ $FAIL -eq 0 ]; then
  echo ""
  echo "🟡 Harness skeleton green — awaiting 通信龙 spot-check"
  echo "   before layering 5 test groups × 3 runtimes."
  exit 0
else
  exit 1
fi

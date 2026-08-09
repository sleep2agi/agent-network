#!/bin/bash
# #144 round-6 — loop runtime gate end-to-end verification.
#
# Hard requirement from 通信龙: prove that after removing the claude
# bucket skip, the scheduler ACTUALLY FIRES for claude-agent-sdk (the
# runtime Vincent will personally test). Also light-touch confirm for
# codex-sdk that startup-enables the scheduler.
#
# This test does NOT need a real Anthropic / OpenAI API key. We assert
# the SCHEDULER FIRES (anet's responsibility) — not that the LLM call
# inside the wake succeeds (vendor responsibility, out of scope).
#
# Pass criteria per runtime:
#   1. Startup log shows `goals scheduler: enabled (runtime=<bucket>)`
#   2. Within 30s a `[goal] wake <id>:` line appears for the pre-injected
#      goal (proves the tick fires AND finds the goal AND begins
#      processing it).
#
# What's deliberately NOT asserted:
#   - That the LLM SDK call inside processTask succeeds (needs vendor
#     auth + network; would re-introduce flakiness the test should
#     avoid). The wake log fires BEFORE the SDK call.

set -e

# Safe-rm guardrail per the 2026-06-16 incident — refuses to `rm -rf`
# anything outside /tmp/*. Drop-in `safe_rm_rf` replaces every bare
# `rm -rf "$VAR"` in this script. lint guard enforces this on PR.
SAFE_RM_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/safe-rm.sh"
if [ -f "$SAFE_RM_LIB" ]; then
  source "$SAFE_RM_LIB"
else
  # Fallback for Docker runs where the script is mounted standalone
  # (the lib lives at /app/tests/lib/ when copied via Dockerfile).
  for cand in /app/tests/lib/safe-rm.sh /app/lib/safe-rm.sh; do
    [ -f "$cand" ] && source "$cand" && break
  done
fi
type safe_rm_rf > /dev/null 2>&1 || {
  echo "FATAL: safe-rm.sh not found — refusing to run with bare rm -rf"
  exit 99
}
source /app/lib/e2e-agent-bootstrap.sh

PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  #144 — Loop runtime gate E2E"
echo "  Proves: scheduler fires for claude-agent-sdk + codex-sdk"
echo "========================================="
echo ""

# 1. Start hub on isolated DB (COMMHUB_DB to /tmp/commhub-loop-test.db)
echo "1. Starting CommHub (isolated DB)..."
rm -f /tmp/commhub-loop-test.db /tmp/commhub-loop-test.db-wal /tmp/commhub-loop-test.db-shm
COMMHUB_DB=/tmp/commhub-loop-test.db PORT=9210 \
  bun run /app/server/src/index.ts > /tmp/hub.log 2>&1 &
HUB_PID=$!
sleep 3
curl -s http://127.0.0.1:9210/health | grep -q '"ok":true' \
  && pass "CommHub started on :9210" \
  || { fail "CommHub failed to start"; cat /tmp/hub.log | tail -30; exit 1; }

# Register a test user + grab a network token. report_status MCP tool
# requires callerTokenIsNetwork (network-scoped token, not user token);
# without it every status report 401s and the agent crashes before the
# first scheduler tick.
echo "  Registering test user..."
REG=$(curl -s -X POST http://127.0.0.1:9210/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"loop-test","password":"LoopTestPw123","display_name":"loop test"}')
USER_TOKEN=$(echo "$REG" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('token',''))" 2>/dev/null)
NET_ID=$(echo "$REG" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('network_id',''))" 2>/dev/null)
[ -n "$USER_TOKEN" ] && [ -n "$NET_ID" ] && pass "test user registered (net=${NET_ID:0:12})" \
  || { fail "user registration failed: $REG"; exit 1; }

export HOME=/tmp/loop-test-home
safe_rm_rf "$HOME"
mkdir -p "$HOME"
anet login --hub http://127.0.0.1:9210 --username loop-test --password LoopTestPw123 >/dev/null
e2e_select_network "$NET_ID"

create_loop_agent_config() {
  local alias=$1 runtime=$2 model=$3 workdir=$4 flags=$5 config tmp
  safe_rm_rf "$workdir"
  mkdir -p "$workdir"
  cd "$workdir"
  e2e_create_agent "$alias" "$runtime" "$model" "$NET_ID"
  config=$(e2e_agent_config_path "$alias")
  tmp="${config}.tmp"
  jq --argjson flags "$flags" '.flags = $flags' "$config" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$config"
  e2e_config_token_bound_to_network "$config" "$NET_ID"
}

# 2. Test claude-agent-sdk runtime — the load-bearing one
#
# This test exercises the FULL user path:
#
#   1. Start the node (no pre-injected goals.json)
#   2. Run the real `anet node loop` CLI command (the one Vincent will type)
#   3. CLI emits `/loop 5m <task>` via /api/task
#   4. Node inbox handler routes through parser.parseGoalCommand
#   5. Goal lands in goals.json
#   6. Scheduler tick fires [goal] wake
#
# Previous e2e iteration wrote goals.json directly, bypassing the
# parser — that hid the silent-fail bug independent-reviewer caught
# on round 6 (`5m` was not in parser's word-only INTERVAL_PATTERNS).

echo ""
echo "2. claude-agent-sdk runtime — full CLI → parser → goal → wake fire..."

ALIAS_CLAUDE="loop-test-claude"
WORKDIR_CLAUDE="/tmp/loop-test-claude"
create_loop_agent_config "$ALIAS_CLAUDE" claude-agent-sdk claude-sonnet-4-6 "$WORKDIR_CLAUDE" \
  '{"dangerouslySkipPermissions":true,"teammateMode":true,"goalTickMs":"5000","goalAcceptSubMinute":true}'
# NOTE: the test uses interval `5m` which the parser enforces as
# 60_000 ms minimum. Real wake firing in 25s requires interval >= tick
# (default 30s, here 5s) AND >= MIN_INTERVAL (60s). To make the wake
# fire FAST without weakening MIN_INTERVAL in the parser, we register
# the goal via CLI with --every 5m (parser accepts) then BEFORE the
# first tick we hand-set next_wake_at into the past by editing
# goals.json. This proves: (a) CLI→parser→goal landed (real path),
# (b) the wake actually fires. We need NO mock for parser/CLI.

cd "$WORKDIR_CLAUDE"
# Bogus key — SDK call inside wake will fail at LLM layer; the wake
# log fires BEFORE that, which is what we assert.
ANTHROPIC_API_KEY="test-no-real-call" \
  timeout 60 agent-node \
  --alias "$ALIAS_CLAUDE" \
  --config "$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE/config.json" \
  > /tmp/claude-agent.log 2>&1 &
CLAUDE_PID=$!

# Wait for the node to register before sending the CLI command.
DEADLINE=$(($(date +%s) + 15))
SAW_ENABLE=0
SAW_REGISTERED=0
while [ $(date +%s) -lt $DEADLINE ]; do
  grep -q "goals scheduler: enabled (runtime=claude" /tmp/claude-agent.log && SAW_ENABLE=1
  grep -q "已注册到 CommHub" /tmp/claude-agent.log && SAW_REGISTERED=1
  if [ $SAW_ENABLE -eq 1 ] && [ $SAW_REGISTERED -eq 1 ]; then break; fi
  sleep 1
done

if [ $SAW_ENABLE -eq 1 ]; then
  pass "claude-agent-sdk: 'goals scheduler: enabled (runtime=claude...)' (gate removed ✓)"
else
  fail "claude-agent-sdk: scheduler NOT enabled — gate still blocking"
  tail -30 /tmp/claude-agent.log
  exit 1
fi

# Now run the REAL CLI command users will type. This exercises:
# CLI → /api/task → node inbox → parseGoalCommand → createScheduledGoal
# → goals.json upsert. The CLI itself polls for the node's reply so
# we get "node confirmed" or "node rejected" surfacing.
echo "  Running: anet node loop $ALIAS_CLAUDE \"e2e probe\" --every 5m"
# CLI reads --token / COMMHUB_TOKEN / loadGlobal().token. Use env so
# we don't need to write a config file.
COMMHUB_TOKEN="$USER_TOKEN" COMMHUB_URL="http://127.0.0.1:9210" \
  anet node loop "$ALIAS_CLAUDE" "e2e probe — please ack" --every 5m \
  > /tmp/cli-loop.log 2>&1 || true

if grep -q "✅ Scheduled loop" /tmp/cli-loop.log; then
  pass "anet node loop: CLI confirmed goal creation (real user path ✓)"
elif grep -q "❌ Node rejected" /tmp/cli-loop.log; then
  fail "anet node loop: node REJECTED the /loop (parser regression?)"
  cat /tmp/cli-loop.log
  exit 1
elif grep -q "did not confirm goal creation" /tmp/cli-loop.log; then
  fail "anet node loop: node did not reply within 15s (might be silent-fail or slow node)"
  cat /tmp/cli-loop.log
  echo "--- agent log tail ---"
  tail -30 /tmp/claude-agent.log
  exit 1
else
  fail "anet node loop: unexpected CLI output"
  cat /tmp/cli-loop.log
  exit 1
fi

# Verify the goal landed in goals.json (filesystem confirmation)
if [ -f "$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE/goals.json" ]; then
  GOAL_COUNT=$(python3 -c "import json;d=json.load(open('$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE/goals.json'));print(len([g for g in d.get('goals',[]) if g.get('status')=='active']))" 2>/dev/null)
  if [ "$GOAL_COUNT" -ge 1 ]; then
    pass "goals.json: $GOAL_COUNT active goal(s) persisted (parser → upsert path ✓)"
  else
    fail "goals.json: no active goals (CLI reported success but parser may have rejected)"
    cat "$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE/goals.json"
    exit 1
  fi
else
  fail "goals.json does not exist after CLI succeeded — silent-fail regression"
  exit 1
fi

# To observe a real fire within the test deadline, we restart the node
# after editing next_wake_at into the past. (The node holds goals in
# memory; an external file edit doesn't re-trigger load. Restart is a
# realistic user flow — nodes restart routinely, see scheduler picks
# up persisted past-due goals on next boot.)
GOAL_ID=$(python3 -c "import json;d=json.load(open('$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE/goals.json'));print(d['goals'][0]['goal_id'])")

# Stop the live node first
kill $CLAUDE_PID 2>/dev/null || true
wait $CLAUDE_PID 2>/dev/null || true

# Edit goals.json: next_wake_at into the past
python3 <<PY
import json, datetime
p = "$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE/goals.json"
d = json.load(open(p))
past = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
for g in d["goals"]:
    g["next_wake_at"] = past
json.dump(d, open(p, "w"))
PY

# Restart and watch for wake fire
> /tmp/claude-agent2.log
ANTHROPIC_API_KEY="test-no-real-call" \
  timeout 30 agent-node \
  --alias "$ALIAS_CLAUDE" \
  --config "$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE/config.json" \
  > /tmp/claude-agent2.log 2>&1 &
CLAUDE_PID2=$!

DEADLINE=$(($(date +%s) + 20))
SAW_WAKE=0
while [ $(date +%s) -lt $DEADLINE ]; do
  grep -q "\[goal\] wake ${GOAL_ID:0:8}" /tmp/claude-agent2.log && SAW_WAKE=1
  if [ $SAW_WAKE -eq 1 ]; then break; fi
  sleep 1
done

kill $CLAUDE_PID2 2>/dev/null || true
wait $CLAUDE_PID2 2>/dev/null || true

if [ $SAW_WAKE -eq 1 ]; then
  pass "claude-agent-sdk: '[goal] wake ${GOAL_ID:0:8}' fired after restart (full CLI→parser→goal→wake path ✓)"
else
  fail "claude-agent-sdk: wake did NOT fire even after restart with past next_wake_at"
  echo "--- agent2 log tail ---"
  tail -30 /tmp/claude-agent2.log
  exit 1
fi

# 3. Test codex-sdk runtime — same full path, light-touch
echo ""
echo "3. codex-sdk runtime — startup enable + CLI loop + wake fire..."

ALIAS_CODEX="loop-test-codex"
WORKDIR_CODEX="/tmp/loop-test-codex"
create_loop_agent_config "$ALIAS_CODEX" codex-sdk gpt-5.5 "$WORKDIR_CODEX" \
  '{"goalTickMs":"5000"}'

cd "$WORKDIR_CODEX"
OPENAI_API_KEY="test-no-real-call" \
  timeout 60 agent-node \
  --alias "$ALIAS_CODEX" \
  --config "$WORKDIR_CODEX/.anet/nodes/$ALIAS_CODEX/config.json" \
  > /tmp/codex-agent.log 2>&1 &
CODEX_PID=$!

DEADLINE=$(($(date +%s) + 15))
SAW_CODEX_ENABLE=0
SAW_CODEX_REGISTERED=0
while [ $(date +%s) -lt $DEADLINE ]; do
  grep -q "goals scheduler: enabled (runtime=codex" /tmp/codex-agent.log && SAW_CODEX_ENABLE=1
  grep -q "已注册到 CommHub" /tmp/codex-agent.log && SAW_CODEX_REGISTERED=1
  if [ $SAW_CODEX_ENABLE -eq 1 ] && [ $SAW_CODEX_REGISTERED -eq 1 ]; then break; fi
  sleep 1
done

if [ $SAW_CODEX_ENABLE -eq 1 ]; then
  pass "codex-sdk: 'goals scheduler: enabled (runtime=codex)' ✓"
else
  fail "codex-sdk: scheduler NOT enabled"
  tail -20 /tmp/codex-agent.log
fi

# Real CLI path for codex too — covers `2h` single-letter variant.
COMMHUB_TOKEN="$USER_TOKEN" COMMHUB_URL="http://127.0.0.1:9210" \
  anet node loop "$ALIAS_CODEX" "e2e probe codex" --every 2h \
  > /tmp/cli-codex.log 2>&1 || true

if grep -q "✅ Scheduled loop" /tmp/cli-codex.log; then
  pass "codex-sdk: 'anet node loop --every 2h' confirmed by node (CLI path ✓)"
else
  fail "codex-sdk: CLI loop creation did not confirm"
  cat /tmp/cli-codex.log
  exit 1
fi

CODEX_GOAL_ID=$(python3 -c "import json;d=json.load(open('$WORKDIR_CODEX/.anet/nodes/$ALIAS_CODEX/goals.json'));print(d['goals'][0]['goal_id'])")

# Same restart pattern as claude
kill $CODEX_PID 2>/dev/null || true
wait $CODEX_PID 2>/dev/null || true

python3 <<PY
import json, datetime
p = "$WORKDIR_CODEX/.anet/nodes/$ALIAS_CODEX/goals.json"
d = json.load(open(p))
past = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
for g in d["goals"]:
    g["next_wake_at"] = past
json.dump(d, open(p, "w"))
PY

> /tmp/codex-agent2.log
OPENAI_API_KEY="test-no-real-call" \
  timeout 30 agent-node \
  --alias "$ALIAS_CODEX" \
  --config "$WORKDIR_CODEX/.anet/nodes/$ALIAS_CODEX/config.json" \
  > /tmp/codex-agent2.log 2>&1 &
CODEX_PID2=$!

DEADLINE=$(($(date +%s) + 20))
SAW_CODEX_WAKE=0
while [ $(date +%s) -lt $DEADLINE ]; do
  grep -q "\[goal\] wake ${CODEX_GOAL_ID:0:8}" /tmp/codex-agent2.log && SAW_CODEX_WAKE=1
  if [ $SAW_CODEX_WAKE -eq 1 ]; then break; fi
  sleep 1
done

kill $CODEX_PID2 2>/dev/null || true
wait $CODEX_PID2 2>/dev/null || true

if [ $SAW_CODEX_WAKE -eq 1 ]; then
  pass "codex-sdk: '[goal] wake ${CODEX_GOAL_ID:0:8}' fired after CLI→parser→goal landed ✓"
else
  fail "codex-sdk: tick did NOT fire wake"
fi

# 4. Channel /loop path (commhub_send_task with /loop slash — same
#    user entry that a chatting user / another agent uses)
echo ""
echo "4. Channel /loop slash path (commhub_send_task)..."

ALIAS_CH="loop-test-channel"
WORKDIR_CH="/tmp/loop-test-channel"
create_loop_agent_config "$ALIAS_CH" claude-agent-sdk claude-sonnet-4-6 "$WORKDIR_CH" \
  '{"dangerouslySkipPermissions":true,"teammateMode":true,"goalTickMs":"5000"}'

cd "$WORKDIR_CH"
ANTHROPIC_API_KEY="test-no-real-call" \
  timeout 30 agent-node \
  --alias "$ALIAS_CH" \
  --config "$WORKDIR_CH/.anet/nodes/$ALIAS_CH/config.json" \
  > /tmp/channel-agent.log 2>&1 &
CH_PID=$!

DEADLINE=$(($(date +%s) + 10))
while [ $(date +%s) -lt $DEADLINE ]; do
  grep -q "已注册到 CommHub" /tmp/channel-agent.log && break
  sleep 1
done

# Send a /loop via /api/task directly (same shape as commhub_send_task MCP tool)
CH_RESP=$(curl -s -X POST http://127.0.0.1:9210/api/task \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -d "{\"alias\":\"$ALIAS_CH\",\"task\":\"/loop 1d nightly cleanup\",\"priority\":\"normal\",\"from\":\"channel-test\",\"network_id\":\"$NET_ID\"}")
CH_TASK_ID=$(echo "$CH_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('task_id',''))" 2>/dev/null)
sleep 3

# Verify goals.json has it
if [ -f "$WORKDIR_CH/.anet/nodes/$ALIAS_CH/goals.json" ]; then
  CH_GOAL_COUNT=$(python3 -c "import json;d=json.load(open('$WORKDIR_CH/.anet/nodes/$ALIAS_CH/goals.json'));print(len([g for g in d.get('goals',[]) if g.get('status')=='active' and g.get('interval_ms')==86400000]))" 2>/dev/null)
  if [ "$CH_GOAL_COUNT" -ge 1 ]; then
    pass "channel /loop: 1d goal created via raw /api/task (interval=86400000ms)"
  else
    fail "channel /loop: goal not persisted"
    cat "$WORKDIR_CH/.anet/nodes/$ALIAS_CH/goals.json"
  fi
else
  fail "channel /loop: goals.json missing"
fi
kill $CH_PID 2>/dev/null || true
wait $CH_PID 2>/dev/null || true

# 5. Interval format edge cases (CLI argv validation)
echo ""
echo "5. Interval format edge cases (CLI argv validation)..."

# 5a. Sub-minute MUST be rejected at CLI layer (no silent success)
SUB_OUT=$(COMMHUB_TOKEN="$USER_TOKEN" COMMHUB_URL="http://127.0.0.1:9210" \
  anet node loop "$ALIAS_CLAUDE" "x" --every 30s 2>&1 || true)
if echo "$SUB_OUT" | grep -q "Invalid --every"; then
  pass "interval 30s: CLI rejects with clear error (no silent ✓ success)"
else
  fail "interval 30s: CLI did not reject"
  echo "$SUB_OUT" | head -5
fi

# 5b. Bogus format
BOG_OUT=$(COMMHUB_TOKEN="$USER_TOKEN" COMMHUB_URL="http://127.0.0.1:9210" \
  anet node loop "$ALIAS_CLAUDE" "x" --every 5x 2>&1 || true)
if echo "$BOG_OUT" | grep -q "Invalid --every"; then
  pass "interval 5x: CLI rejects with clear error"
else
  fail "interval 5x: CLI did not reject"
fi

# 5c. Empty --every
EMP_OUT=$(COMMHUB_TOKEN="$USER_TOKEN" COMMHUB_URL="http://127.0.0.1:9210" \
  anet node loop "$ALIAS_CLAUDE" "x" --every "" 2>&1 || true)
if echo "$EMP_OUT" | grep -q "Invalid --every"; then
  pass "interval empty: CLI rejects with clear error"
else
  fail "interval empty: CLI did not reject"
fi

# 6. anet goal list + cancel
echo ""
echo "6. anet goal list + cancel..."

# anet goal resolves nodes via $cwd/.anet/nodes — must cd into the
# workdir that has the node profile (created by the agent's
# --config write at startup).
cd "$WORKDIR_CLAUDE"
LIST_OUT=$(COMMHUB_TOKEN="$USER_TOKEN" COMMHUB_URL="http://127.0.0.1:9210" \
  anet goal list "$ALIAS_CLAUDE" 2>&1 || true)
if echo "$LIST_OUT" | grep -q "$GOAL_ID\|5min\|active"; then
  pass "anet goal list: shows the created goal"
else
  fail "anet goal list: goal not visible"
  echo "  --- list output ---"
  echo "$LIST_OUT" | head -10
fi

CANCEL_OUT=$(COMMHUB_TOKEN="$USER_TOKEN" COMMHUB_URL="http://127.0.0.1:9210" \
  anet goal cancel "$ALIAS_CLAUDE" "${GOAL_ID:0:8}" 2>&1 || true)
if echo "$CANCEL_OUT" | grep -qi "cancelled\|已取消\|status.*cancelled"; then
  pass "anet goal cancel: goal cancelled"
else
  fail "anet goal cancel: did not confirm cancellation"
  echo "  --- cancel output ---"
  echo "$CANCEL_OUT" | head -5
fi

# Verify cancel landed in goals.json
CANCELLED_COUNT=$(python3 -c "import json;d=json.load(open('$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE/goals.json'));print(len([g for g in d.get('goals',[]) if g.get('status')=='cancelled']))" 2>/dev/null)
if [ "$CANCELLED_COUNT" -ge 1 ]; then
  pass "goals.json: goal status flipped to 'cancelled' (no longer active)"
else
  fail "goals.json: cancel didn't persist"
fi
cd - > /dev/null

# 6b. grok-build-acp runtime — startup enable + scheduler picks goal
echo ""
echo "6b. grok-build-acp runtime — startup enable + goal fire..."

ALIAS_GROK="loop-test-grok"
WORKDIR_GROK="/tmp/loop-test-grok"
create_loop_agent_config "$ALIAS_GROK" grok-build-acp grok-build "$WORKDIR_GROK" \
  '{"goalTickMs":"5000"}'

# Pre-create a grok-runtime goal (no real grok binary needed for the
# scheduler-tick observation; SDK call inside processTask will fail
# but the wake log fires BEFORE that — matches the claude pattern).
GROK_GOAL="$(python3 -c "import uuid;print(uuid.uuid4())")"
PAST=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.UTC) - datetime.timedelta(minutes=1)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
NOW=$(python3 -c "import datetime;print(datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
cat > "$WORKDIR_GROK/.anet/nodes/$ALIAS_GROK/goals.json" <<EOF
{
  "version": 1,
  "goals": [
    {
      "goal_id": "$GROK_GOAL",
      "text": "grok smoke probe",
      "status": "active",
      "interval_ms": 60000,
      "next_wake_at": "$PAST",
      "runtime": "grok-build-acp",
      "created_at": "$NOW",
      "updated_at": "$NOW",
      "progress_log": []
    }
  ]
}
EOF

cd "$WORKDIR_GROK"
timeout 20 agent-node \
  --alias "$ALIAS_GROK" \
  --config "$WORKDIR_GROK/.anet/nodes/$ALIAS_GROK/config.json" \
  > /tmp/grok-agent.log 2>&1 &
GROK_PID=$!

DEADLINE=$(($(date +%s) + 15))
SAW_GROK_ENABLE=0
SAW_GROK_WAKE=0
while [ $(date +%s) -lt $DEADLINE ]; do
  grep -q "goals scheduler: enabled (runtime=grok" /tmp/grok-agent.log && SAW_GROK_ENABLE=1
  grep -q "\[goal\] wake ${GROK_GOAL:0:8}" /tmp/grok-agent.log && SAW_GROK_WAKE=1
  if [ $SAW_GROK_ENABLE -eq 1 ] && [ $SAW_GROK_WAKE -eq 1 ]; then break; fi
  sleep 1
done

kill $GROK_PID 2>/dev/null || true
wait $GROK_PID 2>/dev/null || true

if [ $SAW_GROK_ENABLE -eq 1 ]; then
  pass "grok-build-acp: 'goals scheduler: enabled (runtime=grok)' ✓"
else
  fail "grok-build-acp: scheduler NOT enabled"
  tail -20 /tmp/grok-agent.log
fi

if [ $SAW_GROK_WAKE -eq 1 ]; then
  pass "grok-build-acp: '[goal] wake ${GROK_GOAL:0:8}' fired ✓"
else
  fail "grok-build-acp: tick did NOT fire wake"
fi

# 6c. Multi-cycle wake — confirm scheduler fires REPEATEDLY (not just once)
echo ""
echo "6c. Multi-cycle wake — verify the scheduler fires the SAME goal repeatedly..."

ALIAS_MULTI="loop-test-multi"
WORKDIR_MULTI="/tmp/loop-test-multi"
create_loop_agent_config "$ALIAS_MULTI" codex-sdk gpt-5.5 "$WORKDIR_MULTI" \
  '{"goalTickMs":"5000"}'

MULTI_GOAL="$(python3 -c "import uuid;print(uuid.uuid4())")"
# 60s interval (parser min) + 5s tick. Past next_wake_at so first
# fire is immediate; second fire ~60s later; third ~120s.
cat > "$WORKDIR_MULTI/.anet/nodes/$ALIAS_MULTI/goals.json" <<EOF
{
  "version": 1,
  "goals": [
    {
      "goal_id": "$MULTI_GOAL",
      "text": "multi-cycle probe",
      "status": "active",
      "interval_ms": 60000,
      "next_wake_at": "$PAST",
      "runtime": "codex-sdk",
      "created_at": "$NOW",
      "updated_at": "$NOW",
      "progress_log": []
    }
  ]
}
EOF

cd "$WORKDIR_MULTI"
OPENAI_API_KEY="test-no-real-call" \
  timeout 140 agent-node \
  --alias "$ALIAS_MULTI" \
  --config "$WORKDIR_MULTI/.anet/nodes/$ALIAS_MULTI/config.json" \
  > /tmp/multi-agent.log 2>&1 &
MULTI_PID=$!

# Wait for 2 wakes minimum (first fires immediately, second after
# ~60s interval). 130s window gives generous margin.
DEADLINE=$(($(date +%s) + 130))
while [ $(date +%s) -lt $DEADLINE ]; do
  WAKE_COUNT=$( { grep -c "\[goal\] wake ${MULTI_GOAL:0:8}" /tmp/multi-agent.log 2>/dev/null || true; } | head -1)
  WAKE_COUNT=${WAKE_COUNT:-0}
  if [ "$WAKE_COUNT" -ge 2 ]; then break; fi
  sleep 5
done

kill $MULTI_PID 2>/dev/null || true
wait $MULTI_PID 2>/dev/null || true

WAKE_COUNT=$(grep -c "\[goal\] wake ${MULTI_GOAL:0:8}" /tmp/multi-agent.log 2>/dev/null || echo 0)
if [ "$WAKE_COUNT" -ge 2 ]; then
  pass "multi-cycle: scheduler fired the same goal $WAKE_COUNT times (proves not one-shot)"
else
  fail "multi-cycle: only $WAKE_COUNT wake(s) observed in 130s window (expected ≥2)"
  echo "  --- multi-agent log tail ---"
  tail -25 /tmp/multi-agent.log
fi

# 6d. Multi-cycle wake on **claude-agent-sdk** specifically
#
# 通信龙 spot-check tighten: the existing multi-cycle test (6c) ran
# on codex. Scheduler is runtime-agnostic shared code, but claude
# is Vincent's personally-tested runtime — pin its multi-cycle
# behaviour rather than relying on transitive inference from codex.
echo ""
echo "6d. Multi-cycle wake — claude-agent-sdk (Vincent's runtime)..."

ALIAS_CMULTI="loop-test-claude-multi"
WORKDIR_CMULTI="/tmp/loop-test-claude-multi"
create_loop_agent_config "$ALIAS_CMULTI" claude-agent-sdk claude-sonnet-4-6 "$WORKDIR_CMULTI" \
  '{"dangerouslySkipPermissions":true,"teammateMode":true,"goalTickMs":"5000"}'

CMULTI_GOAL="$(python3 -c "import uuid;print(uuid.uuid4())")"
cat > "$WORKDIR_CMULTI/.anet/nodes/$ALIAS_CMULTI/goals.json" <<EOF
{
  "version": 1,
  "goals": [
    {
      "goal_id": "$CMULTI_GOAL",
      "text": "claude multi-cycle probe",
      "status": "active",
      "interval_ms": 60000,
      "next_wake_at": "$PAST",
      "runtime": "claude-agent-sdk",
      "created_at": "$NOW",
      "updated_at": "$NOW",
      "progress_log": []
    }
  ]
}
EOF

cd "$WORKDIR_CMULTI"
ANTHROPIC_API_KEY="test-no-real-call" \
  timeout 140 agent-node \
  --alias "$ALIAS_CMULTI" \
  --config "$WORKDIR_CMULTI/.anet/nodes/$ALIAS_CMULTI/config.json" \
  > /tmp/cmulti-agent.log 2>&1 &
CMULTI_PID=$!

# Same 130s window as 6c codex test.
DEADLINE=$(($(date +%s) + 130))
while [ $(date +%s) -lt $DEADLINE ]; do
  CMULTI_WAKE_COUNT=$( { grep -c "\[goal\] wake ${CMULTI_GOAL:0:8}" /tmp/cmulti-agent.log 2>/dev/null || true; } | head -1)
  CMULTI_WAKE_COUNT=${CMULTI_WAKE_COUNT:-0}
  if [ "$CMULTI_WAKE_COUNT" -ge 2 ]; then break; fi
  sleep 5
done

kill $CMULTI_PID 2>/dev/null || true
wait $CMULTI_PID 2>/dev/null || true

CMULTI_WAKE_COUNT=$( { grep -c "\[goal\] wake ${CMULTI_GOAL:0:8}" /tmp/cmulti-agent.log 2>/dev/null || true; } | head -1)
CMULTI_WAKE_COUNT=${CMULTI_WAKE_COUNT:-0}
if [ "$CMULTI_WAKE_COUNT" -ge 2 ]; then
  pass "claude multi-cycle: scheduler fired same goal $CMULTI_WAKE_COUNT times (Vincent's runtime ✓ not inference)"
else
  fail "claude multi-cycle: only $CMULTI_WAKE_COUNT wake(s) observed in 130s window (expected ≥2)"
  echo "  --- claude-multi log tail ---"
  tail -25 /tmp/cmulti-agent.log
fi

# 7. Offline node behavior — CLI polls + times out cleanly
echo ""
echo "7. Offline node behavior (CLI must fail clearly, not silent ✅)..."

OFF_OUT=$(COMMHUB_TOKEN="$USER_TOKEN" COMMHUB_URL="http://127.0.0.1:9210" \
  timeout 25 anet node loop "$ALIAS_CLAUDE" "this node is dead" --every 5m 2>&1 || true)
if echo "$OFF_OUT" | grep -q "did not confirm\|node offline"; then
  pass "offline node: CLI reports timeout (does NOT print false ✅)"
elif echo "$OFF_OUT" | grep -q "✅ Scheduled"; then
  fail "offline node: CLI printed false success ✓ — silent-fail regression"
  echo "$OFF_OUT" | head -10
else
  pass "offline node: CLI did not print ✅ (alternative non-success output OK)"
fi

# 8. Cleanup
kill $HUB_PID 2>/dev/null || true

echo ""
echo "========================================="
echo "  Summary: $PASS pass, $FAIL fail"
echo "========================================="
# Also emit the format test-all.sh's run_suite parses
# (`\d+(?= passed)` and `\d+(?= failed)`).
echo "Results: $PASS passed, $FAIL failed"

if [ $FAIL -eq 0 ]; then
  echo "🎉 All loop-runtime checks pass"
  exit 0
else
  echo "❌ Loop-runtime regression"
  exit 1
fi

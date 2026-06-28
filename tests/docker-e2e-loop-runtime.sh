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
NET_TOKEN=$(echo "$REG" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('network_token',''))" 2>/dev/null)
NET_ID=$(echo "$REG" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('network_id',''))" 2>/dev/null)
[ -n "$NET_TOKEN" ] && pass "test user registered, network token issued (net=${NET_ID:0:12})" \
  || { fail "user registration failed: $REG"; exit 1; }

# 2. Test claude-agent-sdk runtime — the load-bearing one
echo ""
echo "2. claude-agent-sdk runtime — scheduler enable + wake fire..."

ALIAS_CLAUDE="loop-test-claude"
WORKDIR_CLAUDE="/tmp/loop-test-claude"
rm -rf "$WORKDIR_CLAUDE"
mkdir -p "$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE"
cat > "$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE/config.json" <<EOF
{
  "alias": "$ALIAS_CLAUDE",
  "runtime": "claude-agent-sdk",
  "hub": "http://127.0.0.1:9210",
  "model": "claude-sonnet-4-6",
  "token": "$NET_TOKEN",
  "network_id": "$NET_ID",
  "flags": { "dangerouslySkipPermissions": true, "teammateMode": true, "goalTickMs": "5000" }
}
EOF

# Pre-inject a claude-runtime goal with 5s interval, next_wake_at = now
# so the very first tick after startup fires it.
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
PAST_ISO=$(date -u -d "1 minute ago" +%Y-%m-%dT%H:%M:%S.000Z)
GOAL_ID="goal-claude-e2e-${RANDOM}"
cat > "$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE/goals.json" <<EOF
{
  "version": 1,
  "goals": [
    {
      "goal_id": "$GOAL_ID",
      "text": "e2e probe: confirm scheduler fires this wake",
      "status": "active",
      "interval_ms": 5000,
      "next_wake_at": "$PAST_ISO",
      "runtime": "claude-agent-sdk",
      "created_at": "$NOW_ISO",
      "updated_at": "$NOW_ISO",
      "progress_log": []
    }
  ]
}
EOF
pass "pre-injected claude-runtime goal (id=${GOAL_ID:0:8}, interval=5s, next_wake_at in past)"

cd "$WORKDIR_CLAUDE"
# Use a bogus API key — the SDK call inside processTask WILL fail at
# the LLM layer, but we observe the wake log which fires BEFORE the
# call. Captures stdout+stderr to /tmp/claude-agent.log.
ANTHROPIC_API_KEY="test-no-real-call" \
  timeout 30 agent-node \
  --alias "$ALIAS_CLAUDE" \
  --config "$WORKDIR_CLAUDE/.anet/nodes/$ALIAS_CLAUDE/config.json" \
  > /tmp/claude-agent.log 2>&1 &
CLAUDE_PID=$!

# Wait up to 25s for both expected log lines to appear.
DEADLINE=$(($(date +%s) + 25))
SAW_ENABLE=0
SAW_WAKE=0
while [ $(date +%s) -lt $DEADLINE ]; do
  grep -q "goals scheduler: enabled (runtime=claude" /tmp/claude-agent.log && SAW_ENABLE=1
  grep -q "\[goal\] wake ${GOAL_ID:0:8}" /tmp/claude-agent.log && SAW_WAKE=1
  if [ $SAW_ENABLE -eq 1 ] && [ $SAW_WAKE -eq 1 ]; then break; fi
  sleep 1
done

kill $CLAUDE_PID 2>/dev/null || true
wait $CLAUDE_PID 2>/dev/null || true

if [ $SAW_ENABLE -eq 1 ]; then
  pass "claude-agent-sdk: 'goals scheduler: enabled (runtime=claude...)' (gate removed ✓)"
else
  fail "claude-agent-sdk: scheduler NOT enabled — gate still blocking"
  echo "  --- tail of /tmp/claude-agent.log ---"
  tail -30 /tmp/claude-agent.log
fi

if [ $SAW_WAKE -eq 1 ]; then
  pass "claude-agent-sdk: '[goal] wake ${GOAL_ID:0:8}' fired (tick reaches goal ✓)"
else
  fail "claude-agent-sdk: scheduler enabled but tick did NOT fire wake"
  echo "  --- tail of /tmp/claude-agent.log ---"
  tail -40 /tmp/claude-agent.log
fi

# 3. Test codex-sdk runtime — light-touch (just the enable log)
echo ""
echo "3. codex-sdk runtime — startup enable log..."

ALIAS_CODEX="loop-test-codex"
WORKDIR_CODEX="/tmp/loop-test-codex"
rm -rf "$WORKDIR_CODEX"
mkdir -p "$WORKDIR_CODEX/.anet/nodes/$ALIAS_CODEX"
cat > "$WORKDIR_CODEX/.anet/nodes/$ALIAS_CODEX/config.json" <<EOF
{
  "alias": "$ALIAS_CODEX",
  "runtime": "codex-sdk",
  "hub": "http://127.0.0.1:9210",
  "model": "gpt-5.5",
  "token": "$NET_TOKEN",
  "network_id": "$NET_ID",
  "flags": { "goalTickMs": "5000" }
}
EOF

CODEX_GOAL_ID="goal-codex-e2e-${RANDOM}"
cat > "$WORKDIR_CODEX/.anet/nodes/$ALIAS_CODEX/goals.json" <<EOF
{
  "version": 1,
  "goals": [
    {
      "goal_id": "$CODEX_GOAL_ID",
      "text": "e2e probe codex",
      "status": "active",
      "interval_ms": 5000,
      "next_wake_at": "$PAST_ISO",
      "runtime": "codex-sdk",
      "created_at": "$NOW_ISO",
      "updated_at": "$NOW_ISO",
      "progress_log": []
    }
  ]
}
EOF

cd "$WORKDIR_CODEX"
OPENAI_API_KEY="test-no-real-call" \
  timeout 20 agent-node \
  --alias "$ALIAS_CODEX" \
  --config "$WORKDIR_CODEX/.anet/nodes/$ALIAS_CODEX/config.json" \
  > /tmp/codex-agent.log 2>&1 &
CODEX_PID=$!

DEADLINE=$(($(date +%s) + 15))
SAW_CODEX_ENABLE=0
SAW_CODEX_WAKE=0
while [ $(date +%s) -lt $DEADLINE ]; do
  grep -q "goals scheduler: enabled (runtime=codex" /tmp/codex-agent.log && SAW_CODEX_ENABLE=1
  grep -q "\[goal\] wake ${CODEX_GOAL_ID:0:8}" /tmp/codex-agent.log && SAW_CODEX_WAKE=1
  if [ $SAW_CODEX_ENABLE -eq 1 ] && [ $SAW_CODEX_WAKE -eq 1 ]; then break; fi
  sleep 1
done

kill $CODEX_PID 2>/dev/null || true
wait $CODEX_PID 2>/dev/null || true

if [ $SAW_CODEX_ENABLE -eq 1 ]; then
  pass "codex-sdk: 'goals scheduler: enabled (runtime=codex)' ✓"
else
  fail "codex-sdk: scheduler NOT enabled"
  tail -20 /tmp/codex-agent.log
fi

if [ $SAW_CODEX_WAKE -eq 1 ]; then
  pass "codex-sdk: '[goal] wake ${CODEX_GOAL_ID:0:8}' fired ✓"
else
  fail "codex-sdk: tick did NOT fire wake"
fi

# 4. Cleanup
kill $HUB_PID 2>/dev/null || true

echo ""
echo "========================================="
echo "  Summary: $PASS pass, $FAIL fail"
echo "========================================="

if [ $FAIL -eq 0 ]; then
  echo "🎉 All loop-runtime checks pass"
  exit 0
else
  echo "❌ Loop-runtime regression"
  exit 1
fi

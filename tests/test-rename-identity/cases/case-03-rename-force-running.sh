#!/usr/bin/env bash
# Case 3 — #180: rename --force a RUNNING node — old proc killed + new restart,
# no 误杀 (no unrelated process killed). PR-3 e0aa4d8 fixed proc match for
# codex/grok basename too.
set -u
. /harness/lib/helpers.sh
WORK="/work/case-03"; rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 3 #180: rename --force running node — node-e → node-f"

anet node create node-e --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1
NID=$(find_node_id "$WORK" node-e)
record_check "node-e created" PASS "node_id=$NID"

# Start node-e — keep it running
nohup anet node start node-e > "$ART_DIR/start-e.log" 2>&1 &
NE_PID=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start-e.log" 2>/dev/null && break; sleep 1; done
grep -q 'SSE connected' "$ART_DIR/start-e.log" && record_check "node-e running" PASS "SSE connected" || record_check "node-e running" FAIL "no SSE in 30s"

# Capture all agent-node PIDs that look related, to verify --force kills only the right ones
PRE_AGENT_NODE_PIDS=$(pgrep -f 'agent-node' 2>/dev/null | tr '\n' ' ')
LOG "pre-rename agent-node PIDs: $PRE_AGENT_NODE_PIDS"

# Also spawn an UNRELATED long-running process (different alias) that should NOT be killed
mkdir -p "$WORK/.anet/nodes/unrelated-bystander"
nohup sleep 600 > /dev/null 2>&1 &
UNRELATED_PID=$!
LOG "unrelated bystander sleep PID=$UNRELATED_PID"

# Now rename --force — should kill node-e, NOT bystander
anet node rename node-e node-f --force > "$ART_DIR/rename.log" 2>&1
RC=$?
LOG "rename --force rc=$RC: $(head -8 $ART_DIR/rename.log | mask | tr '\n' ' ')"
sleep 3

# Old node-e proc should be gone
OLD_E_ALIVE=0
for p in $PRE_AGENT_NODE_PIDS; do
  if kill -0 "$p" 2>/dev/null; then
    # Check if this proc still references node-e (vs has been re-execed for node-f)
    CMDL=$(ps -o cmd= -p "$p" 2>/dev/null)
    if echo "$CMDL" | grep -q 'node-e' && ! echo "$CMDL" | grep -q 'node-f'; then
      OLD_E_ALIVE=1
      LOG "OOPS: old node-e proc $p still alive: $CMDL"
    fi
  fi
done
if [ "$OLD_E_ALIVE" = "0" ]; then
  record_check "old node-e killed" PASS "no surviving node-e-cmdline proc"
else
  record_check "old node-e killed" FAIL "old node-e proc still alive"
fi

# Unrelated bystander must still be alive
if kill -0 "$UNRELATED_PID" 2>/dev/null; then
  record_check "unrelated bystander NOT killed" PASS "PID $UNRELATED_PID alive"
else
  record_check "unrelated bystander NOT killed" FAIL "REGRESSION #180 — unrelated sleep was killed"
fi

# Cleanup bystander
kill -KILL "$UNRELATED_PID" 2>/dev/null

# Dir flipped
[ -d "$WORK/.anet/nodes/node-f" ] && record_check "dir → node-f" PASS "dir exists" || record_check "dir → node-f" FAIL "no node-f dir"

# New node-f should be running (rename --force does C4 restart)
sleep 5
# Look for fresh agent-node proc with node-f in cmdline
NEW_F_ALIVE=0
for p in $(pgrep -f 'agent-node' 2>/dev/null); do
  CMDL=$(ps -o cmd= -p "$p" 2>/dev/null)
  if echo "$CMDL" | grep -q 'node-f'; then
    NEW_F_ALIVE=1
    LOG "new node-f proc alive PID=$p"
    break
  fi
done
if [ "$NEW_F_ALIVE" = "1" ]; then
  record_check "node-f auto-restart after rename" PASS "new proc with node-f in cmdline"
else
  record_check "node-f auto-restart after rename" FAIL "no node-f proc visible (C4 restart may not have fired or didn't pass --alias)"
fi

# Cleanup
for p in $(pgrep -f 'agent-node' 2>/dev/null); do kill -TERM "$p" 2>/dev/null; done
stop_hub

case_verdict 3 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1

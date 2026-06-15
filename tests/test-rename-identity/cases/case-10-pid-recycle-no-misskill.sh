#!/usr/bin/env bash
# Case 10 — #180 regression of f74c04c: rename --force with stale .pid file
# whose PID has been RECYCLED to an unrelated process. Must NOT SIGKILL the
# bystander. PR-3 e0aa4d8 hardens findNodeProcessesByAlias to scan cmdline,
# not blindly trust .pid.
set -u
. /harness/lib/helpers.sh
WORK="/work/case-10"; rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 10 #180: stale .pid + recycled pid → rename --force does NOT kill bystander"

anet node create n10 --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1
NID=$(find_node_id "$WORK" n10)

# Inject a stale .pid file pointing to a soon-to-be-spawned unrelated proc PID
# Spawn the bystander first to claim a PID, then write it to .pid
nohup sleep 600 > /dev/null 2>&1 &
BYSTANDER_PID=$!
LOG "bystander sleep PID=$BYSTANDER_PID (unrelated to n10)"

# Plant stale .pid pointing at bystander
mkdir -p "$WORK/.anet/nodes/n10"
echo "$BYSTANDER_PID" > "$WORK/.anet/nodes/n10/.pid"
record_check "stale .pid planted" PASS "n10/.pid = $BYSTANDER_PID (which is unrelated sleep proc)"

# Now rename --force — should NOT trust .pid blindly, should scan cmdline,
# find no real agent-node n10 proc, leave bystander alone.
anet node rename n10 n10b --force > "$ART_DIR/rename.log" 2>&1
RC=$?
LOG "rename --force rc=$RC: $(head -5 $ART_DIR/rename.log | mask | tr '\n' ' ')"

# Bystander must still be alive
sleep 1
if kill -0 "$BYSTANDER_PID" 2>/dev/null; then
  record_check "bystander NOT SIGKILLed" PASS "PID $BYSTANDER_PID alive after rename --force"
else
  record_check "bystander NOT SIGKILLed" FAIL "REGRESSION #180 — bystander PID $BYSTANDER_PID was killed (rename trusted stale .pid)"
fi

# Cleanup bystander
kill -KILL "$BYSTANDER_PID" 2>/dev/null
stop_hub
case_verdict 10 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1

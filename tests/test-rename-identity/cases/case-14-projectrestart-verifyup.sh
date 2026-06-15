#!/usr/bin/env bash
# Case 14 — SDK马 add: rename --force → projectRestart summary reports
# 1/1 up (not 1/1 failed). PR-3 changed findNodeProcessesByAlias to also
# match codex/grok basenames; #174 verifyNodeUp must still identify the
# new-alias process post-rename.
set -u
. /harness/lib/helpers.sh
WORK="/work/case-14"; rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 14 SDK马: rename --force → projectRestart says 1/1 up not 1/1 failed (#174)"

anet node create vp-node --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1

# anet project up — should bring up 1 node
anet project up --stagger 1 > "$ART_DIR/project-up.log" 2>&1
LOG "project up: $(head -8 $ART_DIR/project-up.log | mask | tr '\n' ' ')"
grep -qE '1/1 up|✅ vp-node' "$ART_DIR/project-up.log" && record_check "project up 1/1" PASS "" || record_check "project up 1/1" FAIL "$(head -10 $ART_DIR/project-up.log | mask)"

# rename --force (running node)
anet node rename vp-node vp-renamed --force > "$ART_DIR/rename.log" 2>&1
LOG "rename --force: $(head -5 $ART_DIR/rename.log | mask | tr '\n' ' ')"

sleep 5  # let restart settle

# Now projectRestart — should see the new-alias node as up (not failed)
anet project restart --stagger 1 > "$ART_DIR/project-restart.log" 2>&1 &
PR_PID=$!
sleep 8  # restart cycle takes a moment
kill -TERM "$PR_PID" 2>/dev/null
wait $PR_PID 2>/dev/null

LOG "project restart: $(head -15 $ART_DIR/project-restart.log | mask | tr '\n' ' ')"

# Look for "1/1 up" or "✅ vp-renamed", NOT "1/1 failed" / "❌ vp-renamed" / "0/1 up"
if grep -qE '1/1 up|✅ vp-renamed' "$ART_DIR/project-restart.log"; then
  record_check "projectRestart shows 1/1 up (verifyNodeUp finds new alias)" PASS "vp-renamed seen as up"
elif grep -qE '1/1 failed|❌ vp-renamed|0/1 up' "$ART_DIR/project-restart.log"; then
  record_check "projectRestart shows 1/1 up" FAIL "REGRESSION — #174 verifyNodeUp doesn't see new alias process after rename"
else
  record_check "projectRestart shows 1/1 up" FAIL "ambiguous: $(grep -E 'up|failed|✅|❌|vp-' $ART_DIR/project-restart.log | head -3)"
fi

# Cleanup
anet project down > "$ART_DIR/project-down.log" 2>&1 || true
stop_hub
case_verdict 14 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1

#!/usr/bin/env bash
# Case 11 — concurrent: rename + incoming task at the same instant.
# Per RFC-010 race spec + PR-1 eventBus rebind: task should land at
# canonical alias atomically (not lost, not duplicated).
set -u

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../lib/safe-rm.sh"
. /harness/lib/helpers.sh
WORK="/work/case-11"; safe_rm_rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

start_hub "$ART_DIR/hub.log" || exit 1
bootstrap_admin || exit 2
LOG "case 11: concurrent rename + incoming task — atomic delivery to canonical"

anet node create racer --runtime grok-build-acp > "$ART_DIR/create.log" 2>&1
nohup anet node start racer > "$ART_DIR/start.log" 2>&1 &
P=$!
for i in $(seq 1 30); do grep -q 'SSE connected' "$ART_DIR/start.log" 2>/dev/null && break; sleep 1; done
kill -TERM "$P" 2>/dev/null; sleep 2

# Fire rename and tasks concurrently
NONCE="C11-$(date +%s%N)"
(
  anet node rename racer racer2 --force > "$ART_DIR/rename.log" 2>&1
) &
RENAME_PID=$!

# Issue 5 tasks in parallel (some to OLD some to NEW) during rename window
for i in 1 2 3 4 5; do
  ALIAS=$([ $((i % 2)) -eq 0 ] && echo "racer2" || echo "racer")
  send_task_rest "$ALIAS" "${NONCE}-burst-$i" "tester" "$UTOK" > "$ART_DIR/task-$i.json" 2>&1 &
done

wait $RENAME_PID
sleep 3

# Count successful tasks (HTTP 200 + ok:true)
SUCCESS=0; ALIAS_NOT_FOUND=0
for i in 1 2 3 4 5; do
  if grep -q '"ok":true' "$ART_DIR/task-$i.json" 2>/dev/null; then
    SUCCESS=$((SUCCESS+1))
  elif grep -q '"error":"alias_not_found"' "$ART_DIR/task-$i.json" 2>/dev/null; then
    ALIAS_NOT_FOUND=$((ALIAS_NOT_FOUND+1))
  fi
done
LOG "race result: success=$SUCCESS/5, alias_not_found=$ALIAS_NOT_FOUND/5"

# PASS criteria: ALL 5 tasks must be either accepted (canonical resolve
# redirected old → new) OR fail with explicit alias_not_found (not crash /
# 500). NO silent drops.
if [ "$SUCCESS" -eq 5 ]; then
  record_check "all 5 race tasks succeeded (canonical redirect)" PASS "5/5 ok:true"
elif [ "$((SUCCESS + ALIAS_NOT_FOUND))" -eq 5 ]; then
  record_check "all 5 race tasks accounted for" PASS "ok=$SUCCESS, alias_not_found=$ALIAS_NOT_FOUND (no silent drops / crashes)"
else
  record_check "all 5 race tasks accounted for" FAIL "ok=$SUCCESS, alias_not_found=$ALIAS_NOT_FOUND, lost=$((5 - SUCCESS - ALIAS_NOT_FOUND))"
fi

# Final state: should be at racer2 (canonical), not racer
DIR_OK=0
[ -d "$WORK/.anet/nodes/racer2" ] && [ ! -d "$WORK/.anet/nodes/racer" ] && DIR_OK=1
[ "$DIR_OK" = "1" ] && record_check "final dir = racer2" PASS "canonical state" || record_check "final dir = racer2" FAIL "directory state: $(ls $WORK/.anet/nodes/)"

stop_hub
case_verdict 11 > "$ART_DIR/verdict"
cat "$ART_DIR/verdict"
[ "$_FAIL_COUNT" -eq 0 ] && exit 0 || exit 1

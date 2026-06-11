#!/bin/bash
# Master test runner — run all suites, produce final report
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   anet V3 — Full Regression Test Suite           ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

TOTAL_PASS=0
TOTAL_FAIL=0
SUITES=()

run_suite() {
  local NAME="$1"
  local CMD="$2"
  echo "━━━ $NAME ━━━"
  OUTPUT=$(eval "$CMD" 2>&1)
  PASS=$(echo "$OUTPUT" | grep -oP '\d+(?= passed)' | tail -1)
  FAIL=$(echo "$OUTPUT" | grep -oP '\d+(?= failed)' | tail -1)
  PASS=${PASS:-0}; FAIL=${FAIL:-0}
  # #65 sanity guard: 0 pass + 0 fail = suite crashed or never reached Results line,
  # not a real green. Count as a failure to surface the silent skip.
  TOTAL_RUN=$((PASS + FAIL))
  if [ "$TOTAL_RUN" -eq 0 ]; then
    STATUS="⚠️"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    SUITES+=("$STATUS $NAME: SKIPPED/CRASHED (0 ran — Results line missing, suite likely exited early)")
    echo "  $STATUS WARNING: 0 ran (suite crashed or Results line missing)"
    echo ""
    return
  fi
  TOTAL_PASS=$((TOTAL_PASS + PASS))
  TOTAL_FAIL=$((TOTAL_FAIL + FAIL))
  STATUS="✅"
  [ "$FAIL" -gt 0 ] && STATUS="❌"
  SUITES+=("$STATUS $NAME: $PASS pass, $FAIL fail")
  echo "  $STATUS $PASS passed, $FAIL failed"
  echo ""
}

# Start server once
cd /app/server && bun run src/index.ts &>/dev/null &
sleep 3

run_suite "Base E2E (137)" "/app/test.sh 2>&1"
run_suite "V3 Auth (25)" "/app/test-auth.sh 2>&1"
run_suite "V3 Networks (22)" "/app/test-networks.sh 2>&1"
run_suite "Config Priority (16)" "/app/test-config.sh 2>&1"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Final Report                                    ║"
echo "╠══════════════════════════════════════════════════╣"
for s in "${SUITES[@]}"; do
  echo "║  $s"
done
echo "╠══════════════════════════════════════════════════╣"
echo "║  TOTAL: $TOTAL_PASS passed, $TOTAL_FAIL failed              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

[ $TOTAL_FAIL -eq 0 ] && exit 0 || exit 1

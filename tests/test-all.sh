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

# Each suite gets a fresh server + fresh DB. Without this, Base E2E leaves
# 137 tests' worth of state in commhub.db + binds :9200, which then breaks
# V3 Networks (state pollution → Results line never produced → reported as
# "0 ran") and Config Priority (its own `bun run src/index.ts &` gets
# EADDRINUSE because the parent's server still owns :9200, so the suite
# proceeds against the stale shared server and stops on the first
# `anet node create` that needs fresh-DB state). See #266 round-1 audit.
#
# Suites that don't start their own server (Base E2E, V3 Auth) rely on
# reset_server() to put one up for them. Suites that DO start their own
# (V3 Networks, Config Priority) get a free :9200 to bind to.
reset_server() {
  pkill -f 'bun.*src/index.ts' 2>/dev/null || true
  # Wait for :9200 to actually free up — pkill is async; binding before
  # the old process releases would re-trigger the EADDRINUSE we just fixed.
  for _ in $(seq 1 30); do
    if ! (exec 3<>/dev/tcp/127.0.0.1/9200) 2>/dev/null; then break; fi
    exec 3>&- 2>/dev/null || true
    sleep 0.25
  done
  rm -rf /root/.commhub /root/.anet 2>/dev/null || true
  cd /app/server && bun run src/index.ts &>/dev/null &
  for _ in $(seq 1 30); do
    curl -sf http://127.0.0.1:9200/health > /dev/null && return 0
    sleep 0.5
  done
  echo "::warning::reset_server: server did not respond to /health within 15s" >&2
  return 1
}

reset_server
run_suite "Base E2E (137)" "/app/test.sh 2>&1"
reset_server
run_suite "V3 Auth (25)" "/app/test-auth.sh 2>&1"
reset_server
run_suite "V3 Networks (22)" "/app/test-networks.sh 2>&1"
reset_server
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

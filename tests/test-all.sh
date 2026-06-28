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
# CI-robust variant (PR #266 follow-up): explicit PID capture +
# kill -KILL + wait, no dependency on pkill/grep or bash's /dev/tcp.
# Originally this used `pkill -f 'bun.*src/index.ts'` + `/dev/tcp`
# probe — both work locally but neither survives GHA's runner Docker
# environment (V3 Networks regressed from local 19/3 to CI "0 ran"
# in run 28308477515 on 912d642). pkill/grep can miss the bun process
# depending on argv exposure, and `(exec 3<>/dev/tcp/...)` may behave
# differently under the runner's process model. The PID-capture form
# below is deterministic regardless.
SERVER_PID=""
reset_server() {
  # 1. Kill the previous server by exact PID (recorded last time we
  # started one). `kill -KILL` is signal 9 — immediate, no signal mask.
  if [ -n "$SERVER_PID" ]; then
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    # `wait` reaps the zombie + blocks until the process actually exits.
    # Skip if SERVER_PID isn't our child (wait returns 127 — fine).
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  # 2. Brief settle for the kernel to release the listening socket.
  # `kill -KILL` + `wait` is synchronous on the process, but the
  # socket TIME_WAIT / TCP shutdown clears asynchronously. 0.5s is
  # generous; the new server's /health poll below catches any slip.
  sleep 0.5

  # 3. Wipe per-suite state. Absolute paths only — never $VAR (lint
  # guard would reject; see tests/lib/safe-rm.sh).
  rm -rf /root/.commhub /root/.anet 2>/dev/null || true

  # 4. Start the new server in a subshell so `cd` doesn't pollute
  # the test-all.sh cwd, and capture its PID for next reset.
  (cd /app/server && exec bun run src/index.ts) &>/dev/null &
  SERVER_PID=$!

  # 5. Poll /health until ready (max 15s). Surface clearly if it
  # doesn't come up — the next suite would fail with confusing
  # connection errors otherwise.
  for _ in $(seq 1 30); do
    curl -sf http://127.0.0.1:9200/health > /dev/null && return 0
    sleep 0.5
  done
  echo "::warning::reset_server: server (PID $SERVER_PID) did not respond to /health within 15s" >&2
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

# #144 round-6 — loop runtime gate + universal /loop scheduler
# regression coverage. Each suite spins its OWN hub on a non-standard
# port (9210, 9211) with isolated COMMHUB_DB, so they coexist with the
# above suites that use :9200. No reset_server needed before these.
run_suite "Loop runtime e2e (20)" "/app/test-loop-runtime.sh 2>&1"
run_suite "Loop npm-pack install (12)" "/app/test-loop-npm-pack.sh 2>&1"
# RFC-025 M4 — agent loop self-management cross-runtime safety防线
# e2e. Owns its own hub on :9220 with isolated COMMHUB_DB; coexists
# with the prior suites (:9200) and #144 loop suites (:9210). Drives
# real codex+grok nodes through the 5 防线 test groups via the
# localhost loops HTTP MCP, plus a claude structural smoke.
run_suite "Loop self-mgmt e2e (41)" "/app/test-loop-self-mgmt.sh 2>&1"

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

#!/usr/bin/env bash
# qa-rfc026 master wrapper — runs the full suite + the dedicated
# nvm send-task race-free smoke. Both scripts use isolated hub ports
# + isolated COMMHUB_DB, so they coexist in one container.
#
# Order matters: run.sh first (it owns ports 9235 + WORK=/tmp/qa-rfc026-work),
# then nvm-sendtask-smoke.sh (owns port 9236 + WORK=/tmp/309-sendtask-work).
# A failure in either suite fails the wrapper.
set -uo pipefail
TOTAL_FAIL=0
SUITES=()

echo ""
echo "============================================================"
echo " qa-rfc026 master wrapper"
echo "============================================================"

note() { printf "\n\n=== %s ===\n" "$*"; }
record() {
  local name="$1" code="$2"
  if [[ "$code" -eq 0 ]]; then
    SUITES+=("✅ $name: PASS")
  else
    SUITES+=("❌ $name: FAIL (exit=$code)")
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi
}

note "Suite 1/2 — run.sh (RFC-026 P1 main e2e)"
/app/tests/qa-rfc026-create-node/run.sh; RC1=$?
record "RFC-026 P1 e2e (run.sh, includes A.nvm distinct-daemon)" "$RC1"

note "Suite 2/2 — nvm-sendtask-smoke.sh (PR #309 send-task三连)"
/app/tests/qa-rfc026-create-node/nvm-sendtask-smoke.sh; RC2=$?
record "PR #309 nvm send-task smoke (race-free single-daemon)" "$RC2"

echo ""
echo "============================================================"
echo " qa-rfc026 wrapper final"
echo "============================================================"
for s in "${SUITES[@]}"; do echo "  $s"; done
echo "  TOTAL FAILED SUITES: $TOTAL_FAIL"
echo "============================================================"

[[ "$TOTAL_FAIL" -eq 0 ]]

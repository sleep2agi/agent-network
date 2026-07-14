#!/usr/bin/env bash
# Layer 2: exact Node 20.20 runtime, durable SQLite fallback, and R1.

set -euo pipefail

REPORT="${REPORT:-/repo/docs/tests/report-test385.txt}"
mkdir -p "$(dirname "$REPORT")"
: > "$REPORT"
exec 3>&1 4>&2
exec > >(tee -a "$REPORT" >&3) 2>&1
tee_pid=$!
overall_emitted=0

finish_report() {
  local status=$?
  local tee_status
  trap - EXIT
  set +e
  if [[ "$status" -ne 0 && "$overall_emitted" -eq 0 ]]; then
    echo
    echo "OVERALL: FAIL (exit $status)"
  fi
  exec 1>&3 2>&4
  wait "$tee_pid"
  tee_status=$?
  exec 3>&- 4>&-
  if [[ "$status" -eq 0 && "$tee_status" -ne 0 ]]; then status=$tee_status; fi
  exit "$status"
}
trap finish_report EXIT

echo "# test385-rfc030-stage2-r1-node20"
echo
echo "date: $(date -Iseconds)"
echo "node: $(node --version)"
echo "better-sqlite3: $(node -p "require('better-sqlite3/package.json').version")"
echo "layer: 2 (run only after test384 passes)"
echo

node /harness/r1-node20-probe.mjs

echo
echo "OVERALL: PASS"
overall_emitted=1

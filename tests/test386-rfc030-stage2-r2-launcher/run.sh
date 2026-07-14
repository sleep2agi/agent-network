#!/usr/bin/env bash
# Layer 3: R2 mutation-red and the real util-linux PTY launcher boundary.

set -euo pipefail

REPORT="${REPORT:-/repo/docs/tests/report-test386.txt}"
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

echo "# test386-rfc030-stage2-r2-launcher"
echo
echo "date: $(date -Iseconds)"
echo "node: $(node --version)"
echo "ws: $(node -p "require('ws/package.json').version")"
echo "better-sqlite3: $(node -p "require('better-sqlite3/package.json').version")"
echo "script: $(script --version | head -1)"
echo "layer: 3 (run only after test385 passes)"
echo

set +e
timeout --signal=TERM --kill-after=2s 90s node /harness/r2-launcher-probe.mjs
probe_status=$?
set -e

if [[ "$probe_status" -ne 0 ]]; then
  if [[ "$probe_status" -eq 124 || "$probe_status" -eq 137 ]]; then
    echo
    echo "probe timeout: exceeded 90s total bound"
  fi
  echo
  echo "OVERALL: FAIL (probe exit $probe_status)"
  overall_emitted=1
  exit "$probe_status"
fi

echo
echo "OVERALL: PASS"
overall_emitted=1

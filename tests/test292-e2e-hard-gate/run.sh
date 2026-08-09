#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/app}
WORKFLOW=${WORKFLOW_PATH:-$ROOT/.github/workflows/e2e-docker.yml}
RUNNER=${RUNNER_PATH:-$ROOT/tests/lib/run-piped-command.sh}
GATE=${GATE_PATH:-$ROOT/tests/lib/e2e-hard-gate.sh}
TMP_DIR=$(mktemp -d /tmp/test292-hard-gate.XXXXXX)
cleanup() {
  find "$TMP_DIR" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "source_commit=${TEST292_HARD_GATE_SOURCE_COMMIT:-unembedded}"

expect_file_contains() {
  local file=$1 pattern=$2 name=$3
  if grep -Fq -- "$pattern" "$file"; then pass "$name"; else fail "$name"; fi
}

expect_gate_green() {
  local log=$1 rc=$2 name=$3
  if E2E_MIN_PASS=175 bash "$GATE" "$log" "$rc" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name"
  fi
}

expect_gate_red() {
  local log=$1 rc=$2 name=$3
  if E2E_MIN_PASS=175 bash "$GATE" "$log" "$rc" >/dev/null 2>&1; then
    fail "$name"
  else
    pass "$name"
  fi
}

printf 'Final Report\nTOTAL: 283 passed, 0 failed\n' > "$TMP_DIR/green.log"
printf 'Final Report\nTOTAL: 282 passed, 1 failed\n' > "$TMP_DIR/red.log"
printf 'Final Report\nTOTAL: 174 passed, 0 failed\n' > "$TMP_DIR/short.log"
printf 'Final Report\nno total here\n' > "$TMP_DIR/missing.log"
printf 'TOTAL: 283 passed, 0 failed\nTOTAL: malformed\n' > "$TMP_DIR/duplicate.log"

expect_file_contains "$WORKFLOW" 'tests/lib/run-piped-command.sh' 'workflow uses the tested pipeline wrapper'
expect_file_contains "$WORKFLOW" 'tests/lib/e2e-hard-gate.sh' 'workflow invokes the tested hard gate'
expect_file_contains "$WORKFLOW" 'tests/test292-e2e-hard-gate/run.sh' 'workflow continuously runs the gate contract'
expect_file_contains "$RUNNER" 'pipeline_status=("${PIPESTATUS[@]}")' 'pipeline wrapper snapshots both pipeline statuses'
expect_file_contains "$RUNNER" 'runner_rc=${pipeline_status[0]}' 'pipeline wrapper captures the runner rather than tee'

bash "$RUNNER" "$TMP_DIR/runner.log" "$TMP_DIR/runner.rc" \
  bash -c 'echo "TOTAL: 282 passed, 1 failed"; exit 7' >/dev/null
if [[ $(cat "$TMP_DIR/runner.rc") == 7 ]]; then
  pass 'pipeline wrapper preserves a non-zero command exit through tee'
else
  fail 'pipeline wrapper preserves a non-zero command exit through tee'
fi

bash "$RUNNER" /dev/full "$TMP_DIR/tee-failure.rc" \
  bash -c 'echo "TOTAL: 283 passed, 0 failed"; exit 0' >/dev/null 2>&1
if [[ $(cat "$TMP_DIR/tee-failure.rc") == tee_failed_* ]]; then
  pass 'tee/logging failure is preserved as a fail-closed status'
else
  fail 'tee/logging failure is preserved as a fail-closed status'
fi

expect_gate_green "$TMP_DIR/green.log" 0 'complete zero-failure regression passes'
expect_gate_red "$TMP_DIR/red.log" 1 'test failures with non-zero runner status fail'
expect_gate_red "$TMP_DIR/red.log" 0 'tee-masked runner status cannot hide TOTAL failures'
expect_gate_red "$TMP_DIR/green.log" 7 'non-zero runner status cannot hide behind a green TOTAL'
expect_gate_red "$TMP_DIR/short.log" 0 'truncated suite count fails closed'
expect_gate_red "$TMP_DIR/missing.log" 0 'missing TOTAL fails closed'
expect_gate_red "$TMP_DIR/duplicate.log" 0 'duplicate or malformed TOTAL fails closed'
expect_gate_red "$TMP_DIR/green.log" '' 'missing runner status fails closed'
expect_gate_red "$TMP_DIR/green.log" tee_failed_1 'tee failure status fails closed'

# Witnessed-red mutation 1: fully restore the historical shape: no pipefail
# *and* `$?` after tee. Either protection alone is sufficient, so mutating only
# one would be a vacuous "red must happen" claim rather than the old bug.
cp "$RUNNER" "$TMP_DIR/runner-mutant.sh"
sed -i 's/set -u -o pipefail/set -u/' "$TMP_DIR/runner-mutant.sh"
sed -i 's/runner_rc=${pipeline_status\[0\]}/runner_rc=$?/' "$TMP_DIR/runner-mutant.sh"
if cmp -s "$RUNNER" "$TMP_DIR/runner-mutant.sh"; then
  fail 'historical tee-masking mutation changed bytes'
else
  pass 'historical tee-masking mutation changed bytes'
fi
bash "$TMP_DIR/runner-mutant.sh" "$TMP_DIR/mutant-runner.log" "$TMP_DIR/mutant-runner.rc" \
  bash -c 'echo "TOTAL: 282 passed, 1 failed"; exit 7' >/dev/null
if [[ $(cat "$TMP_DIR/mutant-runner.rc") == 7 ]]; then
  fail 'WITNESSED_RED: no pipefail plus $? breaks the capture contract'
else
  pass 'WITNESSED_RED: no pipefail plus $? breaks the capture contract'
fi

# Witnessed-red mutation 2: deleting the failed-count rejection must make the
# masked-status fixture pass, which the contract recognizes as a regression.
cp "$GATE" "$TMP_DIR/gate-mutant.sh"
sed -i 's/if (( failed > 0 )); then/if (( failed < 0 )); then/' "$TMP_DIR/gate-mutant.sh"
if cmp -s "$GATE" "$TMP_DIR/gate-mutant.sh"; then
  fail 'failed-count mutation changed bytes'
else
  pass 'failed-count mutation changed bytes'
fi
if E2E_MIN_PASS=175 bash "$TMP_DIR/gate-mutant.sh" "$TMP_DIR/red.log" 0 >/dev/null 2>&1; then
  pass 'WITNESSED_RED: removing the failed-count gate accepts a red TOTAL'
else
  fail 'WITNESSED_RED: removing the failed-count gate accepts a red TOTAL'
fi

# Witnessed-red mutation 3: the workflow wiring is part of the invariant. A
# correct helper that is never invoked is not a gate.
cp "$WORKFLOW" "$TMP_DIR/workflow-mutant.yml"
sed -i 's#bash tests/lib/e2e-hard-gate.sh#bash /bin/true#' "$TMP_DIR/workflow-mutant.yml"
if cmp -s "$WORKFLOW" "$TMP_DIR/workflow-mutant.yml"; then
  fail 'workflow-wiring mutation changed bytes'
else
  pass 'workflow-wiring mutation changed bytes'
fi
if grep -Fq 'tests/lib/e2e-hard-gate.sh' "$TMP_DIR/workflow-mutant.yml"; then
  fail 'WITNESSED_RED: deleting the workflow hard-gate call is detected'
else
  pass 'WITNESSED_RED: deleting the workflow hard-gate call is detected'
fi

echo "RESULT: PASS=$PASS FAIL=$FAIL"
(( FAIL == 0 ))

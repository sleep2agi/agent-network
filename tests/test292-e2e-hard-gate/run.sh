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
  if bash "$GATE" "$log" "$rc" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name"
  fi
}

expect_gate_red() {
  local log=$1 rc=$2 name=$3
  if bash "$GATE" "$log" "$rc" >/dev/null 2>&1; then
    fail "$name"
  else
    pass "$name"
  fi
}

printf 'Final Report\nTOTAL: 283 passed, 0 failed\n' > "$TMP_DIR/green.log"
printf 'Final Report\nTOTAL: 283 passed, 1 failed\n' > "$TMP_DIR/red.log"
printf 'Final Report\nTOTAL: 282 passed, 0 failed\n' > "$TMP_DIR/short.log"
printf 'Final Report\nno total here\n' > "$TMP_DIR/missing.log"
printf 'TOTAL: 283 passed, 0 failed\nTOTAL: malformed\n' > "$TMP_DIR/duplicate.log"
# #924 —— 「某个套件压根没跑」和「用例数真的少了」必须红在不同的话上。
# 两条夹具的 TOTAL 都低于下限，旧门对它们说的是同一句 below minimum。
printf 'Final Report\n⚠️ Loop runtime e2e (20): SKIPPED/CRASHED (0 ran — Results line missing, suite likely exited early)\nTOTAL: 263 passed, 0 failed\n' > "$TMP_DIR/crashed.log"

expect_file_contains "$WORKFLOW" 'tests/lib/run-piped-command.sh' 'workflow uses the tested pipeline wrapper'
expect_file_contains "$WORKFLOW" 'tests/lib/e2e-hard-gate.sh' 'workflow invokes the tested hard gate'
expect_file_contains "$WORKFLOW" 'tests/test292-e2e-hard-gate/run.sh' 'workflow continuously runs the gate contract'
expect_file_contains "$RUNNER" 'pipeline_status=("${PIPESTATUS[@]}")' 'pipeline wrapper snapshots both pipeline statuses'
expect_file_contains "$RUNNER" 'runner_rc=${pipeline_status[0]}' 'pipeline wrapper captures the runner rather than tee'

bash "$RUNNER" "$TMP_DIR/runner.log" "$TMP_DIR/runner.rc" \
  bash -c 'echo "TOTAL: 283 passed, 1 failed"; exit 7' >/dev/null
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
if E2E_MIN_PASS=0 bash "$GATE" "$TMP_DIR/short.log" 0 >/dev/null 2>&1; then
  fail 'environment cannot lower the pinned regression floor'
else
  pass 'environment cannot lower the pinned regression floor'
fi
expect_gate_red "$TMP_DIR/missing.log" 0 'missing TOTAL fails closed'
expect_gate_red "$TMP_DIR/duplicate.log" 0 'duplicate or malformed TOTAL fails closed'

# 🔴 #924：不只是「要红」，是「红得说得出是哪一种」。
# short.log（用例真的少了）和 crashed.log（套件没跑）在旧门里是同一句话。
expect_gate_red "$TMP_DIR/crashed.log" 0 'a suite that never ran fails closed'
# 🔴 先把输出收进变量再判，不要 `bash "$GATE" … | grep -q`：
#    本文件顶上是 `set -euo pipefail`，而 $GATE 在这些用例里**本来就该非零退出**，
#    pipefail 会把那个 1 当成整条管道的结果 —— 于是 grep 明明命中了，`if` 仍然走
#    else 分支。第一版就是这么写的，结果 25 PASS / 1 FAIL，而那一条 FAIL 是假的。
crashed_out=$(bash "$GATE" "$TMP_DIR/crashed.log" 0 2>&1 || true)
if printf '%s' "$crashed_out" | grep -Fq 'never ran'; then
  pass 'a crashed suite is named as such, not reported as a missing test'
else
  fail 'a crashed suite is named as such, not reported as a missing test'
fi
short_out=$(bash "$GATE" "$TMP_DIR/short.log" 0 2>&1 || true)
if printf '%s' "$short_out" | grep -Fq 'never ran'; then
  fail 'a genuinely short count must NOT be blamed on a crashed suite'
else
  pass 'a genuinely short count must NOT be blamed on a crashed suite'
fi
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
  bash -c 'echo "TOTAL: 283 passed, 1 failed"; exit 7' >/dev/null
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
if bash "$TMP_DIR/gate-mutant.sh" "$TMP_DIR/red.log" 0 >/dev/null 2>&1; then
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

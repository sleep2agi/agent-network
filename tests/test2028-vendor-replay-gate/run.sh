#!/usr/bin/env bash
set -Eeuo pipefail

# #2028 —— 「未知回合禁止通用 vendor 重放」。
#
# 这条套件证明两件事是**承重**的（不是文本摆设）：
#   1. 结构化失败码命中时，`isTransientVendorError` 必须返回 false
#      —— 去掉那条门，用例必须红；
#   2. `cli.ts` 的 processTask 必须把结构化码传进重放门
#      —— 退回两参调用，接线断言必须红。
#
# 边界：这里验证的是「门 + 接线」，不是起真 runtime 跑完整 processTask
# （那需要 fake opencode server + 真 Hub，另见 #2028 说明）。
[[ "${TEST2028_SOURCE_COMMIT:-dev}" != "dev" && ! "${TEST2028_SOURCE_COMMIT}" =~ ^[0-9a-f]{40}$ ]] && {
  echo 'FAIL: TEST2028_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
echo "source_commit=${TEST2028_SOURCE_COMMIT:-dev}"

cd /agent-node-src
REPORT="${REPORT:-/report/report-test2028.txt}"
mkdir -p "$(dirname "$REPORT")"
exec > >(tee "$REPORT") 2>&1

GATE_TEST=src/vendor-error-replay-gate.test.ts
VENDOR_SRC=src/vendor-error.ts
CLI_SRC=src/cli.ts
GATE_ANCHOR='  if (isNonReplayableRuntimeFailure(runtimeCode)) return false;'
CLI_ANCHOR='isTransientVendorError(text, failed, runtimeFailureCode)'
CLI_REPL='isTransientVendorError(text, failed)'

echo "# test2028 — no vendor replay for known OpenCode runtime failures"
echo "date: $(date -Iseconds)"
echo "bun: $(bun --version)"

check_wiring() {
  # 先判「有没有退回两参」，再判「有没有三参」——顺序决定变异时报出哪一句。
  if grep -Eq 'isTransientVendorError\(text, failed\)[[:space:]]*[;)]' "$CLI_SRC"; then
    echo "FAIL: cli.ts still has the two-argument call"; return 1;
  fi
  grep -Fq 'isTransientVendorError(text, failed, runtimeFailureCode)' "$CLI_SRC" || {
    echo "FAIL: cli.ts does not pass runtimeFailureCode to isTransientVendorError"; return 1;
  }
}

echo
echo "## wiring — the CLI must pass the structured code to the gate"
# 这条原本是单元测试里的源码断言，但它会被**别人**(容器套件)扫到，
# 而某些套件会先变异 cli.ts，于是断言在它们里面假红（2026-10-23 实测：
# PR2889 的 L0+L1 job 就红在这条）。放到本套件里，跑的是本套件自己的上下文。
check_wiring || exit 1
echo "wiring ok"

echo
echo "## green — gate"
bun test "$GATE_TEST"

apply_mutation() {
  local file="$1" anchor="$2" repl="$3" bak="$4"
  local count
  count=$(grep -F -c "$anchor" "$file" || true)
  if [ "$count" != "1" ]; then
    echo "MUTATION_NOT_APPLIED: anchor count=$count in $file"
    exit 1
  fi
  cp "$file" "$bak"
  bun -e '
    const fs = require("fs");
    const [path, anchor, repl] = process.argv.slice(1);
    const text = fs.readFileSync(path, "utf8");
    const n = text.split(anchor).length - 1;
    if (n !== 1) { console.error("MUTATION_NOT_APPLIED: anchor count=" + n); process.exit(1); }
    fs.writeFileSync(path, text.replace(anchor, repl));
  ' "$file" "$anchor" "$repl"
}

run_mutation_expect_red() {
  local label="$1"; shift
  set +e
  "$@" >/tmp/mutation2028.log 2>&1
  local rc=$?
  set -e
  cat /tmp/mutation2028.log
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    exit 1
  fi
  echo "MUTATION_RED($label) rc=$rc"
}

echo
echo "## mutation A — drop the structured-code gate: the suppression case must go red"
apply_mutation "$VENDOR_SRC" "$GATE_ANCHOR" '  // mutation: gate removed' /tmp/vendor2028.bak
run_mutation_expect_red 'gate-removed' bun test "$GATE_TEST"
grep -F -q 'suppresses the vendor replay' /tmp/mutation2028.log || {
  echo 'MUTATION_RED_FOR_THE_WRONG_REASON: suppression case did not fail'; exit 1;
}
cp /tmp/vendor2028.bak "$VENDOR_SRC"

echo
echo "## mutation B — call the gate with two arguments: the wiring assertions must go red"
apply_mutation "$CLI_SRC" "$CLI_ANCHOR" "$CLI_REPL" /tmp/cli2028.bak
set +e
check_wiring >/tmp/mutation2028-wiring.log 2>&1
rc_w=$?
set -e
cat /tmp/mutation2028-wiring.log
if [ "$rc_w" -eq 0 ]; then echo "MUTATION_FALSE_GREEN: wiring-two-args"; exit 1; fi
grep -Fq 'two-argument call' /tmp/mutation2028-wiring.log || {
  echo 'MUTATION_RED_FOR_THE_WRONG_REASON: wiring grep did not report the two-arg call'; exit 1;
}
echo "MUTATION_RED(wiring-two-args) rc=$rc_w"
cp /tmp/cli2028.bak "$CLI_SRC"

echo
echo "## restored — green again"
bun test "$GATE_TEST"

echo
echo "RESULT: PASS (gate and wiring are both load-bearing)"

#!/bin/sh
set -eu

test "${TEST686_SOURCE_COMMIT:-unknown}" != unknown
cd /workspace

# 这个套件跑同一个测试文件三次(基线 / 变异后 / 还原后)。三次都只看退出码,
# 而退出码分不出「5 个测试全过」和「只注册到 1 个、它挂了」。
#
# 🔴 2026-08-17 CI 上真的发生过后者:
#     (fail) (unnamed) [5247.62ms]  ^ a beforeEach/afterEach hook timed out
#      0 pass  1 fail
#     Ran 1 test across 1 file. [5.47s]
#   而同一个文件在正常环境是 `5 pass / Ran 5 tests / 620ms`。
#   摘要里 `0 pass 1 fail` 读起来像「跑了 1 个挂了 1 个」——**没有任何一行说本该跑 5 个**。
#   见 #928。
#
# 所以每次跑都断言「至少注册到 GOLDEN_MIN_TESTS 个」。下限而不是等号:
# 加测试是常态,加了不该让这道门红;少跑了才是要抓的。
GOLDEN_FILE=server/src/rest-explicit-columns-http.test.ts
GOLDEN_MIN_TESTS=5   # 截至 2026-08-18 实际为 5

assert_ran_enough() {
  _log="$1"; _stage="$2"
  _ran=$(grep -oE 'Ran [0-9]+ tests? across' "$_log" | grep -oE '[0-9]+' | head -1)
  if [ -z "${_ran:-}" ]; then
    echo "[$_stage] 没能从输出里读到 'Ran N tests' —— 判不了跑了几个,拒绝通过" >&2
    tail -20 "$_log" >&2
    exit 1
  fi
  if [ "$_ran" -lt "$GOLDEN_MIN_TESTS" ]; then
    echo "[$_stage] 只注册到 $_ran 个测试,下限是 $GOLDEN_MIN_TESTS —— 分母塌了,这一轮的绿/红都不作数" >&2
    tail -20 "$_log" >&2
    exit 1
  fi
  printf '[%s] ran=%s (min %s)\n' "$_stage" "$_ran" "$GOLDEN_MIN_TESTS"
}

echo "L0: independent golden remains green"
bun test "$GOLDEN_FILE" 2>&1 | tee /tmp/test686-l0.log
# `set -o pipefail` 不是 POSIX sh 的保证项,所以显式取 bun 的退出码而不是 tee 的。
test "${PIPESTATUS:-0}" = 0 2>/dev/null || true
grep -qE '^\s*0 fail' /tmp/test686-l0.log || { echo "L0 not green" >&2; exit 1; }
assert_ran_enough /tmp/test686-l0.log L0

cp server/src/rest-projections.ts /tmp/rest-projections.orig
bun tests/test686-rest-shape-golden/mutate.mjs server/src/rest-projections.ts
cmp -s server/src/rest-projections.ts /tmp/rest-projections.orig && {
  echo "projection mutation was byte-identical" >&2
  exit 1
}

echo "L1: removing a previously public task key must turn red"
set +e
bun test server/src/rest-explicit-columns-http.test.ts >/tmp/test686-mutation.log 2>&1
mutation_rc=$?
set -e
cp /tmp/rest-projections.orig server/src/rest-projections.ts
test "$mutation_rc" -ne 0
grep -Fq 'task list and task detail expose the same explicit contract' /tmp/test686-mutation.log
grep -Fq 'created_at' /tmp/test686-mutation.log
# 🔴 变异那一轮同样要断分母:如果那一轮压根没跑起来,它也会「红」——
# 而那是一个为了错误的理由变红的 witnessed-red,证明不了变异被抓住。
assert_ran_enough /tmp/test686-mutation.log L1
printf 'mutation=drop-task-created-at rc=%s witnessed-red\n' "$mutation_rc"

echo "L2: restored production projection remains green"
bun test "$GOLDEN_FILE" 2>&1 | tee /tmp/test686-l2.log
grep -qE '^\s*0 fail' /tmp/test686-l2.log || { echo "L2 not green" >&2; exit 1; }
assert_ran_enough /tmp/test686-l2.log L2

printf 'source_commit=%s\n' "$TEST686_SOURCE_COMMIT"
printf 'RESULT: PASS\n'

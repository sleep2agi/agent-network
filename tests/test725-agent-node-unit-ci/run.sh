#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace
SOURCE_COMMIT=${TEST725_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: SOURCE_COMMIT must be one full lowercase Git SHA" >&2
  exit 1
}

echo "# test725 — complete agent-node unit domain"
echo "source_commit=$SOURCE_COMMIT"
echo "bun=$(bun --version) node=$(node --version) uid=$(id -u node)"
command -v crontab >/dev/null || { echo "FAIL: crontab dependency missing" >&2; exit 1; }

# #817:这道门原本连 src 的分母都没有 —— 只有一行 `bun test src/`,
# 删光测试文件它也不会红。补上分母 + 绝对下限,和 test745 对齐。
test_files=$(find "$ROOT/agent-node/src" -type f -name '*.test.ts' | wc -l | tr -d ' ')
[[ "$test_files" =~ ^[1-9][0-9]*$ ]] || {
  echo "FAIL: agent-node test-file denominator is empty" >&2
  exit 1
}
echo "test_files=$test_files"
AGENT_NODE_SRC_FLOOR=80
[[ "$test_files" -ge "$AGENT_NODE_SRC_FLOOR" ]] || {
  echo "FAIL: only $test_files test file(s) under agent-node/src, floor is $AGENT_NODE_SRC_FLOOR" >&2
  exit 1
}

echo "[L0] full agent-node/src unit suite as non-root"
runuser -u node -- env HOME=/home/node \
  bash -lc 'cd /workspace/agent-node && bun test src/' \
  2>&1 | tee /tmp/test725-green.log

grep -Eq '^[[:space:]]*[1-9][0-9]* pass$' /tmp/test725-green.log || {
  echo "FAIL: non-empty pass denominator missing" >&2
  exit 1
}
grep -Eq '^[[:space:]]*0 fail$' /tmp/test725-green.log || {
  echo "FAIL: aggregate suite did not finish with zero failures" >&2
  exit 1
}

# 把「磁盘上有几个」和「bun 跑了几个」绑在一起:范围被悄悄收窄(glob 改了、
# 测试挪进子目录、bun 配置多了个 exclude)时自己变红。
executed=$(grep -Eo 'across [0-9]+ files' /tmp/test725-green.log | grep -Eo '[0-9]+' | tail -1)
echo "executed_files=${executed:-unknown} discovered_files=$test_files"
[[ -n "$executed" && "$executed" -ge "$test_files" ]] || {
  echo "FAIL: bun executed ${executed:-?} file(s) but $test_files exist under src/" >&2
  exit 1
}

# tests/ 下还有 6 个文件,直到现在没有任何 CI 会跑 —— 而这道门的抬头写着
# "complete agent-node unit domain"。补上,让那句话变成真的。
#
# 这个目录里混着两种测试,任何单一命令都跑不全:
#   - 脚本式:自己打 "N/N passed",失败时 process.exit(1),必须 `bun <file>`;
#     用 `bun test` 跑会因为 top-level 的 process.exit 把整个 run 打断在第一个文件。
#   - bun:test 式:describe/it,必须 `bun test <file>`;用 `bun <file>` 跑会报
#     "Cannot use describe outside of the test runner"。
# 所以按文件内容分派。
echo "[L0b] every agent-node/tests file, dispatched by kind"
tdir_total=$(find "$ROOT/agent-node/tests" -maxdepth 1 -type f -name '*.test.ts' | wc -l | tr -d ' ')
tdir_ran=0; tdir_failed=0; tdir_names=""
while IFS= read -r f; do
  rel=${f#"$ROOT"/agent-node/}
  if grep -q 'bun:test' "$f"; then cmd="bun test $rel"; else cmd="bun $rel"; fi
  if runuser -u node -- env HOME=/home/node \
       bash -lc "cd $ROOT/agent-node && $cmd" >"/tmp/test725-tests-$(basename "$f" .test.ts).log" 2>&1; then
    tdir_ran=$((tdir_ran+1))
  else
    tdir_ran=$((tdir_ran+1)); tdir_failed=$((tdir_failed+1))
    tdir_names="$tdir_names $(basename "$f" .test.ts)"
    echo "--- FAILED: agent-node/$rel ---"
    tail -20 "/tmp/test725-tests-$(basename "$f" .test.ts).log"
  fi
done < <(find "$ROOT/agent-node/tests" -maxdepth 1 -type f -name '*.test.ts' | sort)

echo "tests_dir_executed=$tdir_ran tests_dir_discovered=$tdir_total tests_dir_failed=$tdir_failed"
# 🔴 绝对下限:`executed == discovered` 只能抓「runner 跳过了文件」,
# 抓不到「文件消失了」—— 分母会跟着现实自动缩水。见 #798 的实测:
# 删掉 85% 的测试后,只比数量的门照样 PASS。真删了测试就故意改这个数。
AGENT_NODE_TESTS_FLOOR=5
[[ "$tdir_total" -ge "$AGENT_NODE_TESTS_FLOOR" ]] || {
  echo "FAIL: only $tdir_total file(s) under agent-node/tests, floor is $AGENT_NODE_TESTS_FLOOR" >&2
  exit 1
}
[[ "$tdir_ran" -eq "$tdir_total" && "$tdir_total" -gt 0 ]] || {
  echo "FAIL: ran $tdir_ran of $tdir_total files under agent-node/tests" >&2
  exit 1
}
[[ "$tdir_failed" -eq 0 ]] || {
  echo "FAIL: $tdir_failed file(s) failed under agent-node/tests:$tdir_names" >&2
  exit 1
}

echo "[L1] witnessed-red: disconnect readable attachment content from runtime"
TARGET=$'deliverToRuntime: () => processTask(\n            runtimeContent,'
MUTATED=$'deliverToRuntime: () => processTask(\n            content,'
before=$(sha256sum "$ROOT/agent-node/src/cli.ts" | cut -d' ' -f1)
python3 - "$ROOT/agent-node/src/cli.ts" "$TARGET" "$MUTATED" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
target, replacement = sys.argv[2], sys.argv[3]
if source.count(target) != 1:
    raise SystemExit("mutation target count changed")
path.write_text(source.replace(target, replacement, 1))
PY
after=$(sha256sum "$ROOT/agent-node/src/cli.ts" | cut -d' ' -f1)
[ "$before" != "$after" ] || { echo "FAIL: mutation was a byte no-op" >&2; exit 1; }

set +e
runuser -u node -- env HOME=/home/node \
  bash -lc 'cd /workspace/agent-node && bun test src/runtime/readable-attachment-prompt.test.ts' \
  >/tmp/test725-mutation.log 2>&1
mutation_rc=$?
set -e
[ "$mutation_rc" -ne 0 ] || {
  cat /tmp/test725-mutation.log
  echo "FAIL: attachment wiring mutation survived" >&2
  exit 1
}
# 🔴 锚在 (fail) 行:bun test 对每个用例都打 `(pass) <名字>` / `(fail) <名字>`,
# 只 grep 名字的话那条用例**通过**时也会命中,断言就只证明了它存在。
# A/B 见 #798:松版会收下一个根本没打中指名行为的 mutation。
grep -Eq '^\(fail\).*the inbox choke point feeds the augmented text into processTask' /tmp/test725-mutation.log || {
  cat /tmp/test725-mutation.log
  echo "FAIL: mutation red did not reach the named wiring assertion" >&2
  exit 1
}

echo "MUTATION_RED readable-attachment-runtime-disconnected rc=$mutation_rc"
echo "RESULT: PASS"

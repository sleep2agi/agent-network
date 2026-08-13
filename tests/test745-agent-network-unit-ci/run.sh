#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace
SOURCE_COMMIT=${TEST745_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: SOURCE_COMMIT must be one full lowercase Git SHA" >&2
  exit 1
}

echo "# test745 — complete agent-network unit domain"
echo "source_commit=$SOURCE_COMMIT"
echo "bun=$(bun --version) node=$(node --version) git=$(git --version) uid=$(id -u node)"

test_files=$(find "$ROOT/agent-network/src" -type f -name '*.test.ts' | wc -l | tr -d ' ')
[[ "$test_files" =~ ^[1-9][0-9]*$ ]] || {
  echo "FAIL: agent-network test-file denominator is empty" >&2
  exit 1
}
echo "test_files=$test_files"

echo "[L0] full agent-network/src unit suite as non-root"
runuser -u node -- env HOME=/home/node \
  bash -lc 'cd /workspace/agent-network && bun test src/' \
  2>&1 | tee /tmp/test745-green.log

grep -Eq '^[[:space:]]*[1-9][0-9]* pass$' /tmp/test745-green.log || {
  echo "FAIL: non-empty pass denominator missing" >&2
  exit 1
}
grep -Eq '^[[:space:]]*0 fail$' /tmp/test745-green.log || {
  echo "FAIL: aggregate suite did not finish with zero failures" >&2
  exit 1
}
grep -Eq 'Ran [1-9][0-9]* tests across [1-9][0-9]* files\.' /tmp/test745-green.log || {
  echo "FAIL: aggregate test/file summary missing" >&2
  exit 1
}

# 上面那条只要求"跑过的文件数非零" —— 磁盘上有 46 个、bun 只跑了 1 个,
# 它照样绿。test_files 这个分母算出来了却没承重,而"跑了 1 个全绿"和
# "跑了 46 个全绿"打印出来是同一片绿色。把两个数绑在一起,让范围被悄悄
# 收窄(glob 改了、测试挪进子目录、bun 配置多了个 exclude)这件事自己变红。
executed=$(grep -Eo 'across [0-9]+ files' /tmp/test745-green.log | grep -Eo '[0-9]+' | tail -1)
echo "executed_files=${executed:-unknown} discovered_files=$test_files"
[[ -n "$executed" && "$executed" -ge "$test_files" ]] || {
  echo "FAIL: bun executed ${executed:-?} file(s) but $test_files exist under src/" >&2
  exit 1
}


# tests/ 下还有 19 个文件,直到现在没有任何 CI 会跑 —— 而这道门的抬头写着
# "complete agent-network unit domain"。补上,让那句话变成真的。
#
# 这个目录里混着两种测试,任何单一命令都跑不全:
#   - 脚本式:自己打 "N/N passed",失败时 process.exit(1),必须 `bun <file>`;
#     用 `bun test` 跑会因为 top-level 的 process.exit 把整个 run 打断在第一个文件。
#   - bun:test 式:describe/it,必须 `bun test <file>`;用 `bun <file>` 跑会报
#     "Cannot use describe outside of the test runner"。
# 所以按文件内容分派。
echo "[L0b] every agent-network/tests file, dispatched by kind"
tdir_total=$(find "$ROOT/agent-network/tests" -maxdepth 1 -type f -name '*.test.ts' | wc -l | tr -d ' ')
tdir_ran=0; tdir_failed=0; tdir_names=""
while IFS= read -r f; do
  rel=${f#"$ROOT"/agent-network/}
  if grep -q 'bun:test' "$f"; then cmd="bun test $rel"; else cmd="bun $rel"; fi
  if runuser -u node -- env HOME=/home/node \
       bash -lc "cd $ROOT/agent-network && $cmd" >"/tmp/test745-tests-$(basename "$f" .test.ts).log" 2>&1; then
    tdir_ran=$((tdir_ran+1))
  else
    tdir_ran=$((tdir_ran+1)); tdir_failed=$((tdir_failed+1))
    tdir_names="$tdir_names $(basename "$f" .test.ts)"
    echo "--- FAILED: agent-network/$rel ---"
    tail -20 "/tmp/test745-tests-$(basename "$f" .test.ts).log"
  fi
done < <(find "$ROOT/agent-network/tests" -maxdepth 1 -type f -name '*.test.ts' | sort)

echo "tests_dir_executed=$tdir_ran tests_dir_discovered=$tdir_total tests_dir_failed=$tdir_failed"
[[ "$tdir_ran" -eq "$tdir_total" && "$tdir_total" -gt 0 ]] || {
  echo "FAIL: ran $tdir_ran of $tdir_total files under agent-network/tests" >&2
  exit 1
}
[[ "$tdir_failed" -eq 0 ]] || {
  echo "FAIL: $tdir_failed file(s) failed under agent-network/tests:$tdir_names" >&2
  exit 1
}

echo "[L1] witnessed-red: top-level config help must match the implemented parser"
TARGET='  anet config [path|json]       Show config summary, path, or raw JSON'
MUTATED='  anet config get|set          Inspect or edit config'
before=$(sha256sum "$ROOT/agent-network/bin/cli.ts" | cut -d' ' -f1)
python3 - "$ROOT/agent-network/bin/cli.ts" "$TARGET" "$MUTATED" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
target, replacement = sys.argv[2], sys.argv[3]
if source.count(target) != 1:
    raise SystemExit("mutation target count changed")
path.write_text(source.replace(target, replacement, 1))
PY
after=$(sha256sum "$ROOT/agent-network/bin/cli.ts" | cut -d' ' -f1)
[[ "$before" != "$after" ]] || {
  echo "FAIL: mutation was a byte no-op" >&2
  exit 1
}

set +e
runuser -u node -- env HOME=/home/node \
  bash -lc 'cd /workspace/agent-network && bun test src/top-level-help-contract.test.ts' \
  >/tmp/test745-mutation.log 2>&1
mutation_rc=$?
set -e
[[ "$mutation_rc" -ne 0 ]] || {
  cat /tmp/test745-mutation.log
  echo "FAIL: stale config-help mutation survived" >&2
  exit 1
}
grep -Fq 'Expected to contain: "anet config [path|json]"' /tmp/test745-mutation.log || {
  cat /tmp/test745-mutation.log
  echo "FAIL: mutation red did not reach the named help-contract assertion" >&2
  exit 1
}

grep -F 'Expected to contain: "anet config [path|json]"' /tmp/test745-mutation.log
echo "MUTATION_RED stale-config-help rc=$mutation_rc"
echo "RESULT: PASS"

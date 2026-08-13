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
grep -Fq 'the inbox choke point feeds the augmented text into processTask' /tmp/test725-mutation.log || {
  cat /tmp/test725-mutation.log
  echo "FAIL: mutation red did not reach the named wiring assertion" >&2
  exit 1
}

echo "MUTATION_RED readable-attachment-runtime-disconnected rc=$mutation_rc"
echo "RESULT: PASS"

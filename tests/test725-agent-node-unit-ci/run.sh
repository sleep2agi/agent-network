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

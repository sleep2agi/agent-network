#!/usr/bin/env bash
set -euo pipefail

# test792 — agent-network 的聚合单测门(#792)
#
# 为什么需要它:`agent-network/src/` 下有 46 个 *.test.ts,在 #792 之前**没有
# 任何 CI job 会跑它们**。CI 可达套件全集(L0_TESTS 5 + L1_TESTS 16 + workflow
# 里直接 docker build 的 2,去重 18 个)引用了其中 0 个;全仓也不存在"整目录
# bun test"这条后路。于是这些测试在本地是绿的、在 PR 上看不出异常,但改坏了
# 不会有人知道 —— 包括 #739 的 cwd 信任边界回归、RFC-030 的调用顺序门。
#
# 形状抄 tests/test725-agent-node-unit-ci(agent-node 的对应门),差别只有一处:
# 这里只装 agent-network 的依赖,不带 agent-node。

ROOT=/workspace
SOURCE_COMMIT=${TEST792_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: SOURCE_COMMIT must be one full lowercase Git SHA" >&2
  exit 1
}

echo "# test792 — complete agent-network unit domain"
echo "source_commit=$SOURCE_COMMIT"
echo "bun=$(bun --version) node=$(node --version) uid=$(id -u node)"

# 分母先报出来:哪天有人把 src/ 挪走或改了后缀,这个数会自己塌下去,
# 而"跑了 0 个文件全绿"看起来和"跑了 46 个全绿"是同一片绿色。
discovered=$(find "$ROOT/agent-network/src" -name '*.test.ts' | wc -l | tr -d ' ')
echo "discovered_test_files=$discovered"
[ "$discovered" -ge 40 ] || {
  echo "FAIL: expected >=40 agent-network unit test files, found $discovered" >&2
  exit 1
}

echo "[L0] full agent-network/src unit suite as non-root"
runuser -u node -- env HOME=/home/node \
  bash -lc 'cd /workspace/agent-network && bun test src/' \
  2>&1 | tee /tmp/test792-green.log

grep -Eq '^[[:space:]]*[1-9][0-9]* pass$' /tmp/test792-green.log || {
  echo "FAIL: non-empty pass denominator missing" >&2
  exit 1
}
grep -Eq '^[[:space:]]*0 fail$' /tmp/test792-green.log || {
  echo "FAIL: aggregate suite did not finish with zero failures" >&2
  exit 1
}

# 断言 bun 真的走遍了这些文件,而不是只跑了其中几个就报 "0 fail"。
ran=$(grep -Eo 'across [0-9]+ files' /tmp/test792-green.log | grep -Eo '[0-9]+' | tail -1)
echo "files_executed=${ran:-unknown} discovered=$discovered"
[ -n "$ran" ] && [ "$ran" -ge "$discovered" ] || {
  echo "FAIL: bun executed ${ran:-?} files but $discovered exist on disk" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# witnessed-red:证明这个聚合 runner 真的在跑 src/ 下的文件,而不是一个空转的门。
#
# 靶点选 DEFAULT_RUNTIME —— 把它从 claude-agent-sdk 改回 claude-code-cli,
# 正好违反 Vincent 2026-06-28 的"无 Max 军团"默认(claude-code-cli 绑 Max/Pro,
# 非订阅用户会拿到一个起不来的节点)。这是个有语义的回归,不是随手改个字符串。
# ---------------------------------------------------------------------------
echo "[L1] witnessed-red: revert the no-Max default runtime"
TARGET='export const DEFAULT_RUNTIME: RuntimeName = "claude-agent-sdk";'
MUTATED='export const DEFAULT_RUNTIME: RuntimeName = "claude-code-cli";'
SRC="$ROOT/agent-network/src/normalize-runtime.ts"
before=$(sha256sum "$SRC" | cut -d' ' -f1)
python3 - "$SRC" "$TARGET" "$MUTATED" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
target, replacement = sys.argv[2], sys.argv[3]
if source.count(target) != 1:
    raise SystemExit("mutation target count changed")
path.write_text(source.replace(target, replacement, 1))
PY
after=$(sha256sum "$SRC" | cut -d' ' -f1)
[ "$before" != "$after" ] || { echo "FAIL: mutation was a byte no-op" >&2; exit 1; }

set +e
runuser -u node -- env HOME=/home/node \
  bash -lc 'cd /workspace/agent-network && bun test src/normalize-runtime.test.ts' \
  >/tmp/test792-mutation.log 2>&1
mutation_rc=$?
set -e
[ "$mutation_rc" -ne 0 ] || {
  cat /tmp/test792-mutation.log
  echo "FAIL: default-runtime mutation survived" >&2
  exit 1
}
# 红在**指名的那条行为**上,不是红在别处(比如导入失败)。
grep -Fq 'fallback default is claude-agent-sdk' /tmp/test792-mutation.log || {
  cat /tmp/test792-mutation.log
  echo "FAIL: mutation red did not reach the named no-Max default assertion" >&2
  exit 1
}

echo "MUTATION_RED no-max-default-runtime-reverted rc=$mutation_rc"
echo "RESULT: PASS"

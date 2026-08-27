#!/usr/bin/env bash
set -euo pipefail

# 🔴 断言而非打印:拿不到完整 SHA 就 fail closed。
# 打印的话,SOURCE_COMMIT 是 "dev" 时报告照样生成,读的人以为它钉在某个提交上。
[[ "${SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}

ROOT=/workspace
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-$ARTIFACT_DIR/report-test626.txt}"
RUNTIME="$ROOT/agent-node/src/runtime/grok-copresence/runtime.ts"
BACKUP=/tmp/test626-runtime.ts
TARGET_TEST="src/runtime/grok-copresence/slash-gate.test.ts"
TARGET_NAME="incompatible-agent"
RELATED_TESTS=(
  src/runtime/grok-copresence/runtime.test.ts
  src/runtime/grok-copresence/slash-gate.test.ts
)

mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"
exec > >(tee -a "$REPORT") 2>&1

# 🔴 必须放在 `: >"$REPORT"` 和 exec 之后。
# 放在前面会被那一行截断抹掉 —— 我第一版就是这么写的,而且第一次探针
# 只跑到第 26 行(截断在第 28 行),把要测的那件事排除在取值范围外,得到假绿。
# 产物要能自证跑的是哪个提交:报告脱离仓库被人读到时,
# 「哪个 SHA」是它唯一还剩的上下文。
printf 'source_commit=%s\n' "$SOURCE_COMMIT"

echo "# test626 - Grok /model hot switch with restart fallback"
echo "date: $(date -Is)"
echo "mode: pure-bun witnessed-red-green"

cd "$ROOT/agent-node"
node --version
bun --version

cp "$RUNTIME" "$BACKUP"
restore_runtime() {
  cp "$BACKUP" "$RUNTIME"
}
trap restore_runtime EXIT

echo
echo "## witnessed-red: fallback disabled mutation"
python3 - <<'PY'
from pathlib import Path

path = Path("/workspace/agent-node/src/runtime/grok-copresence/runtime.ts")
text = path.read_text()
needle = "      try {\n        const fallback = fallbackGrokModelSwitchRestart();"
replacement = "      try {\n        throw error;\n        const fallback = fallbackGrokModelSwitchRestart();"
if needle not in text:
    raise SystemExit("mutation target not found")
path.write_text(text.replace(needle, replacement, 1))
PY

set +e
bun test "$TARGET_TEST" -t "$TARGET_NAME" 2>&1 | tee /tmp/test626-red.log
red_rc=$?
set -e
if grep -Fq "matched 0 tests" /tmp/test626-red.log; then
  echo "FAIL: witnessed-red selector matched 0 tests"
  exit 1
fi
if [[ "$red_rc" -eq 0 ]]; then
  echo "FAIL: witnessed-red mutation unexpectedly passed"
  exit 1
fi
echo "PASS: witnessed-red mutation failed as expected"

restore_runtime

echo
echo "## green: current source"
bun test "$TARGET_TEST" -t "$TARGET_NAME"
echo "PASS: green fallback test passed"

echo
echo "## full related suite"
bun test "${RELATED_TESTS[@]}"
echo "PASS: full related suite passed"

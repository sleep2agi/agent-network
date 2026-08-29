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
# 🔴 目标必须是【已提交的】文件。第一版指向 slash-gate.test.ts ——
# 那个文件只存在于共享脏树(未提交),`COPY . /workspace` 把脏树拷进镜像时
# 它在,于是作者本地全绿;干净检出里它不存在。
# `incompatible-agent` 的 fallback 断言实际住在 runtime.test.ts:2370。
# 路径带 ./ :bun 1.3.14 把不带 ./ 的参数当 name filter,搜不到就整体退出 1,
# 而那个退出码会被误读成 witnessed-red。
TARGET_TEST="./src/runtime/grok-copresence/runtime.test.ts"
TARGET_NAME="incompatible-agent"
RELATED_TESTS=(
  ./src/runtime/grok-copresence/runtime.test.ts
  ./src/runtime/grok-copresence/model-switch.test.ts
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
# 🔴 needle 必须匹配【已提交的】runtime.ts。第一版的 needle 是
#   "      try {\n        const fallback = ..."
# 那个形状在本分支底(f94fa9d0 之后)的 runtime.ts 里不存在 —— 全文件唯一的
# 调用点在 catch (error) 块里,前面是一行守卫。needle 不匹配时脚本直接
# SystemExit("mutation target not found"),CI 构建后必红;
# 而提交进仓的 report 写着 PASS —— 那份 report 是在别的(更旧的)检出上
# 生成后搬进来的,不是在本分支底上跑出来的。证据要在被评对象上现跑。
#
# 变异语义不变:让 fallback 永远不被走到。
# 🔴 2026-08-29 第二次更新 needle:本分支(#1416/#1413 tail-rearm)把那行守卫从
#    单行 `if (!isGrokModelSwitchFallbackError(error)) throw error;` 改成了带
#    modelSwitchInFlight 清理的多行 if 块,旧 needle 不再匹配 → mutation target
#    not found → CI 红。needle 跟随被评对象(已提交的 runtime.ts)更新;变异仍是
#    去掉 `if (!...)` 条件、让 catch 无条件 throw,fallback 成为死代码。
needle = "      if (!isGrokModelSwitchFallbackError(error)) {\n        this.modelSwitchInFlight = null;\n        throw error;\n      }\n      const fallback = fallbackGrokModelSwitchRestart();"
replacement = "      this.modelSwitchInFlight = null;\n      throw error;\n      const fallback = fallbackGrokModelSwitchRestart();"
if needle not in text:
    raise SystemExit("mutation target not found")
path.write_text(text.replace(needle, replacement, 1))
PY

set +e
bun test "$TARGET_TEST" -t "$TARGET_NAME" 2>&1 | tee /tmp/test626-red.log
red_rc=$?
set -e
# bun 换版本换措辞:1.4.x 是 "matched 0 tests",1.3.x 是
# "did not match any test files"。守卫只认一种时,另一种的退出码 1
# 会被当成变异红 —— 错误理由的红。两种都拦。
if grep -qE "matched 0 tests|did not match any test files" /tmp/test626-red.log; then
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

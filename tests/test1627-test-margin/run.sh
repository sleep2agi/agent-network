#!/usr/bin/env bash
# test1627 / #1627 + #1309 — the per-test timeout **margin instrument's metric
# inputs**, witnessed on the pinned bun instead of asserted:
#
#   1. the IMPLICIT default (bun 1.3.14, no `bunfig.toml`, no `--timeout`) = 5000ms
#   2. an explicit `}, 500)` declaration is honored (450ms passes, 900ms times out)
#   3. a hook that hits its DECLARED 6s timeout is 100% of 6s — not 120% of 5s
#   4. the report is report-only by default and `--fail` is opt-in (qa.sh relies on it)
#   5. qa.sh clears the previous run's `/tmp/qa-l*.log` before it reads them
#
# Plus the instrument's in-process selftest, whose embedded fixtures pin the same
# denominators (that is what makes a regression fail here instead of on a slow runner).
#
# Isolated: `--network none` at run time, no credentials, no daemon, no production
# path. The three real-bun witnesses run **in parallel** so the suite stays ~7s.
set -euo pipefail
unset TMUX TMUX_PANE
source /lib/safe-rm.sh
export ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
mkdir -p "$ARTIFACT_DIR"
exec > >(tee "$ARTIFACT_DIR/report-test1627-test-margin.txt") 2>&1

SCRIPT=/suite/check-test-margin.py
FIX=/suite/fixtures
W=/tmp/test1627-margin
FAILED=0
fail() { echo "FAIL: $*" >&2; FAILED=$((FAILED + 1)); }
note() { echo "· $*"; }
indent() { sed 's/^/    /'; }

# 🔴 打印见证时**必须去掉方括号**。qa.sh 把本套件的 stdout tee 进
#    `/tmp/qa-l1-*-run.log`，而 margin hook 按 glob 读那个文件 ⇒ 夹具里那句
#    `(fail) implicit default [5000.01ms]` 会**永久**以 100% 出现在每一轮真实
#    报告里，看起来像一个常驻高危测试。写成 `5000.01ms` 就不再被解析（解析器
#    要的是行尾的 `[<ms>ms]`），而证据照样人眼可读。
unbracket() { sed -E 's/\[([0-9.]+)ms\]/\1ms/g'; }

echo "test1627 test-margin source=${SOURCE_COMMIT:-unset} date=$(date -Is)"
# SHA 绑定不是装饰：`ARG SOURCE_COMMIT` 声明了它，qa.sh 就会自动供给（见 qa.sh 里
# 那段「从 Dockerfile 读 ARG 名」——把套件加进 L1_TESTS 却忘了绑定是**静默**的）。
if [[ -z "${SOURCE_COMMIT:-}" ]]; then
  fail "SOURCE_COMMIT 未注入：镜像与实际 commit 没有绑定（qa.sh 会供，本地手跑要 --build-arg）"
fi

safe_rm_rf "$W"
mkdir -p "$W"

note '0) 仪表自证（内嵌夹具：默认解析 / 声明解析 / 正控 / 负控 / 钩子 / 显式 20s 覆盖）'
if ! python3 "$SCRIPT" --selftest | indent; then
  fail "selftest 未通过"
fi

note '1/2/3) 真 bun 见证（并行：无声明 5s、声明 500ms、声明 6s 的钩子）'
( cd "$FIX" && bun test implicit-default.test.ts >"$W/implicit.log" 2>&1 || true ) & p1=$!
( cd "$FIX" && bun test declared-500.test.ts >"$W/declared.log" 2>&1 || true ) & p2=$!
( cd "$FIX" && bun test hook-6s.test.ts >"$W/hook.log" 2>&1 || true ) & p3=$!
wait $p1 $p2 $p3

echo '--- implicit.log'
indent < <(tail -8 "$W/implicit.log" | unbracket)
echo '--- declared.log'
indent < <(grep -E '\(pass\)|\(fail\)|timed out' "$W/declared.log" | unbracket)
echo '--- hook.log'
indent < <(grep -E '\(fail\)|timed out' "$W/hook.log" | unbracket)

# ── 1) 隐式默认 = 5000ms（不是 20000ms） ───────────────────────────────────
note '4) 隐式默认：仪表必须按 5000ms 判，且用 20000ms 时必须能复现「被静默略过」'
python3 "$SCRIPT" --logs "$W/implicit.log" --root "$FIX" --pct 50 | indent
python3 "$SCRIPT" --logs "$W/implicit.log" --root "$FIX" --pct 50 >"$W/implicit.margin" || true
python3 "$SCRIPT" --logs "$W/implicit.log" --root "$FIX" --pct 50 --default-ms 20000 \
  >"$W/implicit.wrong" || true
if ! grep -q 'timed out after 5000ms' "$W/implicit.log"; then
  fail "钉死的 bun 1.3.14 隐式默认不再是 5000ms（读数见上）—— 常量必须跟着改"
fi
if ! grep -q 'near=1' "$W/implicit.margin"; then
  fail "撞满 5000ms 默认的那条必须进贴上限集合（分母错则会被静默略过）"
fi
if ! grep -q 'near=0' "$W/implicit.wrong"; then
  fail "反向见证：按 20000ms 判时同一条必须被静默略过（#1309 评审第 ① 条要可复现）"
fi

# ── 2) 显式 500ms 被采纳 ──────────────────────────────────────────────────
note '5) 显式 500ms：450ms 该报 ~90%、900ms 撞满 100%，两条都进集合'
python3 "$SCRIPT" --logs "$W/declared.log" --root "$FIX" --pct 50 | indent
python3 "$SCRIPT" --logs "$W/declared.log" --root "$FIX" --pct 50 >"$W/declared.margin" || true
if ! grep -q 'timed out after 500ms' "$W/declared.log"; then
  fail "显式 500ms 声明没有被 bun 采纳（前提变了，本条见证要重写）"
fi
if ! grep -qE '/ 500ms = 9[0-9]\.' "$W/declared.margin"; then
  fail "450ms/500ms 必须报 ~90%（分母 500ms）—— 旧的 >=1000 守卫会把它丢掉"
fi
if ! grep -q 'near=3' "$W/declared.margin"; then
  fail "450ms（多行过）/ 900ms（撞 500ms）/ 450ms（单行过）三条都该进贴上限集合"
fi
# 🔴 评审见证的**原样**写法：单行 `test("…", () => { … }, 500);`。
#    只认「行首 `}`」的解析器看不到它 ⇒ 450ms 会被算成 450/5000 = 9%。
if ! grep -qE '/ 500ms = 9[0-9]\..*:: one line 500 takes 450' "$W/declared.margin"; then
  fail "单行 `test(\"one line 500 takes 450\", … , 500);` 必须按 500ms 判（评审见证的原文写法）"
fi

# ── 3) 钩子撞满它**声明**的超时 ───────────────────────────────────────────
note '6) 钩子：声明 6s 撞满必须报 100%（分母 = 它撞上的 6000ms），不是 120%'
python3 "$SCRIPT" --logs "$W/hook.log" --root "$FIX" --pct 50 | indent
python3 "$SCRIPT" --logs "$W/hook.log" --root "$FIX" --pct 50 >"$W/hook.margin" || true
if ! grep -q 'hook timed out' "$W/hook.log"; then
  fail "钩子超时的日志形状变了（「消息里没有数字」这个前提要重新核）"
fi
if ! grep -qE '/ 6000\.[0-9]+ms = 100\.' "$W/hook.margin"; then
  fail "声明 6s 的钩子撞满必须报 100%（分母 = 6000ms）"
fi

# ── 4) report-only 的退出码（qa.sh 的 hook 依赖它） ────────────────────────
note '7) 退出码：默认 report-only（0），--fail 才 1'
if ! python3 "$SCRIPT" --logs "$W/declared.log" --root "$FIX" --pct 50 >/dev/null; then
  fail "不给 --fail 时必须退出 0（report-only）"
fi
if python3 "$SCRIPT" --logs "$W/declared.log" --root "$FIX" --pct 50 --fail >/dev/null 2>&1; then
  fail "给了 --fail 且有贴上限条目时必须退出 1"
fi

# ── 5) qa.sh 启动时清掉上一轮的日志 ───────────────────────────────────────
# 复用的 runner 上，`/tmp/qa-l0-*.log` / `/tmp/qa-l1-*-run.log` 会留下**上一轮**
# 的套件记录，报告里的 tests/near/slowest 就会描述本次没跑的套件。
note '8) qa.sh 必须在启动时清掉上一轮遗留的日志（否则报告会描述没跑的套件）'
CL=$(grep -nF 'rm -f /tmp/qa-l0-' /suite/qa.sh | head -1 | cut -d: -f1 || true)
# 必须找**调用**那一行,不是任何提到脚本名字的地方（L1_TESTS 的注释里就有一次,
# 第一版正是被它骗过:拿到的是注释行号,清理「看起来」在 hook 之后）。
HK=$(grep -nF 'python3 "$REPO_ROOT/scripts/check-test-margin.py"' /suite/qa.sh | head -1 | cut -d: -f1 || true)
if [[ -z "$CL" || -z "$HK" || "$CL" -ge "$HK" ]]; then
  fail "qa.sh 里没有「启动清日志」，或它不在 margin hook 之前（CL=$CL HK=$HK）"
else
  echo '(pass) stale from an earlier run [99999.00ms]' >/tmp/qa-l0-stale.log
  sed -n "${CL}p" /suite/qa.sh >"$W/cleanup.sh"
  echo "  (执行 qa.sh 第 ${CL} 行：$(cat "$W/cleanup.sh"))"
  bash "$W/cleanup.sh"
  if [[ -e /tmp/qa-l0-stale.log ]]; then
    fail "qa.sh 的启动清理没有真的删掉遗留日志"
  fi
fi

echo
if [[ $FAILED -eq 0 ]]; then
  echo 'PASS: per-test timeout margin metric suite（本套件只验仪表的分母,不改任何测试的超时）'
else
  echo "FAILED=$FAILED" >&2
  exit 1
fi

#!/usr/bin/env bash
set -euo pipefail

LOG_FILE=${1:-}
RUNNER_RC=${2:-}
readonly MIN_PASS=283

if [[ -z "$LOG_FILE" || ! -s "$LOG_FILE" ]]; then
  echo "ERROR: test-all.sh produced no output" >&2
  exit 1
fi
if [[ ! "$RUNNER_RC" =~ ^[0-9]+$ ]]; then
  echo "ERROR: invalid or missing runner exit code: ${RUNNER_RC:-<empty>}" >&2
  exit 1
fi
mapfile -t total_lines < <(grep -F 'TOTAL: ' "$LOG_FILE" || true)
if (( ${#total_lines[@]} != 1 )); then
  echo "ERROR: expected exactly one structured TOTAL line, found ${#total_lines[@]}" >&2
  exit 1
fi

total_line=${total_lines[0]}
if [[ ! "$total_line" =~ TOTAL:\ ([0-9]+)\ passed,\ ([0-9]+)\ failed ]]; then
  echo "ERROR: malformed TOTAL line" >&2
  exit 1
fi
passed=${BASH_REMATCH[1]}
failed=${BASH_REMATCH[2]}

echo "runner exit code: $RUNNER_RC"
echo "$total_line"

# 🔴 先看有没有套件**压根没跑**，再看总数够不够（#924）。
#
# 这两件事在 `passed < MIN_PASS` 这一句里长得一模一样：
#     ① 某个套件早退了（Results 行缺失，0 ran）—— 基础设施/时序问题
#     ② 有人删了一个测试            —— 代码问题
# 而下限余量只有 1（MIN_PASS=283，稳定值 284），所以两者都会红在同一句
# 「incomplete regression: N passes is below minimum 283」上，读日志的人分不出
# 该去查 Docker 还是去查 diff。
#
# runner 其实已经把答案打印出来了（tests/test-all.sh:37 那行 SKIPPED/CRASHED），
# 只是这道门从来没看过它。看一眼就够。
mapfile -t crashed_lines < <(grep -F 'SKIPPED/CRASHED' "$LOG_FILE" || true)
if (( ${#crashed_lines[@]} > 0 )); then
  echo "ERROR: ${#crashed_lines[@]} suite(s) never ran — this is NOT a missing test, it is a suite that exited early:" >&2
  printf '  %s\n' "${crashed_lines[@]}" >&2
  echo "  ⇒ 去查那个套件的容器/时序，不要去 diff 里找被删掉的测试。" >&2
  exit 1
fi

if (( passed < MIN_PASS )); then
  echo "ERROR: incomplete regression: $passed passes is below minimum $MIN_PASS" >&2
  echo "  没有套件报 SKIPPED/CRASHED，所以这多半是【用例数真的少了】，不是某个套件没跑。" >&2
  exit 1
fi
if (( failed > 0 )); then
  echo "ERROR: Docker E2E reported $failed failing tests" >&2
  exit 1
fi
if (( RUNNER_RC != 0 )); then
  echo "ERROR: Docker E2E runner exited non-zero ($RUNNER_RC)" >&2
  exit 1
fi

echo "PASS: full Docker E2E regression is complete and green"

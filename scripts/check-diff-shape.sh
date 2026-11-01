#!/usr/bin/env bash
# 改动形状门：**声明的增删行数**必须等于**实际的增删行数**。
#
# 2026-10-31 —— 外部复核 ②（原话）：
#   「只改该改的测试文件时，git diff --numstat 的删除行数必须是 0
#     ⇒ 删除 > 0 且你没有『删测试』这个意图 ⇒ 停下手工看 diff，不要提交」
#   「把『我需要检查』换成一个结合时能停下动作的数 —— 前者靠自觉，后者靠机制。」
#
# 为什么不是「记得看 diff」：那次事故里，测试总数 31 → 31（新增 2、删除 2），
# **看总数看不出任何异常**；而 numstat 的删除行数在同一时刻是 47。
#
# 用法：
#   scripts/check-diff-shape.sh --added 12 --deleted 3
#   scripts/check-diff-shape.sh --added 0 --deleted 0 --range origin/main..HEAD
#
# 2026-10-31 —— **加的第二个问题**：「你改的那个东西，它自己的门是绿的么？」
#   起因：我加了 scripts/report-type-assertions.py，`check-gates-wired.py` 当场红了两条提交。
#   我提交前跑的是「覆盖率 / 清单 / 路由表」—— 我习惯的那三个，不是「我改动所影响的那一个」。
#   ⇒ 只要 diff 里有 scripts/ 下的文件，就在提交前**真的执行**接线门（实测 1.0s，不阻塞）。
#   换个说法：不是让作者记得跑更多门，是让门跟着**改动范围**自己出现。
#
# 退出码：
#   0 = 与声明一致（且 scripts/ 有改动时接线门是绿的）
#   1 = 与声明不一致，或 scripts/ 有改动而接线门是红的（**在提交前**就该看到这个）
#   2 = 没有声明增删数（= 没有读数：本门拒绝在「没说要改多少」的情况下给通过）

set -uo pipefail

ADDED=""
DELETED=""
RANGE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --added)   ADDED="${2:-}"; shift 2 ;;
    --deleted) DELETED="${2:-}"; shift 2 ;;
    --range)   RANGE="${2:-}"; shift 2 ;;
    --selftest) SELFTEST=1; shift ;;
    *) echo "用法: $0 --added N --deleted M [--range A..B]" >&2; exit 2 ;;
  esac
done

if [ "${SELFTEST:-0}" = "1" ]; then
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  git -C "$tmp" init -q
  git -C "$tmp" config user.email t@t; git -C "$tmp" config user.name t
  printf 'a\nb\nc\n' > "$tmp/f.txt"
  git -C "$tmp" add f.txt && git -C "$tmp" commit -qm base
  # 改：加两行、删一行
  printf 'a\nB\nc\nd\ne\n' > "$tmp/f.txt"
  fails=0
  out=$(cd "$tmp" && bash "$SELF" --added 3 --deleted 1 2>&1); rc=$?
  [ "$rc" -eq 0 ] && echo "✓ selftest 声明 3/1 与实际 3/1 一致 ⇒ exit 0" || { echo "✗ selftest 一致却报错: $out"; fails=$((fails+1)); }
  out=$(cd "$tmp" && bash "$SELF" --added 3 --deleted 0 2>&1); rc=$?
  # 2026-10-31 —— 只断言退出码会让「崩溃」也算红（外部复核：「非零即红对今天的崩溃已经绿了」）。
  # 因此同时断言**理由串**：形状不符时必须说「与声明不一致」，而不是 traceback。
  if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "与声明不一致"; then
    echo "✓ selftest 声明删除 0 但实际删 1 ⇒ exit 1 且理由是「与声明不一致」"
  else
    echo "✗ selftest 不一致却通过或缺理由串: $out"; fails=$((fails+1))
  fi
  out=$(cd "$tmp" && bash "$SELF" 2>&1); rc=$?
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "没有声明"; then
    echo "✓ selftest 不声明 ⇒ exit 2 且理由是「没有声明」（没有读数）"
  else
    echo "✗ selftest 不声明也给了结论 / 缺理由串"; fails=$((fails+1))
  fi
  # 第二条判据：scripts/ 有改动时，接线门必须被**真的执行**（用假门证明它被执行且能红）
  mkdir -p "$tmp/scripts" && printf 'x\n' > "$tmp/scripts/report-new.py"
  out=$(cd "$tmp" && GATES_WIRED_CMD=false bash "$SELF" --added 3 --deleted 1 2>&1); rc=$?
  if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "接线门是红的"; then
    echo "✓ selftest scripts/ 有改动 + 接线门红 ⇒ exit 1 且理由指向接线门"
  else
    echo "✗ selftest scripts/ 有改动但接线门没被执行/没红: $out"; fails=$((fails+1))
  fi
  out=$(cd "$tmp" && GATES_WIRED_CMD=true bash "$SELF" --added 3 --deleted 1 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "✓ selftest scripts/ 有改动 + 接线门绿 ⇒ 仍 exit 0（不把正常提交挡死）"
  else
    echo "✗ selftest 接线门绿却挡住提交: $out"; fails=$((fails+1))
  fi
  # 版本文档：改动 docs-site/ ⇒ 版本文档门必须被真的执行
  mkdir -p "$tmp/docs-site/guide" && printf 'x\n' > "$tmp/docs-site/guide/g.md"
  # 同时给 GATES_WIRED_CMD=true：临时仓里没有真接线门，上一组的 scripts/report-new.py 还在
  out=$(cd "$tmp" && GATES_WIRED_CMD=true DOC_CLAIMS_CMD=false bash "$SELF" --added 3 --deleted 1 2>&1); rc=$?
  if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "版本文档门的自检是红的"; then
    echo "✓ selftest docs-site 有改动 + 版本文档门红 ⇒ exit 1 且理由指向该门"
  else
    echo "✗ selftest docs-site 有改动但版本文档门没被执行/没红: $out"; fails=$((fails+1))
  fi
  [ "$fails" -eq 0 ] && { echo "✓ selftest 6/6 通过"; exit 0; }
  exit 1
fi

if [ -z "$ADDED" ] || [ -z "$DELETED" ]; then
  echo "✗ 没有声明 --added/--deleted：本门不接受「没说要改多少」的改动" >&2
  echo "  ⇒ 先想清楚这次该增几行、删几行（删除 0 是最常见也最该被声明的值）。" >&2
  exit 2
fi

if [ -n "$RANGE" ]; then
  numstat=$(git diff --numstat "$RANGE")
else
  numstat=$(git diff --numstat; git diff --cached --numstat)
fi

act_add=$(printf '%s\n' "$numstat" | awk 'NF>=2 && $1 ~ /^[0-9]+$/ {s+=$1} END{print s+0}')
act_del=$(printf '%s\n' "$numstat" | awk 'NF>=2 && $2 ~ /^[0-9]+$/ {s+=$2} END{print s+0}')
files=$(printf '%s\n' "$numstat" | awk 'NF>=2 && $1 ~ /^[0-9]+$/ {n++} END{print n+0}')

echo "改动形状：$files 个文件，实际 +$act_add / -$act_del；声明 +$ADDED / -$DELETED"
if [ "$act_add" -ne "$ADDED" ] || [ "$act_del" -ne "$DELETED" ]; then
  echo "✗ 与声明不一致 —— 先回答：这些多出来/少掉的删行是谁删的？" >&2
  echo "  ⇒ 若是「整段替换」误伤，回去看 diff；若确实要删，把 --deleted 改成你打算删的数。" >&2
  exit 1
fi
echo "✓ 与声明一致"
if [ "$act_del" -gt 0 ]; then
  echo "  ⚠ 删了 $act_del 行：确认每一处删除都是本次意图（尤其带测试的文件）。"
fi

# 第二步：改动了 scripts/ ⇒ 接线门必须**真的跑过且绿**。
# GATES_WIRED_CMD 只为 selftest 留口（默认就是真门）；不是给作者绕过用的开关。
if [ -n "$RANGE" ]; then
  touched=$(git diff --name-only "$RANGE")
else
  # 含 untracked：新加的脚本在 `git add` 之前正是最容易被忘掉的那个状态
  touched=$( { git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } )
fi
if printf '%s\n' "$touched" | grep -q '^scripts/'; then
  out=$(${GATES_WIRED_CMD:-python3 scripts/check-gates-wired.py} 2>&1); grc=$?
  if [ "$grc" -ne 0 ]; then
    echo "✗ 本次改动了 scripts/，而接线门是红的 —— 提交前必须绿：" >&2
    # 2026-11-01 —— 只 grep '✗' 会把「门跑不起来」显示成「门是红的但没有原因」。
    # 实测：PATH 里没有 node 时 check-gates-wired.py 抛 FileNotFoundError、rc=1，
    # 而输出里一行 ✗ 都没有 —— 读起来与「接线真的错了」同形，处理方式却相反（查环境）。
    if printf '%s\n' "$out" | grep -qE '✗'; then
      printf '%s\n' "$out" | grep -E '✗' | head -6 >&2
    else
      echo "  ⇒ 门没给出任何 ✗ —— 它多半是**没跑起来**（环境/依赖），不是接线错。末尾输出：" >&2
      printf '%s\n' "$out" | tail -5 | sed 's/^/    /' >&2
    fi
    echo "  ⇒ 新脚本要进 workflow，或在 KNOWN_UNWIRED 里登记 [tag] 理由 + 移出条件。" >&2
    exit 1
  fi
  echo "✓ scripts/ 有改动：接线门已执行且绿"
fi

# 第三步：改动了**版本文档**（docs-site/** 或发布说明）⇒ 版本文档门必须跑过且绿。
# 2026-10-31 —— 这一条是当天第二次栽的同一个跟头：dispatch 前我只跑了本地测试，
# 于是 gate 3（发布说明缺文件）与 gate 4（getting-started 仍断言 .201）在 CI 上才红。
# 两者的输入都在这条 diff 里 ⇒ 门应当**跟着改动范围**自己出现，而不是等我记得。
if printf '%s\n' "$touched" | grep -qE '^(docs-site/|docs/tests/release-)'; then
  out=$(${DOC_CLAIMS_CMD:-python3 scripts/check-doc-version-claims.py --selftest} 2>&1); drc=$?
  if [ "$drc" -ne 0 ]; then
    echo "✗ 本次改动了版本文档，而版本文档门的自检是红的：" >&2
    printf '%s\n' "$out" | tail -6 >&2
    exit 1
  fi
  echo "✓ 版本文档有改动：check-doc-version-claims --selftest 已执行且绿"
  echo "  ⚠ 它只查**结构**（戳与正文是否自洽）；「戳指着正在发的那个版本」要发版前带 --version 跑。"
fi
exit 0

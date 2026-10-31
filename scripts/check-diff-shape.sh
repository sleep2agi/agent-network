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
# 退出码：
#   0 = 与声明一致
#   1 = 与声明不一致（**在提交前**就该看到这个）
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
  [ "$rc" -eq 1 ] && echo "✓ selftest 声明删除 0 但实际删 1 ⇒ exit 1" || { echo "✗ selftest 不一致却通过: $out"; fails=$((fails+1)); }
  out=$(cd "$tmp" && bash "$SELF" 2>&1); rc=$?
  [ "$rc" -eq 2 ] && echo "✓ selftest 不声明 ⇒ exit 2（没有读数）" || { echo "✗ selftest 不声明也给了结论"; fails=$((fails+1)); }
  [ "$fails" -eq 0 ] && { echo "✓ selftest 3/3 通过"; exit 0; }
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
exit 0

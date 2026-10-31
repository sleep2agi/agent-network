#!/usr/bin/env bash
# 对照运行：同一个命令，在**当前工作树**与**HEAD 的干净副本**上各跑一次。
#
# 2026-10-31 —— 外部复核 ①（原话）：
#   「任何『改一个变量』之前，先做一次『什么都不改』。
#     问：那个页面现在原样刷新一次，还报不报？
#     好了 ⇒ 问题是时间相关的 ⇒ 三条腿全都不用查；仍报 ⇒ 才是稳定复现。」
#   「改一个变量之前，先证明不改也会仍然坏。最便宜的阳性对照，成本一次刷新。」
#
# 用法：
#   scripts/check-control-run.sh python3 scripts/check-keyset-join.py
#   scripts/check-control-run.sh --strict python3 scripts/check-keyset-join.py   # 基线红就算失败
#
# 读数矩阵（这是本脚本唯一要输出的东西）：
#   HEAD 绿 + 当前绿  ⇒ 与你无关（或者你的改动没有影响）
#   HEAD 绿 + 当前红  ⇒ **你的改动弄红的**（这才是可归因的红）
#   HEAD 红 + 当前红  ⇒ 基线本来就红 —— 你的红不是你的（先修基线）
#   HEAD 红 + 当前绿  ⇒ 你顺手修好了基线
#
# 退出码：
#   0 = HEAD 绿且当前绿
#   1 = 当前红（无论基线如何；矩阵在输出里说明能不能归因）
#   2 = 没有读数（无法建 worktree / 命令不存在）
#
# 限制（必须写明，否则这个工具会被误用）：
#   · 干净副本通过 `git worktree add --detach` 建，**没有 node_modules / dist** ⇒
#     适合 python 脚本类门，不适合 bun test（除非仓库自带依赖）。
#   · 副本里跑的是 HEAD 提交，**不包含未提交改动** —— 这既是它的意义，也是它的边界。

set -uo pipefail

STRICT=0
if [ "${1:-}" = "--strict" ]; then STRICT=1; shift; fi

if [ $# -eq 0 ]; then
  echo "用法: $0 [--strict] <命令...>" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "✗ 不在 git 仓库里" >&2; exit 2; }
cd "$ROOT"

run_in() {  # $1 = 目录
  local dir="$1"; shift
  ( cd "$dir" && "$@" >/dev/null 2>&1 )
}

# 当前树
if run_in "$ROOT" "$@"; then NOW=0; else NOW=$?; fi

# HEAD 干净副本
WT="$(mktemp -d)"
cleanup() { git worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$WT"; }
trap cleanup EXIT

if ! git worktree add --detach "$WT" HEAD >/dev/null 2>&1; then
  echo "✗ 无法创建 HEAD 副本（worktree add 失败）⇒ 没有对照读数" >&2
  exit 2
fi

if run_in "$WT" "$@"; then HEAD_RC=0; else HEAD_RC=$?; fi

echo "对照矩阵（命令：$*）"
echo "  HEAD  (@$(git rev-parse --short HEAD))  rc=$HEAD_RC"
echo "  当前  工作树                          rc=$NOW"
if [ "$HEAD_RC" -eq 0 ] && [ "$NOW" -eq 0 ]; then
  echo "  ⇒ 两边都绿：这次红不红与你的改动无关（或改动未影响该门）"
  exit 0
fi
if [ "$HEAD_RC" -eq 0 ] && [ "$NOW" -ne 0 ]; then
  echo "  ⇒ **你的改动弄红的**（HEAD 绿、当前红）—— 这才是可归因的红"
  exit 1
fi
if [ "$HEAD_RC" -ne 0 ] && [ "$NOW" -ne 0 ]; then
  echo "  ⇒ 基线本来就红：当前的红**不能**归因给你的改动（先把基线修绿）"
  [ "$STRICT" -eq 1 ] && exit 1
  exit 0
fi
echo "  ⇒ 你把基线修好了（HEAD 红、当前绿）"
exit 0

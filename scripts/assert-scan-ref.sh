#!/usr/bin/env bash
# 在扫仓库之前，先证明你扫的是你以为的那个 ref。
#
# 🔴 为什么需要它（2026-08-18，同一天里两次）：
#
#   ① 我扫 agent-network-app 找泄漏，报出一条「公开仓里的活泄漏」。是假的 ——
#      本地检出停在 `feat/login-states`，落后 origin/main 4 个提交，那条早被清掉了。
#   ② 更早一次：一个检出落后 main 801 个提交，同一条判据数出来少了 3 倍。
#
#   两次的共同点：**所有命令都成功**。没有任何东西提示我扫错了对象 ——
#   命令顺利跑完，给出一个看起来完全合理的结果，只是结果对应的不是我以为的坐标系。
#
#   靠「记得先 git fetch」是不够的：这条纪律我已经记在案，今天仍然又犯了一次，
#   而且第二次的规模更小（4 个提交，不是 801 个），更不容易察觉。
#
# 用法（放在任何审计脚本的第一行）：
#
#     bash scripts/assert-scan-ref.sh            # 断言当前树 == origin/main
#     bash scripts/assert-scan-ref.sh --report   # 只打印，不退出（给人看）
#     bash scripts/assert-scan-ref.sh --selftest
#
# 🔴 调用方注意：**不要让它的退出码穿过管道**。
#     bash scripts/assert-scan-ref.sh | head; echo $?   ← 这里的 $? 是 head 的
#   写这个脚本的当天，我在验证它的时候就这么写了一次，三个用例全打印 rc=0，
#   而真实退出码是 1/1/0。**一个会说谎的退出码，会先骗过写检查的人。**
#   正确写法：
#     bash scripts/assert-scan-ref.sh || exit 1
#     bash scripts/assert-scan-ref.sh >/dev/null 2>&1; rc=$?
#
# 退出码：
#     0  HEAD == origin/main（可以放心扫）
#     1  HEAD ≠ origin/main（落后 / 领先 / 在别的分支）
#     2  判不了（不是 git 仓、没有 origin/main、git 不可用）
#
# 🔴 它**不会**替你 fetch。fetch 是一次网络写操作，审计脚本不该偷偷做；
#    但它会告诉你 origin/main 这个引用本身有多旧 —— 因为「HEAD 等于一个三天前
#    抓下来的 origin/main」和「HEAD 等于真正的 main」是两件事，而它们看起来一样。
set -uo pipefail

MODE="${1:-assert}"

if [ "$MODE" = "--selftest" ]; then
  fail=0
  t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
  ck() { # name expect_rc dir
    ( cd "$2" && bash "$SELF" >/dev/null 2>&1 ); rc=$?
    if [ "$rc" = "$3" ]; then echo "  ok   $1   [rc=$rc]"; else echo "  FAIL $1   [rc=$rc want=$3]"; fail=1; fi
  }
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  mkdir -p "$t/notgit"
  ck "不是 git 仓 → 2" "$t/notgit" 2
  git init -q "$t/repo" && cd "$t/repo"
  git config user.email t@t; git config user.name t
  echo a > a.txt && git add a.txt && git commit -qm a
  cd - >/dev/null
  ck "没有 origin/main → 2" "$t/repo" 2
  ( cd "$t/repo" && git update-ref refs/remotes/origin/main HEAD )
  ck "HEAD == origin/main → 0" "$t/repo" 0
  ( cd "$t/repo" && echo b > b.txt && git add b.txt && git commit -qm b )
  ck "HEAD 领先 origin/main → 1" "$t/repo" 1
  ( cd "$t/repo" && git update-ref refs/remotes/origin/main HEAD && git checkout -q -b side && echo c > c.txt && git add c.txt && git commit -qm c )
  ck "在别的分支且已分叉 → 1" "$t/repo" 1
  echo "selftest: $([ $fail = 0 ] && echo 'all ok' || echo 'FAILED')"
  exit $fail
fi

command -v git >/dev/null 2>&1 || { echo "assert-scan-ref: 没有 git，判不了" >&2; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "assert-scan-ref: 不是 git 仓，判不了" >&2; exit 2; }

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || { echo "assert-scan-ref: 读不到 HEAD" >&2; exit 2; }
MAIN_SHA=$(git rev-parse origin/main 2>/dev/null) || {
  echo "assert-scan-ref: 这个仓没有 origin/main —— 判不了你扫的是什么" >&2; exit 2; }

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo '?')
AHEAD=$(git rev-list --count "origin/main..HEAD" 2>/dev/null || echo '?')

# origin/main 这个引用自己有多旧。FETCH_HEAD 的 mtime 是最后一次 fetch 的时间。
FETCH_AGE="未知（本仓没有 FETCH_HEAD）"
FH="$(git rev-parse --git-dir)/FETCH_HEAD"
if [ -f "$FH" ]; then
  now=$(date +%s); then_=$(stat -c %Y "$FH" 2>/dev/null || echo "$now")
  FETCH_AGE="$(( (now - then_) / 60 )) 分钟前"
fi

echo "assert-scan-ref:"
echo "  HEAD        $(git rev-parse --short HEAD)   (${BRANCH})"
echo "  origin/main $(git rev-parse --short origin/main)"
echo "  距离        落后 ${BEHIND} / 领先 ${AHEAD}"
echo "  上次 fetch  ${FETCH_AGE}   ← origin/main 只和这个时刻一样新"

[ "$MODE" = "--report" ] && exit 0

if [ "$HEAD_SHA" != "$MAIN_SHA" ]; then
  echo "::error::你扫的不是 origin/main（落后 ${BEHIND} / 领先 ${AHEAD}，分支 ${BRANCH}）。" >&2
  echo "  在这棵树上得出的结论不能当成「main 上的事实」—— 而且它不会报错，只会给你一个看起来合理的错答案。" >&2
  echo "  要么 git fetch origin main 再切过去，要么用 git worktree add --detach <dir> origin/main。" >&2
  exit 1
fi
exit 0

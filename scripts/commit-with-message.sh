#!/usr/bin/env bash
# 提交助手：把「先写消息再提交」这条链上三个静默失败面各堵一处。
#
# ## 为什么需要它（都是实测过的）
#
# 2026-11-01 —— 一次提交的标题写着 `SCOPE 块`，而 diff 是 `qa.sh` 的汇总行。
#   成因不是「写错了」，是**写消息那一步根本没跑**：
#       git add … && cat > /tmp/msg.txt <<'EOF' … EOF && git commit -F /tmp/msg.txt
#   `git add` 因 PATH 里没有 git 失败 ⇒ && 短路 ⇒ cat 没执行 ⇒
#   git commit 用了**上一次遗留的同名文件** ⇒ 提交成功，外形与正确写入完全一样。
#
# ⇒ 一个「先写消息再提交」的链，若写消息那一步可以被短路跳过，
#   就会静默复用上一次的消息。而它的错误粒度不是「写错」，是「没写」而看起来像写了。
#
# ## 本脚本堵的三个面
#
#   ① 消息先落到 `mktemp` 的**新文件**（不是复用一个长期存在的路径），
#      写完校验非空 —— 空消息直接死，不会提交。
#   ② `Diff-Shape: +A/-D` 必须与 `git diff --cached --numstat` 一致 —— 声明与事实不符即死。
#   ③ 标题里提到的**路径**必须真的出现在这次 staged 文件里（存在性，不判语义）——
#      否则「标题说改 A、实际改 B」这种只有同时看两者才发现得了的错，会一路进历史。
#
# ## 用法
#
#   bash scripts/commit-with-message.sh <<'EOF'
#   feat(x): 标题
#
#   正文…
#
#   Diff-Shape: +12/-3
#   EOF
#
# 退出码：0 = 已提交；1 = 预检失败（未提交）；2 = 环境问题（不在仓库/git 缺失）。
set -uo pipefail

MOD="-"
die() { echo "✗ $*" >&2; exit 1; }
env_die() { echo "✗ $*" >&2; exit 2; }

command -v git >/dev/null 2>&1 || env_die "找不到 git（PATH=$PATH）—— 这类失败会让 && 链短路，正是本脚本要堵的那一格"
git rev-parse --git-dir >/dev/null 2>&1 || env_die "不在 git 仓库里"

# ① 新文件 + 非空校验（err 级：写不进去就不提交）
msg=$(mktemp "${TMPDIR:-/tmp}/commitmsg.XXXXXXXX") || env_die "mktemp 失败"
trap 'rm -f "$msg"' EXIT
cat > "$msg" || die "从 stdin 读消息失败"
[ -s "$msg" ] || die "消息为空 —— 拒绝提交（空消息在历史里无法与「忘了写」区分）"

# ③ 标题里的路径必须出现在 staged 集合里
subj=$(grep -m1 -v '^[[:space:]]*$' "$msg")
staged=$(git diff --cached --name-only)
[ -n "$staged" ] || die "暂存区为空 —— 没有可提交的改动（这通常意味着前面的 git add 失败了）"

miss=""
for tok in $(printf '%s' "$subj" | grep -oE '[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]*' | sort -u); do
  # 纯数字比例（`37/93`）不是路径 —— 第一版把它当成路径，于是标题里一写比率就被拦。
  # 判据：路径至少要有「像名字」的成分（含字母），或含扩展名的点。
  printf '%s' "$tok" | grep -qE '[A-Za-z]' || continue
  # 只查「看起来是仓内路径」的：必须带 / 且不含空格已在正则里保证
  printf '%s\n' "$staged" | grep -qxF "$tok" && continue
  # 允许只写目录前缀或文件名后缀（标题里常写 `scripts/` 或 `qa.sh`）
  printf '%s\n' "$staged" | grep -qE "(^|/)${tok//./\\.}$|^${tok//./\\.}" && continue
  miss="$miss $tok"
done
if [ -n "$miss" ]; then
  echo "✗ 标题提到的路径没在这次改动里：$miss" >&2
  echo "  实际改动：" >&2
  printf '%s\n' "$staged" | sed 's/^/    /' >&2
  echo "  ⇒ 标题与 diff 不符时，只有当有人同时看两者才会发现 —— 而那没有发生。" >&2
  echo "    若确实只是叙述（不是路径），请改写标题或删掉那段路径写法。" >&2
  exit 1
fi

# ② 声明与事实一致
line=$(grep -E '^Diff-Shape: \+[0-9]+/-[0-9]+$' "$msg" | tail -1 || true)
[ -n "$line" ] || die "缺少声明行：Diff-Shape: +<加的行>/-<删的行>"
want_add=$(printf '%s' "$line" | sed -E 's/^Diff-Shape: \+([0-9]+)\/.*/\1/')
want_del=$(printf '%s' "$line" | sed -E 's/.*\/-([0-9]+)$/\1/')
read -r act_add act_del < <(git diff --cached --numstat | awk 'NF>=2 && $1 ~ /^[0-9]+$/ {a+=$1; d+=$2} END{printf "%d %d\n", a+0, d+0}')
if [ "$want_add" -ne "$act_add" ] || [ "$want_del" -ne "$act_del" ]; then
  die "改动形状与声明不符：声明 +$want_add/-$want_del，实际 +$act_add/-$act_del"
fi

git commit -F "$msg" || die "git commit 失败"
git log --oneline -1

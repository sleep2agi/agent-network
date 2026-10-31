#!/usr/bin/env bash
# 安装「改动形状」钩子（commit-msg）。
#
# 2026-10-31 —— 外部复核 ②：「把『我需要检查』换成一个结合时能停下动作的数」。
# 光有脚本不够 —— 它得在**你正要提交的那一刻**出现，否则和其他「记得跑一下」的门没区别。
#
# 设计上的三个选择（都是被同一件事逼出来的）：
#   1. 用 commit-msg 而不是 pre-commit：声明要写在提交信息里（`Diff-Shape: +A/-D`），
#      而 pre-commit 时提交信息还不存在 ⇒ 只能读暂存区、无从对照「意图」。
#   2. 声明写成**提交信息里的一行**，不是命令行参数：参数不会留在历史里，
#      而「这次打算改多少」事后必须可回看。
#   3. 默认**不启用**（`git config --local diffShape.enabled true` 才生效）：
#      一个默认开着的钩子会在别人第一次提交时拦人，然后被 `--no-verify` 永久绕过。
#
# 用法：
#   scripts/install-diff-shape-hook.sh            # 安装（不启用）
#   git config --local diffShape.enabled true     # 启用
#   scripts/install-diff-shape-hook.sh --uninstall

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "✗ 不在 git 仓库里" >&2; exit 2; }
HOOK="$ROOT/.git/hooks/commit-msg"

if [ "${1:-}" = "--uninstall" ]; then
  if [ -f "$HOOK" ] && grep -q "diffShape" "$HOOK"; then
    rm -f "$HOOK"; echo "✓ 已卸载 commit-msg 钩子"
  else
    echo "· 没有本脚本安装的钩子，什么都没做"
  fi
  exit 0
fi

mkdir -p "$ROOT/.git/hooks"
cat > "$HOOK" <<'HOOK_BODY'
#!/usr/bin/env bash
# 由 scripts/install-diff-shape-hook.sh 安装（diffShape）。改形状：提交信息必须写 `Diff-Shape: +A/-D`。
set -uo pipefail
[ "$(git config --get diffShape.enabled 2>/dev/null)" = "true" ] || exit 0
msg_file="${1:-}"
line=$(grep -E '^Diff-Shape: \+[0-9]+/-[0-9]+$' "$msg_file" 2>/dev/null | tail -1 || true)
if [ -z "$line" ]; then
  echo "✗ 缺少声明行：Diff-Shape: +<加的行>/-<删的行>" >&2
  echo "  ⇒ 先写清楚这次打算改多少（删除 0 是最常见也最该被声明的值），再提交。" >&2
  echo "  ⇒ 实测：git diff --cached --numstat | awk '{a+=\$1;d+=\$2} END{print a,d}'" >&2
  exit 1
fi
want_add=$(printf '%s' "$line" | sed -E 's/^Diff-Shape: \+([0-9]+)\/.*/\1/')
want_del=$(printf '%s' "$line" | sed -E 's/.*\/-([0-9]+)$/\1/')
read -r act_add act_del < <(git diff --cached --numstat | awk 'NF>=2 && $1 ~ /^[0-9]+$/ {a+=$1; d+=$2} END{printf "%d %d\n", a+0, d+0}')
if [ "$want_add" -ne "$act_add" ] || [ "$want_del" -ne "$act_del" ]; then
  echo "✗ 改动形状与声明不符：声明 +$want_add/-$want_del，实际 +$act_add/-$act_del" >&2
  echo "  ⇒ 先回答：这些多出来/少掉的删行是谁删的？改完再提交。" >&2
  exit 1
fi
exit 0
HOOK_BODY
chmod +x "$HOOK"
echo "✓ 已安装 $HOOK"
echo "  启用：git config --local diffShape.enabled true"
echo "  停用：git config --local diffShape.enabled false（不必卸载）"

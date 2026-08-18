#!/usr/bin/env bash
# 仓里的 fleet 脚本 vs 那台机器上真正在跑的那份,有没有分叉。
#
# 🔴 为什么需要它:2026-08-18 之前,`anet-nodes-boot.sh`(281 行,管 ~100 个 agent
#    节点的开机恢复)**只存在于那台机器上**。仓里有 pm2-fleet.* 而没有它,于是
#    从仓库看「agent 节点没有任何开机托管」是一个看起来完全成立的结论 —— #839
#    就是这么写的,而它的作者没做错什么:他看的是仓,仓里确实没有。
#
#    收进仓之后风险换了个形状,但没有消失:**跑的是机器上那份,仓里那份是记录。**
#    有人在机器上改出 v2.6,仓里这份会静默变成过期的记录,而**没有任何东西会喊**。
#    这个脚本就是那声喊。
#
# 判据(刻意只比"实质",不比"字面"):
#   - 仓里那份用 $HOME,机器上那份写死家目录 —— 这是**有意的差异**,不该报;
#     所以两边都先做一次归一化(把 /home/<user>/ 折成 $HOME/)再比。
#   - 归一化之后仍然不同 ⇒ 真分叉,退出 1 并打 diff。
#
# 🔴 已知的一处有意差异,不要当成分叉:
#     仓里:   [ "$skp" = "$(basename "$HOME")" ]
#     机器上: [ "$skp" = "vansin" ]
#   路径参数化之后,写死用户名那一行成了脚本里唯一残留的机器耦合点。仓里改对了,
#   机器上没动(改在跑的东西要单独一条)。本脚本把这一处也归一化掉。
#
# 用法(在部署机上跑):
#   bash deploy/fleet/check-fleet-drift.sh            # 比全部
#   bash deploy/fleet/check-fleet-drift.sh --selftest # 判据自检
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 仓里文件 → 机器上对应的实物
declare -a PAIRS=(
  "anet-nodes-boot.sh|$HOME/.local/bin/anet-nodes-boot.sh"
  "pm2-fleet-boot.sh|$HOME/.local/bin/pm2-fleet-boot.sh"
  "anet-nodes-boot.service|$HOME/.config/systemd/user/anet-nodes-boot.service"
  "pm2-fleet.service|$HOME/.config/systemd/user/pm2-fleet.service"
)

normalize() {
  # /home/<任意用户>/ → $HOME/ ;写死的 basename 比较 → $(basename "$HOME")
  sed -E \
    -e 's#/home/[A-Za-z0-9._-]+#$HOME#g' \
    -e 's#\[ "\$skp" = "[A-Za-z0-9._-]+" \]#[ "$skp" = "$(basename "$HOME")" ]#g' \
    "$1"
}

selftest() {
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  local pass=0 fail=0
  chk() { # name expect_same fileA fileB
    local got; if diff -q <(normalize "$3") <(normalize "$4") >/dev/null 2>&1; then got=same; else got=diff; fi
    if [ "$got" = "$2" ]; then pass=$((pass+1)); echo "  ok   $1"
    else fail=$((fail+1)); echo "  FAIL $1  (期望 $2,得到 $got)"; fi
  }
  printf 'x=/home/user/.anet\n'     > "$tmp/a"
  printf 'x=/home/example/.anet\n'  > "$tmp/b"
  # 🔴 夹具名用 user / example,不用 alice / bob —— check-home-path-baseline.py
  #    分不出「编造的人名」和「真人」,对一个公开仓来说那是**正确**的判法。
  #    (我第一版就是用 alice/bob 写的,被那道门拦下来了,拦得对。)
  chk "不同用户名的同一路径 → 归一化后相同" same "$tmp/a" "$tmp/b"

  printf 'x=/home/user/.anet\ny=1\n'    > "$tmp/c"
  printf 'x=/home/example/.anet\ny=2\n' > "$tmp/d"
  chk "路径同但内容真的不同 → 仍判分叉"   diff "$tmp/c" "$tmp/d"

  printf '[ "$skp" = "vansin" ]\n'                 > "$tmp/e"
  printf '[ "$skp" = "$(basename "$HOME")" ]\n'    > "$tmp/f"
  chk "写死用户名 vs basename 是有意差异 → 不报" same "$tmp/e" "$tmp/f"

  # 🔴 分母承重:归一化不能把「一边空一边有内容」也抹平
  : > "$tmp/g"; printf 'real content\n' > "$tmp/h"
  chk "空 vs 非空 → 必须判分叉"           diff "$tmp/g" "$tmp/h"

  echo "selftest: $pass ok / $fail fail"
  [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "--selftest" ]; then selftest; exit $?; fi

checked=0; drift=0; missing=0
for pair in "${PAIRS[@]}"; do
  repo_name="${pair%%|*}"; live="${pair#*|}"
  repo="$REPO_DIR/$repo_name"
  if [ ! -f "$repo" ]; then echo "SKIP  $repo_name — 仓里没有这个文件"; continue; fi
  if [ ! -f "$live" ]; then
    echo "MISS  $repo_name — 机器上没有 $live（这台机可能不是部署机）"
    missing=$((missing+1)); continue
  fi
  checked=$((checked+1))
  if diff -q <(normalize "$repo") <(normalize "$live") >/dev/null 2>&1; then
    echo "ok    $repo_name"
  else
    drift=$((drift+1))
    echo "DRIFT $repo_name  ← 仓里那份已经不是在跑的那份"
    diff -u <(normalize "$repo") <(normalize "$live") | sed 's/^/      /' | head -40
  fi
done

echo
echo "checked=$checked drift=$drift missing=$missing"

# 🔴 fail-closed:一个都没比到,不是「干净」,是「没看」——两者打印出来会长得很像。
if [ "$checked" -eq 0 ]; then
  echo "FAIL: 一个文件都没比对到 —— 这台机不是部署机,或者路径变了。不要读成「没有分叉」。" >&2
  exit 2
fi
[ "$drift" -eq 0 ] || exit 1
echo "仓里的 fleet 脚本与机器上在跑的那份一致（已归一化家目录差异）。"

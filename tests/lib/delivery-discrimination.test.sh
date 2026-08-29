#!/usr/bin/env bash
# delivery-discrimination.sh 自己的 meta 测试(#1459 类级护栏)
#
# 🔴 这个 helper 防的是「失败态与成功态同值」,而它自己也可能退化成
#    「永远放行」—— 那它就成了它要防的那种东西。所以这里两向都验。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$*"; }

REPORTED=""
delivery_discrimination_report(){ REPORTED="$*"; }
# shellcheck disable=SC1091
source "$HERE/delivery-discrimination.sh"

echo "== delivery-discrimination meta =="

# ① 两种情形读数不同 ⇒ 放行
REPORTED=""
if assert_discriminates dm-delivered "delivered=true" "delivered=false,reason=no_live_subscriber"; then
  [ -z "$REPORTED" ] && ok "读数不同:放行且未报告" || bad "放行却报告了:$REPORTED"
else
  bad "读数不同却被误判为无判别力"
fi

# ② 🔴 同值 ⇒ 必须拒绝(这正是 #1276/#1277/#1459 的形状:失败也报成功)
REPORTED=""
if assert_discriminates dm-constant-ok "ok=true" "ok=true"; then
  bad "🔴 成功与失败同读数却放行了 —— helper 自己就是它要防的那种假门"
else
  ok "同值:被拒绝"
  case "$REPORTED" in
    *"判别力为零"*) ok "报告点名了『判别力为零』" ;;
    "")             bad "被拒但无任何报告 —— 红话不指名" ;;
    *)              bad "报告未点名:$REPORTED" ;;
  esac
  case "$REPORTED" in *dm-constant-ok*) ok "报告带上了名字,可定位" ;; *) bad "报告没带名字" ;; esac
  case "$REPORTED" in *"ok=true"*) ok "报告带上了那个同值读数" ;; *) bad "报告没带读数,无法判断哪儿同了" ;; esac
fi

# ③ 空读数 ⇒ 也必须拒绝(空 vs 空既像"相同"也像"没测",都不能算通过)
for pair in "|x" "x|" "|"; do
  REPORTED=""; a="${pair%%|*}"; b="${pair##*|}"
  if assert_discriminates empty-case "$a" "$b"; then
    bad "🔴 空读数('$a' / '$b')被放行"
  else
    case "$REPORTED" in *"读数缺失"*) : ;; *) bad "空读数被拒但原因没说清:$REPORTED" ;; esac
  fi
done
ok "空读数三种组合都被拒绝且说明原因"

# ④ 报告回调可注入(不绑死套件计数)
declare -F delivery_discrimination_report >/dev/null && ok "报告回调可被套件覆盖" || bad "报告回调不可注入"

printf '\n  PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

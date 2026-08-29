#!/usr/bin/env bash
# mutation-guard.sh 自己的 meta 测试(#1257)
#
# 🔴 这一格是本条改动的判据核心:守卫本身也可能是假门。
#    如果它对「什么都没变」也放行,那它就只是换了个写法的 `grep -Fq 锚点`。
#    所以这里必须**喂一个 no-op 变异,看它拒不拒**。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 🔴 不用裸 `rm -rf "$VAR"` —— 2026-06-16 有过 `rm -rf $HOME` 抹掉真实项目的事故,
# tests/ 下由 lint-no-bare-rm-rf.sh 一律拒。safe_rm_rf 只放行 /tmp/* 前缀,越界
# 直接 exit 99 且不执行 rm。本脚本的 $WORK 来自 mktemp -d,落在 /tmp,符合。
# shellcheck disable=SC1091
source "$HERE/safe-rm.sh"

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$*"; }

REPORTED=""
mutation_guard_report(){ REPORTED="$*"; }   # 捕获报告,验证它真的报了
# shellcheck disable=SC1091
source "$HERE/mutation-guard.sh"

WORK="$(mktemp -d)"; trap 'safe_rm_rf "$WORK"' EXIT
F="$WORK/target.txt"

echo "== mutation-guard meta =="

# ① 真变异 ⇒ 放行(返回 0),且不报告
printf 'const dir = feishuOutboundDir(conversationId);\n' > "$F"
REPORTED=""
if mutate real-change "$F" sed -i 's/conversationId/sender.id/' "$F"; then
  [ -z "$REPORTED" ] && ok "真变异:放行且未报告" || bad "真变异却报告了:$REPORTED"
else
  bad "真变异被误判为 NO-OP"
fi
grep -q 'sender.id' "$F" && ok "真变异:文件内容确实被改了" || bad "文件没被改,前提不成立"

# ② 🔴 no-op 变异 ⇒ 必须拒绝(返回非 0)并报告
printf 'const dir = feishuOutboundDir(conversationId);\n' > "$F"
REPORTED=""
if mutate no-op "$F" sed -i 's/THIS_PATTERN_DOES_NOT_EXIST/x/' "$F"; then
  bad "🔴 no-op 变异被当成有效变异放行了 —— 守卫本身是假门"
else
  ok "no-op 变异:被拒绝(返回非 0)"
  case "$REPORTED" in
    *"NO-OP"*) ok "no-op 变异:报告里点名了 NO-OP" ;;
    "")        bad "no-op 被拒但没有任何报告 —— 红话不指名" ;;
    *)         bad "报告未点名 NO-OP:$REPORTED" ;;
  esac
  case "$REPORTED" in
    *no-op*) ok "报告里带上了变异名,可定位" ;;
    *)       bad "报告没带变异名:$REPORTED" ;;
  esac
fi

# ③ 目标文件不存在 ⇒ 也必须拒绝(不能因为 sha 读不到就当成"变了")
REPORTED=""
if mutate missing "$WORK/nope.txt" true; then
  bad "🔴 目标文件不存在却放行了"
else
  ok "文件不存在:被拒绝"
  case "$REPORTED" in *"不存在"*) ok "文件不存在:报告说明了原因" ;; *) bad "原因未说明:$REPORTED" ;; esac
fi

# ④ 报告方式可注入(不绑死套件的 bad/FAIL)
declare -F mutation_guard_report >/dev/null && ok "报告回调可被套件覆盖" || bad "报告回调不可注入"

printf '\n  PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

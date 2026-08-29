# 变异注入守卫(#1257) —— 证明「变异真的被注入了」,而不只是「锚点还在」。
#
# 🔴 它替换的旧写法:
#     perl -0pi -e 's/<模式>/<变异>/' <file>
#     grep -Fq '<锚点>' <file>          # ← 只证明锚点还在
#     expect_red <name> <test-cmd>
#   被测代码换个写法(加参数、跨行、内联局部变量、改名)⇒ 模式不匹配 ⇒ perl 是
#   no-op;锚点通常还在,grep 照过,于是 expect_red 拿一份**没被变异的源码**去
#   跑 → 恒绿。输出是 `mutation <name> stayed green`,读起来像「这条规则没人守
#   了」,而真相是「这个变异从来没被注入过」—— **两者指向完全相反的修法**。
#   (#1054/#1051/#1056/#1059 是同一机制的四个实例;#1252 上我们据此派错过工。)
#
# 用法:
#     source tests/lib/mutation-guard.sh
#     mutation_guard_report() { bad "$@"; }        # 可选:接到套件自己的计数
#     mutate <name> <file> <命令...> && expect_red <name> <test-cmd>
#
# 🔴 用 `&&` 串联是刻意的:no-op 只记一笔账、不中断整轮 —— 取证期要的是失败的
#    **分布**,不是第一颗就停。
#
# 🔴 不绑定套件的 bad()/FAIL 计数:那会把这个共享件焊死在某一套计数约定上。
#    调用方用 mutation_guard_report 注入自己的报告方式;缺省只打印并返回非零。

# 缺省报告:只打印。套件覆盖它即可接入自己的 PASS/FAIL 计数。
if ! declare -F mutation_guard_report >/dev/null 2>&1; then
  mutation_guard_report() { printf 'FAIL %s\n' "$*"; }
fi

# mutate <name> <file> <命令...>
#   跑 <命令...>,并以 <file> 的 sha256 前后是否变化判定变异有没有真的注入。
#   返回 0 = 确实改动了字节;返回 1 = NO-OP(或文件缺失),并报告。
mutate() {
  local name="$1" file="$2"; shift 2
  local before after
  if [ ! -f "$file" ]; then
    mutation_guard_report "mutation $name NO-OP —— 目标文件不存在($file)"
    return 1
  fi
  before="$(sha256sum "$file" | cut -d' ' -f1)"
  "$@"
  after="$(sha256sum "$file" | cut -d' ' -f1)"
  if [ "$before" = "$after" ]; then
    mutation_guard_report "mutation $name NO-OP —— 模式没匹配到任何东西,变异从未注入($file 未改变)"
    return 1
  fi
  return 0
}

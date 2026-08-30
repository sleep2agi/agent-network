# anet 失败码提取器 —— 从一份 `anet` 命令的原始输出里取出第一条失败文案的白名单标识。
#
# 为什么是白名单:原始输出是 600 私有的(可能含凭据),CI 上看不到。这里只把**匹配到的
# 那一段**打出来,而所有候选项都是 cli.ts 里**不含插值的字面句**,或全大写错误码形状
# ——凭据不是这两种形状(utok_/ntok_ 是小写前缀,base64/hex 带混合大小写或 /+=)。
#
# 🔴 这个函数**永远 return 0**,这是它最重要的性质,不是随手写的。
#    调用它的套件跑在 `set -euo pipefail` 下。#1437 里这段逻辑是内联的:
#        code=$(grep -oE '^\[anet\] [A-Z][A-Z0-9_]+' "$path" | head -1)
#    grep 不命中时退 1 → pipefail 传给整条管道 → 赋值语句退出码=1 → **set -e 当场打死
#    脚本**。于是紧跟其后的 fail() 一行都没跑到,报告里连 "FAIL: ..." 都没有,
#    只剩前一条 bytes 行。#1422 的本地复现就是这么死的:整份报告在 L2 断掉,
#    没有失败原因、没有早停行、没有 Summary。
#    **一条"失败时告诉你是哪一种"的诊断,恰恰在不命中时把失败信息本身销毁了**,
#    而不命中正是它被写出来要应付的那种情况(实测 7 条真实文案里 5 条不命中)。
#
# 🔴 候选项按「cli.ts 里逐条复核过的字面句」维护,不要换成通用占位符或笛卡尔积
#    (与 failure-diagnostic.mjs 里 FAILURE_CODES 的维护方式一致)。
#    末位那条通用全大写形状**必须保留**:它的价值正在于打出**意料之外**的码。
#
# 🔴 `FATAL` 单独拿出来说:`[anet] FATAL:` 是 cli.ts 顶层 catch 的包装,
#    **真正的错误名跟在它后面**(`FATAL: Error: NODE_STOP_GENERATION_CHANGED`)。
#    只吃到 `FATAL` 的话,两个完全不同的致命错误会塌成同一个字符串 ——
#    实测 NODE_STOP_GENERATION_CHANGED 与 NODE_LIFECYCLE_LOCK_CORRUPT 都打成
#    `[anet] FATAL`,判别力为零。所以单列一条 `FATAL: <Xxx>: <ALL_CAPS>`。
#    仍然是白名单:`FATAL:` 之后只吃「首字母词 + 全大写码」这种形状,
#    任意错误文本(可能含凭据)不会被打出来,退回到 `[anet] FATAL`。
ANET_FAILURE_CODE_PATTERN='^\[anet\] (FATAL: [A-Za-z]+: [A-Z][A-Z0-9_]{3,}|FATAL: config\.json env\.|STOP_TIMEOUT: authoritative local resources survived|STOP_TIMEOUT: could not prove|STOP_TIMEOUT: Windows ownership could not be proven|STOP_TIMEOUT: Windows managed processes survived|STOP_TIMEOUT: Windows node pid|⚠ identity teardown incomplete|⚠ copresence marker present but refused|⚠ identity gate check crashed|❌ tmux kill-session did not take|❌ this stop command.s ancestry includes|❌ refusing Windows co-presence teardown|❌ taskkill failed for|could not confirm that|[A-Z][A-Z0-9_]{3,})'

# anet_first_failure_code <path> —— 打印标识;文件不存在打 <no-log>,没命中打 <none matched>。
anet_first_failure_code() {
  local path=${1:-} code=''
  if [ ! -e "$path" ]; then printf '%s' '<no-log>'; return 0; fi
  code=$(grep -oE "$ANET_FAILURE_CODE_PATTERN" "$path" 2>/dev/null | head -1) || code=''
  printf '%s' "${code:-<none matched>}"
  return 0
}

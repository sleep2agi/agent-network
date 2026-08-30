#!/usr/bin/env bash
# tests/lib/anet-failure-code.sh 的元测试。
#
# 两件事必须各自被证明:
#   A 判别力 —— 每条真实失败文案给出**互不相同**的标识(#1437 那版把两条 STOP_TIMEOUT
#     塌成同一个字符串 "[anet] STOP_TIMEOUT",红了也分不清是哪一种)。
#   B 不杀调用方 —— 不命中时调用方在 `set -euo pipefail` 下必须活着走完。
#     这是 #1422 的真回归:诊断自己把 FAIL 行弄没了。
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/anet-failure-code.sh"
WORK=$(mktemp -d /tmp/anet-failure-code-meta.XXXXXX)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL: %s\n' "$1"; }

# —— A. 每条真实文案(逐字取自 agent-network/bin/cli.ts 的 stopCommand)——
declare -a SAMPLES=(
  '[anet] STOP_TIMEOUT: authoritative local resources survived for "n" after 10000ms; hub was not notified offline.'
  '[anet] STOP_TIMEOUT: could not prove "n" stopped; hub was not notified offline.'
  '[anet] ⚠ identity teardown incomplete: detail here'
  '[anet] ❌ tmux kill-session did not take for: sess-a'
  '[anet] could not confirm that "n" exited (pid 1234); pidfile retained and PID was not signalled.'
  '[anet] ⚠ copresence marker present but refused (STALE): detail'
  "[anet] ❌ this stop command's ancestry includes a marker-carrying process"
)
declare -a CODES=()
i=0
for s in "${SAMPLES[@]}"; do
  i=$((i+1)); f="$WORK/sample$i.log"; printf '%s\n' "$s" > "$f"
  c=$(anet_first_failure_code "$f")
  CODES+=("$c")
  if [ "$c" = "<none matched>" ]; then bad "第 $i 条真实文案没被认出:${s:0:52}"
  else ok "第 $i 条认出 → $c"; fi
done

# 判别力:七条必须两两不同(#1437 那版这里是 6 个不同值,两条 STOP_TIMEOUT 撞了)
uniq_n=$(printf '%s\n' "${CODES[@]}" | sort -u | wc -l)
if [ "$uniq_n" -eq "${#CODES[@]}" ]; then ok "七条文案给出七个互不相同的标识(判别力=满)"
else bad "判别力不足:${#CODES[@]} 条文案只给出 $uniq_n 个不同标识 —— 有两条塌成同一个"; fi

# —— B. 不命中 → 调用方必须活着(本条就是 #1422 的回归测试)——
noise="$WORK/noise.log"
printf 'some log line\nanother line without any anet marker\n' > "$noise"
# 🔴 探针有两种形状,必须都测 —— 这一格是量出来的,不是补全性写的:
#    ② 函数体内赋值 + 函数当**普通语句**调用 …… set -e 打死整个脚本(rc=1)
#    ③ 函数体内赋值 + 函数在**命令替换**里调用 …… 活着(rc=0)
#    run.sh 里 fail_with_private_log 是形状 ②。我第一版元测试只写了 ③,
#    于是把 helper 里的 `|| code=''` 拿掉,测试**照样全绿** ——
#    一个结构上不可能观察到该缺陷的探针。两向见证才把它逼出来。
probe="$WORK/probe.sh"
cat > "$probe" <<'PROBE'
set -euo pipefail
source "$1"
code=$(anet_first_failure_code "$2")
printf 'reached-end code=%s\n' "$code"
PROBE
probe2="$WORK/probe2.sh"
cat > "$probe2" <<'PROBE2'
set -euo pipefail
source "$1"
anet_first_failure_code "$2" >/dev/null
printf 'reached-end-stmt\n'
PROBE2
out=$(bash "$probe" "$HERE/anet-failure-code.sh" "$noise" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -Fq 'reached-end'; then
  ok "不命中时调用方在 set -euo pipefail 下活着走完(rc=0)"
else
  bad "不命中把调用方打死了:rc=$rc out='$out' —— 这正是 #1437 的回归"
fi
if printf '%s' "$out" | grep -Fq 'code=<none matched>'; then ok "不命中报 <none matched>"
else bad "不命中没有报 <none matched>:$out"; fi

# 形状 ②:当普通语句调用 —— 这才是 run.sh 里的真实写法,也是唯一能看见 #1437 那个缺陷的形状
out_s=$(bash "$probe2" "$HERE/anet-failure-code.sh" "$noise" 2>&1); rc_s=$?
if [ "$rc_s" -eq 0 ] && printf '%s' "$out_s" | grep -Fq 'reached-end-stmt'; then
  ok "不命中时【当普通语句调用】也活着走完(run.sh 的真形状)"
else
  bad "不命中把调用方打死了(普通语句形状):rc=$rc_s out='$out_s' —— #1437 的真回归"
fi

# 文件不存在 —— 也不能杀调用方,且要说得出是「没日志」而不是「没命中」
out2=$(bash "$probe" "$HERE/anet-failure-code.sh" "$WORK/does-not-exist.log" 2>&1); rc2=$?
if [ "$rc2" -eq 0 ] && printf '%s' "$out2" | grep -Fq 'code=<no-log>'; then
  ok "日志不存在报 <no-log> 且不杀调用方"
else bad "日志不存在这一格不对:rc=$rc2 out='$out2'"; fi

# 意料之外的码仍要打得出来(这一格丢了,白名单就变成了藏东西的清单)
printf '[anet] NODE_SOMETHING_BRAND_NEW: x\n' > "$WORK/unexpected.log"
c=$(anet_first_failure_code "$WORK/unexpected.log")
if [ "$c" != "<none matched>" ] && printf '%s' "$c" | grep -Fq 'NODE_SOMETHING_BRAND_NEW'; then
  ok "没预料到的全大写码照样打得出来 → $c"
else bad "通用兜底失效,意料之外的码被吞了:'$c'"; fi

rm -f "$WORK"/*.log "$WORK"/*.sh 2>/dev/null || true
rmdir "$WORK" 2>/dev/null || true
printf '\nPASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

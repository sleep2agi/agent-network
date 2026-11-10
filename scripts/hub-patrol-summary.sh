#!/bin/bash
# 三条巡检的「一行汇总」。
#
# 由来（2026-11-05）：这台机器上有三条各自独立的巡检，各写一个日志：
#   ~/.commhub/idle-poll-share.log     （每 6h）  「问状态/问活」占比
#   ~/.commhub/requirement-gaps.log    （每天）   建卡缺字段比例
#   ~/.commhub/desktop-release.log     （每天）   桌面端线上版本一致性
#
# 三条都写对了，但**发现者要记得去三个地方看** —— 那件事靠记忆，不靠路径。
# 所以这里把它们压成一行：每条只报「最后一行 + 距今多久 + 判定」。
#
# 判定三态（每一态都要能自己解释，不许塌成"没事"）：
#   ok      有读数，且未超各自阈值
#   stale   有读数，但最后一行太久（阈值 = 该巡检周期的 2 倍 + 余量）
#   missing 日志不存在或为空（**没读数 ≠ 没问题**）
#
# 输出一行，便于 `tail -1` 与 grep：
#   2026-11-05T22:20:00+08:00 verdict=ok idle=85.2%@1h gaps=22@1h desktop=ok@1h
#
# 退出码：0 = 三条都 ok；1 = 有条目 stale/missing（--assert 时才用 1）；2 = 无法定位日志目录
export PATH="/usr/local/bin:/usr/bin:/bin"
LOGDIR="${PATROL_LOG_DIR:-$HOME/.commhub}"
OUT="${PATROL_SUMMARY_LOG:-$LOGDIR/patrol-summary.log}"

[ -d "$LOGDIR" ] || { echo "$(date -Is) rc=2 logdir_missing=$LOGDIR" >> "$OUT" 2>/dev/null; exit 2; }

# 参数：日志文件、最大允许年龄（小时）、从最后一行里抽「读数」的正则
age_hours() {  # $1=文件
  local f=$1
  [ -s "$f" ] || { echo ""; return; }
  local ts
  ts=$(tail -1 "$f" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1)
  [ -n "$ts" ] || { echo ""; return; }
  local then_s now_s
  then_s=$(date -d "$ts" +%s 2>/dev/null); now_s=$(date +%s)
  [ -n "$then_s" ] || { echo ""; return; }
  echo $(( (now_s - then_s) / 3600 ))
}

ok=1
parts=()

check() {  # $1=名字(缩写) $2=文件 $3=最大年龄h $4=抽读数的 sed 表达式
  local name=$1 file=$2 maxage=$3 pat=$4 last age reading verdict
  last=$(tail -1 "$file" 2>/dev/null)
  if [ -z "$last" ]; then
    parts+=("$name=missing"); ok=0; return
  fi
  age=$(age_hours "$file")
  # 注意 `-n` 必须配 `p` 标志，否则 sed 什么都不打印（2026-11-05 就是这个坑：
  # 三条读数全变成 "?"，而判定仍显示 ok —— 一个"看起来正常"的空读数）
  reading=$(printf '%s\n' "$last" | sed -nE "${pat}p" | head -1)
  if [ -z "$age" ]; then
    verdict=missing; ok=0
  elif [ "$age" -gt "$maxage" ]; then
    verdict=stale; ok=0
  elif printf '%s\n' "$last" | grep -qE 'verdict=(inconsistent|unreadable)|rc=(1|2|9[0-9])'; then
    verdict=failed; ok=0
  else
    verdict=ok
  fi
  parts+=("$name=${reading:-?}@${age}h(${verdict})")
}

check idle    "$LOGDIR/idle-poll-share.log"   13 's/.*share=([0-9.]+%.*)$/\1/'
check gaps    "$LOGDIR/requirement-gaps.log"  26 's/.*(新建=[0-9]+ 缺字段=[0-9]+).*/\1/'
check desktop "$LOGDIR/desktop-release.log"   26 's/.*version=([0-9.]+) platforms=([0-9]+) verdict=([a-z]+).*/\1\/\2p\/\3/'
# 2026-11-06 —— nodes 从 `4` 变成 `4/7`（在报/能报）。正则必须跟着改，
# 且这里不能用 `/` 做分隔符：模式里含 `/`，两次转义都会被 bash 单引号原样带进 sed。
# 旧式 `nodes=([0-9]+) total=` 匹配不到 `nodes=4/7 total=` ⇒ 读数静默变成 "?"，
# 而判定仍是 ok —— 正是上面注释里那个"看起来正常的空读数"的形状。
check tokens  "$LOGDIR/node-token-usage.log"  26 's|.*nodes=([0-9]+/[0-9]+) total=([0-9]+).*|\1n/\2t|'

line="$(date -Is) verdict=$([ "$ok" = 1 ] && echo ok || echo attention) ${parts[*]}"
echo "$line" >> "$OUT"

# 最后一行同时打到 stdout：人工跑时不用再去 cat 日志
echo "$line"
[ "$ok" = 1 ] && exit 0
[ "${1:-}" = "--assert" ] && exit 1
exit 0

#!/bin/bash
# #3952 的巡检：每天一行「有多少节点在报 token 用量 / 合计多少」。
#
# 生产机上的拷贝：/home/vansin/.commhub/node-token-usage.sh（crontab 见下）
# 收进仓的理由与其它巡检脚本同一条：仓外脚本没有 diff，也没有门看着它。
#
# 为什么一次一行而不是只在失败时报：
#   只在失败时报 ⇒「cron 没跑」与「一切正常」在日志上同形（都没有新行）
#   一次一行   ⇒ 最后一行太旧 = cron 坏了；nodes=0 = **没人上报**（这才是要盯的那件事）
#
# 产出格式（一行）：
#   2026-11-05T23:10:00+08:00 rc=0 nodes=3 total=1234567 cache=89012345
export HOME=/home/vansin
export PATH="/home/vansin/.nvm/versions/node/v20.20.0/bin:/usr/local/bin:/usr/bin:/bin"
LOG="${NODE_TOKEN_USAGE_LOG:-/home/vansin/.commhub/node-token-usage.log}"
REPO=${REPO:-/home/vansin/anet-main}
HOURS="${NODE_TOKEN_USAGE_HOURS:-24}"

cd "$REPO" || { echo "$(date -Is) rc=99 cd_failed repo=$REPO" >> "$LOG"; exit 99; }
out=$(python3 scripts/report-node-token-usage.py --hours "$HOURS" 2>&1); rc=$?

# 从报表里抽「有用量的节点 N 个」和第一行数据的总量
nodes=$(printf '%s\n' "$out" | grep -oE '有用量的节点 [0-9]+' | grep -oE '[0-9]+' | head -1)
total=$(printf '%s\n' "$out" | grep -E '^[^ ]+ +[0-9,]+ +[0-9,]+ +[0-9,]+' | head -1 | awk '{gsub(/,/,"",$4); print $4}')
cache=$(printf '%s\n' "$out" | grep -E '^[^ ]+ +[0-9,]+ +[0-9,]+ +[0-9,]+' | head -1 | awk '{gsub(/,/,"",$5); print $5}')

# rc=2 表示读不到库/表 —— 那是「没有读数」，与「用量为 0」不同形，必须写进同一行
echo "$(date -Is) rc=$rc nodes=${nodes:-?} total=${total:-0} cache=${cache:-0}" >> "$LOG"
exit $rc

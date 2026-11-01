#!/bin/bash
# #3119 的巡检：每 6h 记一行「问状态/问活」占比。
#
# 生产机上跑的是这一份的拷贝：/home/vansin/.commhub/idle-poll-share.sh
#（crontab: 17 */6 * * * …）。收进仓的理由与 hub-rotate-logs.sh 同一条：
#  脚本在仓外时，它的改动没有任何 diff，也没有任何门看着它。
#
# 为什么「一次一行」而不是「只在失败时报」：
#   只在失败时报 ⇒「cron 没跑」与「一切正常」在日志上同形（都没有新行）
#   一次一行   ⇒ 最后一行太旧 = cron 坏了；share 超阈 = 退化。两个故障各有读数
#
# 显式设 HOME/PATH：#3322 那次踩过 —— cron 的环境与交互 shell 不同，不显式设会静默失败。
export HOME=/home/vansin
export PATH="/home/vansin/.nvm/versions/node/v20.20.0/bin:/usr/local/bin:/usr/bin:/bin"
LOG=/home/vansin/.commhub/idle-poll-share.log
REPO=${REPO:-/home/vansin/anet-main}

cd "$REPO" || { echo "$(date -Is) rc=99 cd_failed repo=$REPO" >> "$LOG"; exit 99; }
out=$(python3 scripts/report-idle-poll-share.py 2>&1); rc=$?
share=$(printf '%s\n' "$out" | grep -oE '四项合计 [0-9]+ = \*\*[0-9.]+%\*\*' | grep -oE '[0-9.]+%' | head -1)
echo "$(date -Is) rc=$rc share=${share:-unknown}" >> "$LOG"
exit $rc

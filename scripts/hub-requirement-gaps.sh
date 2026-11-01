#!/bin/bash
# #3068 的巡检：每天一行「日期 新建 N 缺字段 M」。
#
# 生产机上的拷贝：/home/vansin/.commhub/requirement-gaps.log（crontab 见下）
# 收进仓的理由同 hub-idle-poll-share.sh：仓外脚本没有 diff。
# 一次一行而不是「只在超阈时报」：没有新行既可能是「没跑」也可能是「没问题」。
export HOME=/home/vansin
export PATH="/home/vansin/.nvm/versions/node/v20.20.0/bin:/usr/local/bin:/usr/bin:/bin"
LOG=/home/vansin/.commhub/requirement-gaps.log
REPO=${REPO:-/home/vansin/anet-main}

cd "$REPO" || { echo "$(date -Is) rc=99 cd_failed" >> "$LOG"; exit 99; }
line=$(python3 scripts/report-requirement-field-gaps.py --daily 2>&1); rc=$?
echo "$(date -Is) ${line:-rc=$rc no_output}" >> "$LOG"
exit $rc

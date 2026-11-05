#!/bin/bash
# #2887 的巡检：每天一行「桌面端线上版本 / 平台数 / 是否一致」。
#
# 生产机上的拷贝：$HOME/.commhub/desktop-release.sh（crontab 见下）
# 收进仓的理由与 hub-idle-poll-share.sh 同一条：仓外脚本没有 diff，也没有门看着它。
#
# 为什么「一次一行」而不是「只在失败时报」：
#   只在失败时报 ⇒「cron 没跑」与「一切正常」在日志上同形（都没有新行）
#   一次一行   ⇒ 最后一行太旧 = cron 坏了；verdict != ok = 线上不一致。两个故障各有读数
#
# 产出格式（一行，便于 grep 与人工扫）：
#   2026-11-05T22:10:00+08:00 rc=0 version=0.2.463 platforms=7 verdict=ok
export PATH="$HOME/.nvm/versions/node/v20.20.0/bin:/usr/local/bin:/usr/bin:/bin"
LOG="${DESKTOP_RELEASE_LOG:-$HOME/.commhub/desktop-release.log}"
REPO=${REPO:-$HOME/anet-main}

cd "$REPO" || { echo "$(date -Is) rc=99 cd_failed repo=$REPO" >> "$LOG"; exit 99; }
out=$(python3 scripts/check-desktop-release.py --assert 2>&1); rc=$?
ver=$(printf '%s\n' "$out" | grep -oE 'version: [0-9.]+' | head -1 | awk '{print $2}')
plats=$(printf '%s\n' "$out" | grep -oE 'platforms: [0-9]+' | head -1 | awk '{print $2}')
if [ "$rc" = "0" ]; then verdict=ok; elif [ "$rc" = "2" ]; then verdict=unreadable; else verdict=inconsistent; fi
echo "$(date -Is) rc=$rc version=${ver:-unknown} platforms=${plats:-unknown} verdict=$verdict" >> "$LOG"
exit $rc

#!/bin/bash
# #3952 的巡检：每天一行「有多少节点在报 token 用量 / 合计多少」。
#
# 生产机上的拷贝：$HOME/.commhub/node-token-usage.sh（crontab 见下）
# 收进仓的理由与其它巡检脚本同一条：仓外脚本没有 diff，也没有门看着它。
#
# 为什么一次一行而不是只在失败时报：
#   只在失败时报 ⇒「cron 没跑」与「一切正常」在日志上同形（都没有新行）
#   一次一行   ⇒ 最后一行太旧 = cron 坏了；nodes=0 = **没人上报**（这才是要盯的那件事）
#
# 产出格式（一行）：
#   2026-11-05T23:10:00+08:00 rc=0 nodes=3 total=1234567 cache=89012345
export PATH="$HOME/.nvm/versions/node/v20.20.0/bin:/usr/local/bin:/usr/bin:/bin"
LOG="${NODE_TOKEN_USAGE_LOG:-$HOME/.commhub/node-token-usage.log}"
REPO=${REPO:-$HOME/anet-main}
HOURS="${NODE_TOKEN_USAGE_HOURS:-24}"

cd "$REPO" || { echo "$(date -Is) rc=99 cd_failed repo=$REPO" >> "$LOG"; exit 99; }
out=$(python3 scripts/report-node-token-usage.py --hours "$HOURS" 2>&1); rc=$?

# 从报表里抽「有用量的节点 N 个」和第一行数据的总量
nodes=$(printf '%s\n' "$out" | grep -oE '有用量的节点 [0-9]+' | grep -oE '[0-9]+' | head -1)
total=$(printf '%s\n' "$out" | grep -E '^[^ ]+ +[0-9,]+ +[0-9,]+ +[0-9,]+' | head -1 | awk '{gsub(/,/,"",$4); print $4}')
cache=$(printf '%s\n' "$out" | grep -E '^[^ ]+ +[0-9,]+ +[0-9,]+ +[0-9,]+' | head -1 | awk '{gsub(/,/,"",$5); print $5}')

# 能力分母：有多少节点**装的是会报 token 的那一版**（>= 2.5.0-preview.180）。
# 没有这个分母时，nodes=1 会被读成「只有一个节点在干活」，
# 而实际可能是「只有一个节点有这能力」—— 两者在报表上同形（#3950）。
capable=$(python3 - "$HOME/.commhub/commhub.db" <<'PY2' 2>/dev/null || echo "?"
import sqlite3, sys, re
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
n = 0
for (v,) in c.execute("SELECT version FROM sessions WHERE version IS NOT NULL"):
    m = re.match(r"^2\.5\.0-preview\.(\d+)$", str(v).strip())
    if m and int(m.group(1)) >= 180:
        n += 1
print(n)
PY2
)

# rc=2 表示读不到库/表 —— 那是「没有读数」，与「用量为 0」不同形，必须写进同一行
# nodes/capable 是「在报/能报」，别把前者当覆盖率
echo "$(date -Is) rc=$rc nodes=${nodes:-?}/${capable:-?} total=${total:-0} cache=${cache:-0}" >> "$LOG"
exit $rc

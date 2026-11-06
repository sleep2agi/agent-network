#!/bin/bash
# 飞书通道的每日一行巡检：只记状态，不修东西。
#
# 为什么需要：这台节点的 agent-node/agent-network 版本是**跟着全局包走**的
# （别的节点发版 → 一次升级 → 节点重启）。升级本身不会丢配置，但"丢了"与
# "没丢"在日志里长得一样：都只是没有新消息。所以每天记一行可判的读数：
#
#   日期 | channels有feishu? | worker在? | 长连接ESTAB? | 白名单非通配?
#
# 判读：
#   最后一行太旧           ⇒ cron 坏了（不是"一切正常"）
#   channels=0             ⇒ 配置被覆盖（升级/编辑事故）
#   worker=0 / estab=0     ⇒ 桥没起或连不上
#   wildcard=1             ⇒ 白名单被写回通配符（安全回退）
#
# 一次一行而不是"只在异常时报"：只在异常时报的话，"没跑"与"没问题"同形。
export HOME=/home/vansin
export PATH="/home/vansin/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin"
LOG=/home/vansin/.commhub/feishu-doctor.log
NODE_DIR=${NODE_DIR:-/home/vansin/comm-feishu-ou/.anet/nodes/通信飞书欧}
CH="$NODE_DIR/channels/feishu"

ch=0
python3 -c "
import json,sys
d=json.load(open('$NODE_DIR/config.json'))
sys.exit(0 if any(str(c).startswith('feishu') for c in (d.get('channels') or [])) else 1)" 2>/dev/null && ch=1

wk=0; es=0
PID=$(pgrep -f "feishu/worker.js" | head -1)
if [ -n "$PID" ]; then
  wk=1
  ss -tnp 2>/dev/null | grep -q "pid=$PID" && es=1
fi

wc=0
python3 -c "
import json,sys
d=json.load(open('$CH/access.json'))
sys.exit(0 if '*' in (d.get('allowFrom') or []) else 1)" 2>/dev/null && wc=1

echo "$(date -Is) channels=$ch worker=$wk estab=$es wildcard=$wc" >> "$LOG"

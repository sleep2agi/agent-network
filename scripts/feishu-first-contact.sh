#!/bin/bash
# 第一条飞书消息到达后的一键接手：
#   从今天的节点日志里取出第一个真实 open_id → 收紧白名单（去掉 *）→ 登记角色
#   → 重启 → 回读确认 → 打印这条事件与随后的回复线索。
#
# 用法： bash scripts/feishu-first-contact.sh [node名] [角色] [--dry-run]
#   默认节点 通信飞书欧，角色 admin
#
# 设计取舍：
#   · 只认**今天**的日志，且只取 `[feishu] event from=` 这一种行 —— 不从别处猜 id。
#   · 找不到就明确说"还没有第一条消息"，不改任何文件（这条命令不是"清空白名单"的工具）。
#   · 幂等：如果 allowFrom 已经不含 *，就只报告、不再改写。
set -u
NODE=${1:-通信飞书欧}
ROLE=${2:-admin}
DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done
NODE_DIR="$HOME/comm-feishu-ou/.anet/nodes/$NODE"
CH="$NODE_DIR/channels/feishu"
LOG="$NODE_DIR/logs/$(date +%Y-%m-%d).log"
ALLOW_SCRIPT="$(dirname "$0")/feishu-allow-user.sh"

echo "== 第一条消息接手：$NODE =="
if [ ! -f "$LOG" ]; then echo "✗ 没有今天的日志：$LOG"; exit 2; fi

# 只认这一种行： [feishu] event from=ou_xxx ... text="..."
LINE=$(grep -a "\[feishu\] event from=" "$LOG" | tail -1)
if [ -z "$LINE" ]; then
  echo "还没有第一条消息（今天日志里没有 '[feishu] event from='）。"
  echo "→ 请在飞书里私聊机器人发一句，然后重跑本命令。"
  exit 3
fi
OPEN_ID=$(printf '%s' "$LINE" | sed -n 's/.*from=\([^ ]*\).*/\1/p')
if [ -z "$OPEN_ID" ] || ! printf '%s' "$OPEN_ID" | grep -q "^ou_"; then
  echo "✗ 从日志里取不到合法 open_id（拿到：'$OPEN_ID'）"; echo "  原行：$LINE"; exit 4
fi
echo "找到 open_id：$OPEN_ID"
echo "原行：$(printf '%s' "$LINE" | cut -c1-160)"

if python3 -c "
import json,sys
d=json.load(open('$CH/access.json'))
sys.exit(0 if '*' in (d.get('allowFrom') or []) else 1)"; then
  echo "→ 白名单仍是通配符，开始收紧"
else
  echo "→ 白名单里已经没有 *（之前收紧过），只报告不改写"
  python3 -c "import json;print(json.load(open('$CH/access.json')))"
  exit 0
fi

ARGS=("$OPEN_ID" "$ROLE" "$NODE")
[ "$DRY" = "1" ] && ARGS+=("--dry-run")
bash "$ALLOW_SCRIPT" "${ARGS[@]}"

echo
echo "== 接手完成后的核对 =="
python3 -c "
import json;d=json.load(open('$CH/access.json'))
print('allowFrom =', d.get('allowFrom'))
print('users     =', d.get('users'))"
grep -a "bridge online" "$NODE_DIR/logs/copresence-bridge.log" 2>/dev/null | tail -1
grep -a "\[feishu\]" "$LOG" | tail -3

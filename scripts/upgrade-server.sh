#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║  CommHub Server Upgrade — Safe Production Upgrade     ║
# ║  Run: bash scripts/upgrade-server.sh                  ║
# ╚══════════════════════════════════════════════════════╝
set -e

C_GREEN='\033[0;32m'
C_YELLOW='\033[1;33m'
C_RED='\033[0;31m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

HUB="http://127.0.0.1:9200"

echo -e "${C_BOLD}CommHub Server Upgrade${C_RESET}"
echo ""

# Step 1: Pre-flight checks
echo -e "${C_YELLOW}[1/5]${C_RESET} Pre-flight checks..."
OLD_HEALTH=$(curl -sf "$HUB/health" 2>/dev/null || echo "{}")
OLD_VER=$(echo "$OLD_HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo "unknown")
OLD_SESSIONS=$(echo "$OLD_HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sessions_count',0))" 2>/dev/null || echo "0")
echo "  Current version: $OLD_VER"
echo "  Active sessions: $OLD_SESSIONS"
echo "  Database: $(ls -lh ~/.commhub/commhub.db 2>/dev/null | awk '{print $5}')"

# Step 2: Backup database
echo -e "${C_YELLOW}[2/5]${C_RESET} Backing up database..."
cp ~/.commhub/commhub.db ~/.commhub/commhub.db.bak.$(date +%Y%m%d_%H%M%S)
echo "  Backup: ~/.commhub/commhub.db.bak.$(date +%Y%m%d_%H%M%S)"

# Step 3: Update npm package
#
# 🔴 #2141 —— 这里原来是不带 tag 的 `npm i -g @sleep2agi/commhub-server`,
#    也就是装 `latest` dist-tag。2026-10-23 实测 `latest` 还停在 .139，而当时
#    已经发布的 preview 是 .145 —— 这条命令会把**不含头像上传/会话控制的旧包**
#    装到机器上，而输出只会说"installed"，看不出装的是哪一版。
#
#    改用显式 `@preview`：当前唯一在推进的通道就是 preview。**不去推 latest**
#    (那等于替所有人做隐式升级)，而是把"装哪一版"写进命令里。
HUB_SERVER_TAG="${HUB_SERVER_TAG:-preview}"
echo -e "${C_YELLOW}[3/5]${C_RESET} Updating @sleep2agi/commhub-server@${HUB_SERVER_TAG}..."
npm i -g "@sleep2agi/commhub-server@${HUB_SERVER_TAG}" 2>&1 | tail -3
NEW_PKG_VER=$(npm ls -g @sleep2agi/commhub-server 2>/dev/null | grep commhub-server | grep -o '[0-9][^ ]*' || echo "?")
echo "  Installed: $NEW_PKG_VER"
# 版本回读：把"装到的"和"通道上的"并排打出来，别让"installed"一句糊过去。
PUBLISHED_VER=$(npm view "@sleep2agi/commhub-server@${HUB_SERVER_TAG}" version 2>/dev/null || echo "?")
echo "  Channel ${HUB_SERVER_TAG} on npm: $PUBLISHED_VER"
if [ "$NEW_PKG_VER" != "$PUBLISHED_VER" ]; then
  echo -e "  ${C_RED}⚠ installed ($NEW_PKG_VER) != channel ($PUBLISHED_VER)${C_RESET}"
  echo "    npm 可能用了缓存；`npm cache verify` 或显式钉版本再试。"
fi

# Step 4: Restart server
echo -e "${C_YELLOW}[4/5]${C_RESET} Restarting CommHub..."
# Find the tmux session running the server
TMUX_SESSION=$(tmux list-panes -a -F '#{session_name}:#{pane_pid}' 2>/dev/null | while read line; do
  sess=${line%%:*}; pid=${line##*:}
  if ps --ppid "$pid" -o args= 2>/dev/null | grep -q "commhub\|anet server"; then
    echo "$sess"; break
  fi
done)

if [ -n "$TMUX_SESSION" ]; then
  echo "  Found server in tmux session: $TMUX_SESSION"
  # Send Ctrl+C and restart
  tmux send-keys -t "$TMUX_SESSION" C-c
  sleep 2
  tmux send-keys -t "$TMUX_SESSION" "anet server start --port 9200" Enter
  echo "  Server restarting..."
else
  echo -e "  ${C_RED}Could not find server tmux session${C_RESET}"
  echo "  Manual restart needed: anet server start --port 9200"
fi

# Step 5: Verify
echo -e "${C_YELLOW}[5/5]${C_RESET} Verifying..."
sleep 3
NEW_HEALTH=$(curl -sf "$HUB/health" 2>/dev/null || echo "{}")
NEW_VER=$(echo "$NEW_HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','FAILED'))" 2>/dev/null || echo "FAILED")

if [ "$NEW_VER" != "FAILED" ]; then
  echo -e "  ${C_GREEN}Server running: v$NEW_VER${C_RESET}"
  echo ""
  echo -e "${C_GREEN}${C_BOLD}Upgrade complete!${C_RESET} $OLD_VER → $NEW_VER"
  echo ""
  echo "Rollback: cp ~/.commhub/commhub.db.bak.* ~/.commhub/commhub.db && anet server start"
else
  echo -e "  ${C_RED}Server not responding!${C_RESET}"
  echo ""
  echo "Rollback steps:"
  echo "  1. npm i -g @sleep2agi/commhub-server@0.5.0-preview.24"
  echo "  2. cp ~/.commhub/commhub.db.bak.* ~/.commhub/commhub.db"
  echo "  3. anet server start --port 9200"
  exit 1
fi

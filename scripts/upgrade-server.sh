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
echo -e "${C_YELLOW}[3/5]${C_RESET} Updating @sleep2agi/commhub-server..."
npm i -g @sleep2agi/commhub-server 2>&1 | tail -3
NEW_PKG_VER=$(npm ls -g @sleep2agi/commhub-server 2>/dev/null | grep commhub-server | grep -o '[0-9].*' || echo "?")
echo "  Installed: $NEW_PKG_VER"

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

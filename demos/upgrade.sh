#!/usr/bin/env bash
# One-shot upgrade to the latest stable Agent Network release (v2.1+):
#   - anet CLI            -> @sleep2agi/agent-network@latest
#   - Web Dashboard       -> @sleep2agi/agent-network-dashboard (via npx, cache cleared)
# Hub and agent processes are not touched directly — only the CLI + Dashboard.
#
# Usage (on a host that already ran setup-anet.sh):
#   curl -fsSL https://anet.sh/upgrade.sh | bash
#
# Steps:
#   1. Upgrade the anet CLI to the latest stable
#   2. Kill the running anet-dashboard tmux session
#   3. Clear the npx cache so the new pinned Dashboard version is pulled
#   4. Restart the Dashboard in the same tmux session

set -euo pipefail

# Must run as a non-root user (same permission model as setup-anet.sh)
if [ "$(id -u)" -eq 0 ]; then
  echo "[!] Running as root. Switch to the anet user first:  su - anet"
  echo "    Then re-run this command."
  exit 1
fi

# Make sure npm-global is on PATH
export PATH=~/.npm-global/bin:$PATH

echo "[1/4] Upgrading anet CLI to the latest stable ..."
npm i -g @sleep2agi/agent-network --silent 2>&1 | tail -3
anet -v | head -1

echo ""
echo "[2/4] Stopping the dashboard tmux session ..."
tmux kill-session -t anet-dashboard 2>/dev/null || true

echo ""
echo "[3/4] Clearing the npx cache (so the new Dashboard version is pulled) ..."
rm -rf ~/.npm/_npx

echo ""
echo "[4/4] Restarting the dashboard ..."
HUB_IP="${ANET_HUB_IP:-0.0.0.0}"
PATH_PREFIX="PATH=~/.npm-global/bin:\$PATH"
tmux new-session -d -s anet-dashboard -n dashboard "$PATH_PREFIX anet hub dashboard --ip $HUB_IP; bash"

# Give it up to 30s to pull packages + start
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:3000 -o /dev/null 2>&1; then break; fi
  sleep 1
done

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "================================================================"
echo "  Dashboard (stable) is up"
echo "  Open:  http://$LAN_IP:3000   (admin / anethub)"
echo ""
echo "  Current stable line (v0.8.2 / CLI v2.1.7) ships:"
echo "    - anet doctor --fix auto-migrates legacy V2 node configs"
echo "    - anet demo {ls,debate,socialmedia} subcommands"
echo "    - Hub telemetry double-write (tasks page + send_reply fix)"
echo "    - Dashboard themes + useSSE reconnect-loop fix"
echo ""
echo "  Browser tip: hard refresh once (Cmd+Shift+R) to drop cached JS."
echo "  Live dashboard logs:  tmux a -t anet-dashboard"
echo "================================================================"

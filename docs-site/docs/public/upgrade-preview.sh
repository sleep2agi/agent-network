#!/usr/bin/env bash
# Upgrade an Agent Network host to the *preview* channel.
#
# Channel-aware via #88 `anet upgrade --channel preview` (resolves whatever
# is globally installed: CLI / agent-node / commhub-server / dashboard).
# Falls back to `npm i -g @sleep2agi/agent-network@preview` if anet isn't
# installed yet. Mirror of upgrade.sh — only the channel differs.
#
# Usage (on a host that already ran setup-anet.sh):
#   curl -fsSL https://anet.sh/upgrade-preview.sh | bash

set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "[!] Running as root. Switch to the anet user first:  su - anet"
  echo "    Then re-run this command."
  exit 1
fi

export PATH=~/.npm-global/bin:$PATH

echo "[1/4] Upgrading agent-network (channel: preview) ..."
if command -v anet >/dev/null 2>&1; then
  anet upgrade --channel preview
else
  echo "    (anet not installed yet — bootstrapping with npm i -g @preview)"
  npm i -g @sleep2agi/agent-network@preview --silent 2>&1 | tail -3
  anet -v | head -1
fi

echo ""
echo "[2/4] Stopping the dashboard tmux session ..."
tmux kill-session -t anet-dashboard 2>/dev/null || true

echo ""
echo "[3/4] Clearing the npx cache (so the new preview dashboard is pulled) ..."
rm -rf ~/.npm/_npx

echo ""
echo "[4/4] Restarting the dashboard ..."
HUB_IP="${ANET_HUB_IP:-0.0.0.0}"
PATH_PREFIX="PATH=~/.npm-global/bin:\$PATH"
tmux new-session -d -s anet-dashboard -n dashboard "$PATH_PREFIX anet hub dashboard --ip $HUB_IP; bash"

for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:3000 -o /dev/null 2>&1; then break; fi
  sleep 1
done

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
ANET_VERSION="$(anet --version 2>/dev/null | head -1 || echo 'unknown')"

echo ""
echo "================================================================"
echo "  ✅ Preview upgrade complete — $ANET_VERSION"
echo ""
echo "  Dashboard:  http://$LAN_IP:3000   (admin / anethub)"
echo "  Browser:    hard refresh once (Cmd+Shift+R) to drop cached JS"
echo "  Logs:       tmux a -t anet-dashboard"
echo ""
echo "  Restart any running nodes to pick up new versions (#117):"
echo "    cd ~/anodes && anet project restart"
echo ""
echo "  Back to stable? Run:"
echo "    curl -fsSL https://anet.sh/upgrade.sh | bash"
echo "================================================================"

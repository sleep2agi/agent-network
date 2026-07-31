#!/usr/bin/env bash
# One-shot upgrade for an Agent Network host.
#
# Delegates to `anet upgrade --channel latest` when anet is already installed
# (channel-aware multi-package upgrade — #88), and falls back to a plain
# `npm install -g @sleep2agi/agent-network@latest` if only the CLI is missing.
# This upgrades an existing host; it is not a fresh-server installer.
# Either way, the dashboard tmux session is restarted.
#
# Usage (on a host with an existing Agent Network installation):
#   curl -fsSL https://anet.sh/upgrade.sh | bash
#
# Steps:
#   1. Run `anet upgrade --channel latest` (or fallback npm install)
#   2. Kill the running anet-dashboard tmux session
#   3. Restart the Dashboard in the same tmux session

set -euo pipefail

# Must run as the non-root user that owns the Agent Network installation.
if [ "$(id -u)" -eq 0 ]; then
  echo "[!] Running as root. Switch to the anet user first:  su - anet"
  echo "    Then re-run this command."
  exit 1
fi

# Make sure npm-global is on PATH.
export PATH=~/.npm-global/bin:$PATH

echo "[1/3] Upgrading agent-network (channel: latest) ..."
if command -v anet >/dev/null 2>&1; then
  # Channel-aware multi-package upgrade (#88). anet upgrade resolves the
  # right dist-tag, surfaces the plan, and installs whatever is globally
  # installed (CLI / agent-node / commhub-server / dashboard).
  anet upgrade --channel latest
else
  # No anet binary yet — bootstrap with a plain global install.
  echo "    (anet not installed yet — bootstrapping with npm i -g)"
  npm i -g @sleep2agi/agent-network@latest --silent 2>&1 | tail -3
  anet -v | head -1
fi

echo ""
echo "[2/3] Stopping the dashboard tmux session ..."
tmux kill-session -t anet-dashboard 2>/dev/null || true

echo ""
echo "[3/3] Restarting the dashboard ..."
DASHBOARD_HOST="${ANET_DASHBOARD_HOST:-${ANET_HUB_IP:-127.0.0.1}}"
PATH_PREFIX="PATH=~/.npm-global/bin:\$PATH"
tmux new-session -d -s anet-dashboard -n dashboard "$PATH_PREFIX anet hub dashboard --ip $DASHBOARD_HOST; bash"

# Give it up to 30s to pull packages + start.
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:3000 -o /dev/null 2>&1; then break; fi
  sleep 1
done

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
ANET_VERSION="$(anet --version 2>/dev/null | head -1 || echo 'unknown')"
if [ "$DASHBOARD_HOST" = "0.0.0.0" ]; then
  DASHBOARD_URL="http://${LAN_IP:-127.0.0.1}:3000"
else
  DASHBOARD_URL="http://$DASHBOARD_HOST:3000"
fi

echo ""
echo "================================================================"
echo "  ✅ Upgrade complete — $ANET_VERSION"
echo ""
echo "  Dashboard:  $DASHBOARD_URL"
echo "  Account:    use the existing Hub username and password (upgrade does not reset them)"
echo "  Browser:    hard refresh once (Cmd+Shift+R) to drop cached JS"
echo "  Logs:       tmux a -t anet-dashboard"
echo ""
echo "  Restart any running nodes to pick up new versions (#117):"
echo "    cd ~/anodes && anet project restart"
echo ""
echo "  Preview channel? Run:"
echo "    curl -fsSL https://anet.sh/upgrade-preview.sh | bash"
echo "================================================================"

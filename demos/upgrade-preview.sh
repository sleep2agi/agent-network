#!/usr/bin/env bash
# Compatibility shim — the preview track is no longer the recommended path.
#
# As of the v0.8.2 / CLI v2.1.7 stable line, `latest` is the recommended track. This script now
# delegates to the stable upgrade script (upgrade.sh). If you genuinely
# need to track preview, run:
#     npm i -g @sleep2agi/agent-network@preview
# manually and restart your dashboard.

set -euo pipefail

cat <<'BANNER'
================================================================
  NOTE: the preview track is no longer the recommended path.
  Falling back to the stable upgrade (upgrade.sh).
  v0.8.2 / CLI v2.1.7 is the current stable line on the npm `latest` tag.

  If you specifically want the preview channel, run manually:
    npm i -g @sleep2agi/agent-network@preview
    tmux kill-session -t anet-dashboard 2>/dev/null || true
    rm -rf ~/.npm/_npx
    tmux new -d -s anet-dashboard 'anet hub dashboard --ip 0.0.0.0; bash'
================================================================
BANNER

# Delegate to the stable upgrade flow. Prefer a local copy next to this
# script; otherwise pull from the public docs origin.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/upgrade.sh" ]; then
  exec bash "$SCRIPT_DIR/upgrade.sh"
else
  exec bash -c "$(curl -fsSL https://anet.sh/upgrade.sh)"
fi

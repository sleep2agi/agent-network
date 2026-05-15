#!/bin/sh
# Agent Network — one-line installer
# Source: https://anet.sh/install.sh
# Repo:   https://github.com/sleep2agi/agent-network
#
# Usage:
#   curl -fsSL https://anet.sh/install.sh | sh
#
# What this does:
#   1. Verifies Node.js >= 22.13 and npm are available
#   2. Installs @sleep2agi/agent-network globally via npm
#   3. Prints next steps
#
# Why Node 22.13: agent-node preview.9+ ships engines requirement
# `"node": ">=22.13.0"` (npm refuses install on older Node).

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

say()  { printf "%b\n" "$*"; }
fail() { say "${RED}error:${RESET} $*" >&2; exit 1; }

say "${CYAN}>${RESET} Agent Network installer"
say "${DIM}  https://anet.sh${RESET}"
say ""

# --- Prereqs ---
command -v node >/dev/null 2>&1 || fail "Node.js >= 22.13 required. Install from https://nodejs.org or via nvm."
command -v npm  >/dev/null 2>&1 || fail "npm not found. Install Node.js (it bundles npm)."

# agent-network preview.9+ pins engines >=22.13 (agent-node SDK requirement).
# Older Node will fail at install time with a misleading EBADENGINE — check early.
NODE_OK=$(node -p "(function(){var p=process.versions.node.split('.').map(Number);return (p[0]>22)||(p[0]===22&&p[1]>=13)?1:0})()" 2>/dev/null || echo 0)
if [ "$NODE_OK" != "1" ]; then
  fail "Node.js >= 22.13 required (current: $(node -v)). Upgrade with: nvm install 22 && nvm use 22"
fi

say "  node: $(node -v)"
say "  npm : $(npm -v)"
say ""

# --- Install ---
say "${CYAN}>${RESET} Installing ${YELLOW}@sleep2agi/agent-network${RESET} globally..."
npm install -g @sleep2agi/agent-network >/dev/null 2>&1 || {
  say "${YELLOW}!${RESET} Default registry failed, retrying via npmmirror..."
  npm install -g @sleep2agi/agent-network --registry https://registry.npmmirror.com
}

# --- Verify ---
if ! command -v anet >/dev/null 2>&1; then
  fail "Install completed but 'anet' command not on PATH. Check 'npm config get prefix' and your PATH."
fi

ANET_VERSION=$(anet --version 2>/dev/null || echo "?")

say ""
say "${GREEN}done.${RESET}  anet ${ANET_VERSION}"
say ""
say "Next steps:"
say "  ${CYAN}anet hub start${RESET}          start CommHub server"
say "  ${CYAN}anet hub dashboard${RESET}      open web UI on :3000"
say "  ${CYAN}anet demo debate${RESET}        try the 6-agent debate"
say ""
say "After running nodes:"
say "  ${CYAN}anet project up${RESET}         start every cwd node (auto-resume, #117)"
say "  ${CYAN}anet project restart${RESET}    restart every cwd node after a machine reboot"
say "  ${CYAN}anet upgrade${RESET}            channel-aware multi-package upgrade (#88)"
say ""
say "Docs:   ${DIM}https://anet.sh${RESET}"
say "GitHub: ${DIM}https://github.com/sleep2agi/agent-network${RESET}"

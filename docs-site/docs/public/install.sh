#!/bin/sh
# Agent Network — one-line installer
# Source: https://anet.sh/install.sh
# Repo:   https://github.com/sleep2agi/agent-network
#
# Usage:
#   curl -fsSL https://anet.sh/install.sh | sh
#
# What this does:
#   1. Verifies Node.js >= 20 and npm are available
#   2. Installs @sleep2agi/agent-network globally via npm
#   3. Prints next steps

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
command -v node >/dev/null 2>&1 || fail "Node.js >= 20 required. Install from https://nodejs.org or via nvm."
command -v npm  >/dev/null 2>&1 || fail "npm not found. Install Node.js (it bundles npm)."

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js >= 20 required (current: $(node -v))."
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
say "Docs:   ${DIM}https://anet.sh${RESET}"
say "GitHub: ${DIM}https://github.com/sleep2agi/agent-network${RESET}"

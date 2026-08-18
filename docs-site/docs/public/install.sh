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
# Keep the first attempt's stderr. It used to be discarded with `2>&1` to
# /dev/null and EVERY failure was then reported as "Default registry failed" —
# so a permission error, a full disk, or an unsupported Node version all told
# the reader to blame the registry, and the npmmirror retry failed the same way
# a moment later. The reader was left with a confident, wrong story.
NPM_LOG="$(mktemp -t anet-install.XXXXXX)"
if ! npm install -g @sleep2agi/agent-network >"$NPM_LOG" 2>&1; then
  # Only claim "registry" when the output actually looks like a fetch problem.
  # Anything else is shown verbatim, because a wrong diagnosis sends the reader
  # somewhere there is nothing to find.
  if grep -qiE 'ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|registry|fetch failed|socket hang up' "$NPM_LOG"; then
    say "${YELLOW}!${RESET} Default registry looks unreachable, retrying via npmmirror..."
    if ! npm install -g @sleep2agi/agent-network --registry https://registry.npmmirror.com; then
      say ""
      say "${YELLOW}!${RESET} The mirror failed too. First attempt said:"
      tail -n 20 "$NPM_LOG" >&2
      rm -f "$NPM_LOG"
      fail "npm install failed against both registries — see the output above."
    fi
  else
    say ""
    say "${YELLOW}!${RESET} npm install failed, and it does not look like a registry problem."
    say "  Retrying a different registry would fail the same way, so here is what npm said:"
    tail -n 20 "$NPM_LOG" >&2
    rm -f "$NPM_LOG"
    fail "npm install failed — see the output above."
  fi
fi
rm -f "$NPM_LOG"

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

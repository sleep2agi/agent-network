#!/usr/bin/env bash
# tests/scripts/lint-no-bare-rm-rf.sh — CI guard against bare `rm -rf $VAR`
#
# WHY THIS EXISTS
# ===============
# 2026-06-16 07:26 incident: a test script ran `rm -rf $HOME` where $HOME
# fell back to the real /home/<user>; ai-insight / blueleap / paper repos
# wiped (cloud-snapshot restored). Subsequent sweep (commit 826c8a7)
# rewrote 40 scripts to use `safe_rm_rf` from `tests/lib/safe-rm.sh`.
# This linter ensures no new script regresses.
#
# RULE
# ====
# Any line under `tests/` or `agent-network/tests/` matching the pattern
# `rm -rf $VAR` / `rm -rf "$VAR/..."` is REJECTED. Use `safe_rm_rf`
# instead (sources `tests/lib/safe-rm.sh` at script top).
#
# EXEMPT
# ======
#   - lines containing `safe_rm_rf` (the helper itself)
#   - comments (line starts with `#`)
#   - the helper file (tests/lib/safe-rm.sh)
#   - this linter (tests/scripts/lint-no-bare-rm-rf.sh)
#
# USAGE
# =====
#   ./tests/scripts/lint-no-bare-rm-rf.sh
#   # exit 0 = clean, exit 1 = violations found (printed to stderr)
#
# CI HOOK
# =======
#   .husky/pre-commit or .github/workflows/lint.yml should invoke this on
#   every commit / PR. Failing exit blocks the merge.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.."
cd "$REPO_ROOT"

PATTERN='rm -rf [^/]*\$[A-Za-z_{]'

violations=$(grep -rnE \
  --include='*.sh' --include='*.bash' --include='*.zsh' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
  "$PATTERN" \
  tests/ agent-network/tests/ 2>/dev/null \
  | grep -v ':[[:space:]]*#' \
  | grep -v 'safe_rm_rf' \
  | grep -v 'tests/lib/safe-rm.sh:' \
  | grep -v 'tests/scripts/lint-no-bare-rm-rf.sh:' \
  | grep -vE '(echo|printf)[[:space:]].*rm -rf' \
  || true)

if [ -n "$violations" ]; then
  echo "❌ [lint-no-bare-rm-rf] FAIL — found bare \`rm -rf \$VAR\` (no /tmp prefix, no safe_rm_rf wrapper):" >&2
  echo "" >&2
  echo "$violations" >&2
  echo "" >&2
  echo "FIX:" >&2
  echo "  1. Source the helper at top of the script:" >&2
  echo "       source \"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)/../lib/safe-rm.sh\"" >&2
  echo "  2. Replace 'rm -rf \$VAR' with 'safe_rm_rf \$VAR'" >&2
  echo "" >&2
  echo "WHY: see tests/lib/safe-rm.sh (2026-06-16 incident — \$HOME fell back to real /home/<user>, wiped projects)." >&2
  exit 1
fi

echo "✓ [lint-no-bare-rm-rf] clean — no bare rm -rf \$VAR in tests/ or agent-network/tests/"
exit 0

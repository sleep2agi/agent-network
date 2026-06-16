#!/usr/bin/env bash
# tests/lib/safe-rm.sh — destructive-rm guardrail for ALL test scripts.
#
# WHY THIS EXISTS
# ===============
# 2026-06-16 07:26 incident: tests/test-new-user-flow.sh ran `rm -rf $HOME`
# where $HOME accidentally pointed at the real `/home/vansin` (the export
# that sandboxed it had been lost / shadowed). Vincent's ai-insight /
# blueleap / paper repos were wiped; cloud-snapshot restored. Subsequent
# audit (通信龙 dispatch 0c9a2505) found ~40 test scripts with the same
# pattern: `rm -rf "$HOME/..."` / `rm -rf "$VAR"` with no guard rail.
#
# WHAT THIS DOES
# ==============
# Defines `safe_rm_rf <path>...` — refuses to proceed if ANY supplied path
# resolves outside the allow-listed prefixes (`/tmp/*` by default, opt-in
# more via SAFE_RM_ALLOW_PREFIXES). On refusal: loud stderr + exit 99,
# no `rm` invoked. Drop-in replacement for `rm -rf` in test scripts.
#
# USAGE
# =====
#   # at the top of any test script (after shebang, before any rm):
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
#   ...
#   safe_rm_rf "$HOME" "$WORK" "$ARGS_LOG"
#
# OPT-IN PREFIXES
# ===============
# Default allow-list = `/tmp/*`. Adjust per script BEFORE the call by
# exporting:
#   SAFE_RM_ALLOW_PREFIXES="/tmp/ /var/tmp/"   # space-separated
#
# Anything outside the allow-list aborts the test with exit 99, e.g.:
#   [safe_rm_rf] REFUSE: '/home/vansin' is outside allow-list (/tmp/).
#                Aborting to avoid wiping a real directory.

safe_rm_rf() {
  local _allow="${SAFE_RM_ALLOW_PREFIXES:-/tmp/}"
  local _path _matched _prefix
  for _path in "$@"; do
    # Empty arg is suspicious — `rm -rf "" foo` historically yielded `rm -rf foo`
    # if first arg's quoting collapsed. Refuse rather than silently strip.
    if [ -z "$_path" ]; then
      echo "[safe_rm_rf] REFUSE: empty path argument — refusing to proceed." >&2
      return 99
    fi
    _matched=0
    for _prefix in $_allow; do
      case "$_path" in
        "$_prefix"*) _matched=1; break ;;
      esac
    done
    if [ "$_matched" = "0" ]; then
      echo "[safe_rm_rf] REFUSE: '$_path' is outside allow-list ($_allow)." >&2
      echo "[safe_rm_rf]   Aborting to avoid wiping a real directory." >&2
      echo "[safe_rm_rf]   Args: $*" >&2
      return 99
    fi
  done
  rm -rf "$@"
}

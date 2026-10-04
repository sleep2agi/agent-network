#!/usr/bin/env bash
# Board #556 — agent-node finds a CJK-named co-presence session when the locale is
# not UTF-8 (agent-node half of #533). Runs ONLY in its Docker image, and only ever
# on a private tmux socket (ANET_TMUX_SOCKET → execTmux passes -S; every raw tmux
# call here passes -S).
set -euo pipefail

[[ -f /.dockerenv ]] || { echo "FAIL: test556 runs only inside its Docker image" >&2; exit 1; }
SOURCE_COMMIT=${TEST556_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: SOURCE_COMMIT must be one full lowercase Git SHA" >&2; exit 1; }
echo "# test556 — agent-node tmux -F output under LANG=C (source_commit=$SOURCE_COMMIT)"
tmux -V

cd /workspace
SUITE=tests/test556-node-tmux-format-locale
HELPER=agent-node/src/tmux-format.ts
SOCK=$(mktemp -d)/anet556.sock
export ANET_TMUX_SOCKET=$SOCK
unset TMUX TMUX_PANE TMUX_TMPDIR
export TERM=xterm
NAME='通信牛'
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS $*"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $*"; }

start_sessions() {
  # Created under a UTF-8 locale so the names are stored correctly; only the
  # readers below run under LANG=C. The `-appsrv` sibling shares the prefix.
  LC_ALL=C.UTF-8 tmux -S "$SOCK" new-session -d -s "$NAME" 'tail -f /dev/null'
  LC_ALL=C.UTF-8 tmux -S "$SOCK" new-session -d -s "${NAME}-appsrv" 'tail -f /dev/null'
  TUI_ID=$(LC_ALL=C.UTF-8 tmux -S "$SOCK" display-message -p -t "${NAME}:0.0" '#{session_id}' 2>/dev/null || true)
  [[ "$TUI_ID" =~ ^\$[0-9]+$ ]] || {
    # display-message -t with a CJK name can fail on some builds; read the id by exact name instead.
    TUI_ID=$(LC_ALL=C.UTF-8 tmux -S "$SOCK" list-sessions -F '#{session_name} #{session_id}' | awk -v n="$NAME" '$1 == n { print $2 }')
  }
}
stop_sessions() {
  tmux -S "$SOCK" kill-session -t "=${NAME}-appsrv" 2>/dev/null || true
  tmux -S "$SOCK" kill-session -t "=${NAME}" 2>/dev/null || true
}
# probe_under <expected id> <expected reason> → PROBE_RC
probe_under() {
  PROBE_RC=0
  env -u LC_ALL -u LC_CTYPE LANG=C bun "$SUITE/probe.ts" "$NAME" "$1" "$2" || PROBE_RC=$?
}

# ── control: the locale really sanitizes raw tmux output here ─────────────
start_sessions
echo "  (TUI session id $TUI_ID)"
raw=$(env -u LC_ALL -u LC_CTYPE LANG=C tmux -S "$SOCK" list-panes -a -F '#{session_name}')
if printf '%s\n' "$raw" | grep -qxF "$NAME"; then
  fail "control: LANG=C raw tmux still printed $NAME — this tmux does not sanitize, the test proves nothing"
else
  pass "control: LANG=C raw tmux output lost the CJK name ($(printf '%s' "$raw" | tr '\n' ' '))"
fi

# ── the fixed probes, real tmux, LANG=C ────────────────────────────────────
probe_under "$TUI_ID" running
[[ $PROBE_RC -eq 0 ]] && pass "codex-health sees $NAME running and relaunch reads its id under LANG=C" \
  || fail "probes did not find $NAME under LANG=C (rc=$PROBE_RC)"

# exact match only: with the TUI gone, the -appsrv sibling must not count as it
tmux -S "$SOCK" kill-session -t "$TUI_ID"
probe_under none session-missing
[[ $PROBE_RC -eq 0 ]] && pass "with only ${NAME}-appsrv left: session-missing, no id (no prefix match)" \
  || fail "prefix sibling was mistaken for $NAME (rc=$PROBE_RC)"
stop_sessions

# ── witnessed red: the same probes with `-u` removed from the helper ───────
echo "# test556 mutation — tmuxUtf8Args without -u, expecting the probes to miss $NAME"
ANCHOR='  return ["-u", ...args];'
grep -qxF "$ANCHOR" "$HELPER" || { echo "FAIL: mutation anchor missing (MUTATION_NOOP)"; exit 1; }
cp "$HELPER" /tmp/tmux-format.ts.orig
sed -i 's/^  return \["-u", \.\.\.args\];$/  return [...args];/' "$HELPER"
cmp -s "$HELPER" /tmp/tmux-format.ts.orig && { echo "FAIL: mutation changed nothing (MUTATION_NOOP)"; exit 1; }
start_sessions
probe_under "$TUI_ID" running
stop_sessions
cp /tmp/tmux-format.ts.orig "$HELPER"
[[ $PROBE_RC -ne 0 ]] && pass "mutant is red: without -u the probes miss $NAME (rc=$PROBE_RC)" \
  || fail "mutant stayed green — the probe check does not detect a missing -u"

# ── unit tests for the helper and its callers (real-tmux cases use -L sockets) ──
unit_rc=0
(cd agent-node && bun test src/tmux-format.test.ts src/runtime/codex-health.test.ts src/runtime/codex-appserver-relaunch.test.ts) || unit_rc=$?
[[ $unit_rc -eq 0 ]] && pass "unit: tmux-format / codex-health / codex-appserver-relaunch" || fail "unit tests rc=$unit_rc"

echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && echo "# test556 PASS" || echo "# test556 FAIL"
[[ $FAIL -eq 0 ]]

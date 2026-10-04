#!/usr/bin/env bash
# #533 — `anet attach` finds a CJK-named TUI session when the locale is not UTF-8.
# Runs ONLY in its Docker image, and only ever on a private tmux socket
# (ANET_TMUX_SOCKET → execTmux passes -S; every raw tmux call here passes -S).
set -euo pipefail

[[ -f /.dockerenv ]] || { echo "FAIL: test533 runs only inside its Docker image" >&2; exit 1; }
SOURCE_COMMIT=${TEST533_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: SOURCE_COMMIT must be one full lowercase Git SHA" >&2; exit 1; }
echo "# test533 — tmux -F output under LANG=C (source_commit=$SOURCE_COMMIT)"
tmux -V

cd /workspace
SUITE=tests/test533-tmux-format-locale
SOCK=$(mktemp -d)/anet533.sock
export ANET_TMUX_SOCKET=$SOCK
unset TMUX TMUX_PANE
export TERM=xterm
NAME='通信牛'
WORK=$(mktemp -d)
mkdir -p "$WORK/.anet/nodes/n533"
printf '{"node_name":"%s","runtime":"claude-code-cli"}\n' "$NAME" > "$WORK/.anet/nodes/n533/config.json"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS $*"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $*"; }

start_sessions() {
  # Created under a UTF-8 locale so the names are stored correctly; only the
  # readers below run under LANG=C. A prefix sibling proves no prefix fallback.
  LC_ALL=C.UTF-8 tmux -S "$SOCK" new-session -d -s "$NAME" 'sleep 8'
  LC_ALL=C.UTF-8 tmux -S "$SOCK" new-session -d -s "${NAME}-appsrv" 'sleep 60'
}
stop_sessions() {
  tmux -S "$SOCK" kill-session -t "=${NAME}-appsrv" 2>/dev/null || true
  tmux -S "$SOCK" kill-session -t "=${NAME}" 2>/dev/null || true
}

# attach_under <label> <cli path> → sets ATTACH_RC and ATTACH_OUT
attach_under() {
  local cli=$2
  ATTACH_OUT=$(cd "$WORK" && env -u LC_ALL -u LC_CTYPE LANG=C \
    script -qec "bun $cli attach $NAME" /dev/null 2>&1) && ATTACH_RC=0 || ATTACH_RC=$?
}

# ── control: the locale really sanitizes raw tmux output here ─────────────
start_sessions
raw=$(env -u LC_ALL -u LC_CTYPE LANG=C tmux -S "$SOCK" list-sessions -F '#{session_name}')
if printf '%s\n' "$raw" | grep -qxF "$NAME"; then
  fail "control: LANG=C raw tmux still printed $NAME — this tmux does not sanitize, the test proves nothing"
else
  pass "control: LANG=C raw tmux output lost the CJK name ($(printf '%s' "$raw" | tr '\n' ' '))"
fi

# ── the fixed helpers, real tmux, LANG=C ───────────────────────────────────
rows_rc=0
env -u LC_ALL -u LC_CTYPE LANG=C bun "$SUITE/rows.ts" "$NAME" || rows_rc=$?
[[ $rows_rc -eq 0 ]] && pass "helpers find $NAME under LANG=C" || fail "helpers did not find $NAME under LANG=C (rc=$rows_rc)"

# ── real `anet attach` under LANG=C ───────────────────────────────────────
attach_under fixed /workspace/agent-network/bin/cli.ts
if [[ $ATTACH_RC -eq 0 ]] && ! printf '%s' "$ATTACH_OUT" | grep -qF 'is not running'; then
  pass "anet attach $NAME (LANG=C) attached and returned 0 when the session ended"
else
  fail "anet attach $NAME (LANG=C) rc=$ATTACH_RC"; printf '%s\n' "$ATTACH_OUT" | tail -5
fi
stop_sessions

# ── witnessed red: the same attach with `-u` removed from the helper ──────
echo "# test533 mutation — tmuxUtf8Args without -u, expecting attach to miss $NAME"
ANCHOR='  return ["-u", ...args];'
grep -qxF "$ANCHOR" agent-network/src/tmux-format.ts || { echo "FAIL: mutation anchor missing (MUTATION_NOOP)"; exit 1; }
cp agent-network/src/tmux-format.ts /tmp/tmux-format.ts.orig
sed -i 's/^  return \["-u", \.\.\.args\];$/  return [...args];/' agent-network/src/tmux-format.ts
cmp -s agent-network/src/tmux-format.ts /tmp/tmux-format.ts.orig && { echo "FAIL: mutation changed nothing (MUTATION_NOOP)"; exit 1; }
start_sessions
attach_under mutant /workspace/agent-network/bin/cli.ts
mut_rows_rc=0
env -u LC_ALL -u LC_CTYPE LANG=C bun "$SUITE/rows.ts" "$NAME" >/dev/null 2>&1 || mut_rows_rc=$?
stop_sessions
cp /tmp/tmux-format.ts.orig agent-network/src/tmux-format.ts
if [[ $ATTACH_RC -ne 0 ]] && printf '%s' "$ATTACH_OUT" | grep -qF 'is not running'; then
  pass "mutant is red: attach reported '$NAME is not running' (rc=$ATTACH_RC)"
else
  fail "mutant stayed green (rc=$ATTACH_RC) — the attach check does not detect a missing -u"; printf '%s\n' "$ATTACH_OUT" | tail -5
fi
[[ $mut_rows_rc -ne 0 ]] && pass "mutant is red: helpers miss $NAME" || fail "mutant helpers still found $NAME"

# ── unit tests that need a real tmux (skipped in test745, which has none) ──
# Their real-tmux cases use the default socket of THIS container only.
unit_rc=0
(cd agent-network && bun test src/tmux-format.test.ts src/tmux-attach.test.ts src/tmux-pane-target.test.ts) || unit_rc=$?
[[ $unit_rc -eq 0 ]] && pass "unit: tmux-format / tmux-attach / tmux-pane-target" || fail "unit tests rc=$unit_rc"

echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && echo "# test533 PASS" || echo "# test533 FAIL"
[[ $FAIL -eq 0 ]]

#!/bin/sh
# Issue #122 functional test on obfuscated dist.
#
# Verifies, in a clean container:
#   1. anet node start <alias> default → auto-wraps into tmux (TTY simulated)
#   2. --foreground explicit → no wrap, foreground
#   3. --no-tmux explicit → no wrap (alias of --foreground)
#   4. Already inside tmux ($TMUX set) → no wrap (recursion guard layer 1)
#   5. Non-TTY (stdin redirected) → no wrap
#   6. Same-name tmux session exists → error + 3 actionable hints, exit 1
#   7. tmux missing from PATH → foreground + warn
#   8. anet node stop also kills tmux session (symmetric cleanup)
#   9. --new-session flag propagates through tmux to inner anet node start
#  10. --attach issues tmux attach after spawn (we observe the spawn message)
#  11. project up (#117) does NOT recurse — inner cmd has --foreground
#  12. --help advertises --foreground / --no-tmux / --attach
set -eu
PASS=0; FAIL=0

# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../tests/lib/safe-rm.sh"
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

# ── Setup ────────────────────────────────────────────────────────────
echo "── Setup ──"
mkdir -p "$HOME/bin" "$HOME/.anet"

# Wrapper anet that routes to real obfuscated dist; node start runs the
# *real* startCommand, which then spawns claude/agent-node. We need those
# to keep the tmux session alive, so we shim both runtimes to sleep.
cat > "$HOME/bin/anet" <<'SH'
#!/bin/sh
exec node /anet/dist/bin/cli.js "$@"
SH
chmod +x "$HOME/bin/anet"

# Shim runtimes — when launchAgent eventually invokes them, just sleep
# forever so the tmux session stays alive for the has-session check.
for binname in claude agent-node; do
  cat > "$HOME/bin/$binname" <<SH
#!/bin/sh
case "\$1" in
  --help)    echo "$binname shim --session-id <uuid>"; exit 0;;
  --version) echo "shim-9.9.9"; exit 0;;
esac
echo "${binname}_SHIM_INVOKED \$*"
exec sleep 9999
SH
  chmod +x "$HOME/bin/$binname"
done

# Global config — bypass hub probes.
cat > "$HOME/.anet/config.json" <<'JSON'
{"hub":"http://127.0.0.1:9999","token":"utok_t","network_id":"net_t"}
JSON

# Mock hub on :9999 just for notifyServerOffline (stop path).
node - <<'JS' &
const http = require("http");
http.createServer((req, res) => { res.writeHead(200, {"content-type":"application/json"}); res.end("{}"); })
    .listen(9999, "127.0.0.1");
JS
HUB_PID=$!
trap 'kill $HUB_PID 2>/dev/null || true; tmux kill-server 2>/dev/null || true' EXIT
sleep 0.3

# tmux quietness
echo "set -g default-shell /bin/sh" > "$HOME/.tmux.conf"

export PATH="$HOME/bin:$PATH"

# Helper to create a fake node directory.
mknode() {
  local alias="$1"
  mkdir -p ".anet/nodes/$alias"
  cat > ".anet/nodes/$alias/config.json" <<JSON
{"anet_version":"0.1.0","node_id":"n_t_$alias","node_name":"$alias","alias":"$alias","runtime":"claude-code-cli","hub":"http://127.0.0.1:9999","token":"ntok_t_$alias","channels":["server:commhub"],"env":{},"flags":{"dangerouslySkipPermissions":true},"session":"00000000-0000-0000-0000-00000000000${alias}"}
JSON
}

# `script -qc CMD /dev/null` forces a pty so the cli sees isTTY=true on
# stdin/stdout — needed for the default-wrap path. Without it, the cli
# falls through to foreground (Test 5 case).
run_tty() {
  # Use `script` to allocate a pty. -q quiets the typescript banner.
  script -qc "$*" /dev/null </dev/null 2>&1
}

apt_have_script=1
command -v script >/dev/null 2>&1 || apt_have_script=0
if [ "$apt_have_script" = "0" ]; then
  apt-get update >/dev/null 2>&1 && apt-get install -y --no-install-recommends bsdutils >/dev/null 2>&1 || true
fi

echo
# ── Test 1: default → auto-wrap in tmux ─────────────────────────────
echo "── Test 1: default TTY → auto-wrap ──"
mknode a
OUT1=$(run_tty "anet node start a")
echo "$OUT1" | grep -q "Started \"a\" in tmux session \"a\" (detached)"  && ok "wrap announcement"  || bad "wrap announcement missing: $OUT1"
echo "$OUT1" | grep -q "Attach:" && echo "$OUT1" | grep -q "Stop:" && echo "$OUT1" | grep -q "Logs:" \
  && ok "3 follow-up hints printed" || bad "3 hints not all present"
sleep 0.5
tmux has-session -t a 2>/dev/null && ok "tmux session 'a' alive after wrap" || bad "tmux session 'a' missing"

# ── Test 2: --foreground → no wrap ─────────────────────────────────
echo "── Test 2: --foreground → no wrap ──"
mknode b
# Foreground would block on sleep. Use timeout to exit after spawn proves
# it ran foreground (not creating a tmux session named 'b').
OUT2=$(run_tty "timeout 2 anet node start b --foreground" || true)
sleep 0.3
if tmux has-session -t b 2>/dev/null; then bad "--foreground accidentally created tmux session"; else ok "--foreground did NOT create tmux session"; fi
echo "$OUT2" | grep -q "Started \"b\" in tmux" && bad "--foreground printed wrap msg" || ok "--foreground skipped wrap announcement"

# ── Test 3: --no-tmux → no wrap (alias) ────────────────────────────
echo "── Test 3: --no-tmux alias of --foreground ──"
mknode c
OUT3=$(run_tty "timeout 2 anet node start c --no-tmux" || true)
sleep 0.3
if tmux has-session -t c 2>/dev/null; then bad "--no-tmux created tmux session"; else ok "--no-tmux did NOT create tmux session"; fi

# ── Test 4: inside tmux ($TMUX set) → no wrap (recursion guard) ────
echo "── Test 4: \$TMUX env set → no wrap (recursion layer 1) ──"
mknode d
OUT4=$(TMUX=/tmp/fake-tmux-socket,1234,5 run_tty "timeout 2 anet node start d" || true)
sleep 0.3
if tmux has-session -t d 2>/dev/null; then bad "auto-wrap fired despite \$TMUX set"; else ok "auto-wrap correctly skipped when inside tmux"; fi

# ── Test 5: non-TTY → no wrap ──────────────────────────────────────
echo "── Test 5: non-TTY → no wrap ──"
mknode e
OUT5=$(timeout 2 anet node start e </dev/null 2>&1 || true)
sleep 0.3
if tmux has-session -t e 2>/dev/null; then bad "auto-wrap fired in non-TTY"; else ok "auto-wrap skipped in non-TTY"; fi

# ── Test 6: same-name tmux session exists → friendly error ─────────
echo "── Test 6: pre-existing same-name tmux session → friendly error ──"
mknode f
tmux new-session -d -s f "sleep 9999"
sleep 0.3
OUT6=$(run_tty "anet node start f" || true)
echo "$OUT6" | grep -q 'session "f" already exists' && ok "friendly already-exists error"  || bad "missing already-exists error: $OUT6"
echo "$OUT6" | grep -q "Attach:"  && ok "hint: Attach" || bad "missing Attach hint"
echo "$OUT6" | grep -q "Restart:" && ok "hint: Restart" || bad "missing Restart hint"
echo "$OUT6" | grep -q -- "--foreground" && ok "hint: --foreground escape" || bad "missing --foreground hint"
tmux kill-session -t f 2>/dev/null || true

# ── Test 7: tmux missing → foreground + warn ───────────────────────
echo "── Test 7: tmux missing → foreground + warn ──"
mknode g
# Hide tmux from PATH by exporting a PATH without ~/bin/tmux. tmux is in
# /usr/bin/tmux on debian-slim so we need to mask both. Easiest: tmpdir
# containing a fake `tmux` that says "command not found"-style exit.
TMPDIR=$(mktemp -d)
# Move real tmux out of the way for this case only. Symlink trick: create
# a shim that always fails to exec, putting TMPDIR first on PATH.
cat > "$TMPDIR/tmux" <<'SH'
#!/bin/sh
exit 127
SH
chmod +x "$TMPDIR/tmux"
OUT7=$(PATH="$TMPDIR:$HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" run_tty "timeout 2 anet node start g" || true)
# Reset cache state by spawning a new node process — already done via timeout.
echo "$OUT7" | grep -q "tmux not installed"        && ok "tmux-missing warn printed"      || bad "no warn on missing tmux: $OUT7"
echo "$OUT7" | grep -q "starting in foreground"    && ok "warn mentions foreground fallback" || bad "warn missing foreground note"
safe_rm_rf "$TMPDIR"

# ── Test 8: anet node stop also kills tmux ─────────────────────────
echo "── Test 8: anet node stop also kills tmux session ──"
sleep 0.2
tmux has-session -t a 2>/dev/null && ok "(precondition) tmux 'a' still alive from Test 1" || { echo "  ⚠ Test 1 tmux 'a' missing — recreating"; mknode a; tmux new-session -d -s a "sleep 9999"; }
OUT8=$(anet node stop a 2>&1)
sleep 0.3
tmux has-session -t a 2>/dev/null && bad "tmux 'a' still alive after stop" || ok "tmux 'a' killed by anet node stop"
echo "$OUT8" | grep -q "tmux" && ok "stop output mentions tmux" || bad "stop output should mention tmux: $OUT8"

# ── Test 9: --new-session flag propagates ──────────────────────────
echo "── Test 9: --new-session propagates through tmux wrap ──"
mknode h
run_tty "anet node start h --new-session" >/dev/null 2>&1 || true
sleep 0.4
# Inspect the running tmux command line for the inner --new-session flag.
# tmux exposes pane_start_command via list-panes -F.
PANE_CMD=$(tmux list-panes -t h -F '#{pane_start_command}' 2>/dev/null || true)
echo "$PANE_CMD" | grep -q -- "--new-session" && ok "--new-session reached inner cmd" || bad "inner cmd missing --new-session: $PANE_CMD"
echo "$PANE_CMD" | grep -q -- "--foreground"  && ok "inner cmd also has --foreground (recursion guard layer 2)" || bad "inner cmd missing --foreground: $PANE_CMD"
tmux kill-session -t h 2>/dev/null || true

# ── Test 10: project up does NOT recurse ───────────────────────────
echo "── Test 10: project up (#117) does not recurse ──"
mknode p1; mknode p2
anet project up --stagger 0 </dev/null >/tmp/proj.log 2>&1 || true
sleep 0.5
tmux has-session -t p1 2>/dev/null && tmux has-session -t p2 2>/dev/null \
  && ok "project up created both tmux sessions" || bad "project up didn't create both: $(cat /tmp/proj.log)"
# Inspect that the inner cmd has --foreground (Layer 2 defense)
PCMD=$(tmux list-panes -t p1 -F '#{pane_start_command}' 2>/dev/null || true)
echo "$PCMD" | grep -q -- "--foreground" && ok "project up inner cmd has --foreground" || bad "project up inner cmd missing --foreground: $PCMD"
# And: only ONE tmux session per node — no nested ones.
SESS_COUNT=$(tmux ls 2>/dev/null | awk -F: '$1 ~ /^p[12]$/{c++} END{print c+0}')
[ "$SESS_COUNT" = "2" ] && ok "exactly 2 tmux sessions (no recursion)" || bad "expected 2 sessions, got $SESS_COUNT: $(tmux ls)"
anet project down --stagger 0 </dev/null >/dev/null 2>&1 || true

# ── Test 11: --attach (best-effort, can't easily verify the attach itself) ──
echo "── Test 11: --attach issues tmux attach ──"
mknode q
# --attach exec()s into tmux attach which then blocks. Use timeout to break
# out and check that the spawn announcement appeared first.
OUT11=$(timeout 2 script -qc "anet node start q --attach" /dev/null </dev/null 2>&1 || true)
sleep 0.3
echo "$OUT11" | grep -q "Started \"q\" in tmux" && ok "--attach printed wrap announcement before attaching" || bad "--attach announcement missing: $OUT11"
tmux has-session -t q 2>/dev/null && ok "--attach created the tmux session" || bad "--attach session missing"
tmux kill-session -t q 2>/dev/null || true

# ── Test 12: --help advertises new flags ───────────────────────────
echo "── Test 12: --help advertises --foreground / --no-tmux / --attach ──"
H=$(anet --help 2>&1)
echo "$H" | grep -q -- "--foreground" && ok "help: --foreground" || bad "help: --foreground missing"
echo "$H" | grep -q -- "--attach"     && ok "help: --attach"     || bad "help: --attach missing"
echo "$H" | grep -q "detached tmux"   && ok "help mentions default detached tmux" || bad "help missing default-tmux note"

echo
echo "──────────────────────────────────────"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "──────────────────────────────────────"
[ "$FAIL" -eq 0 ]

#!/bin/sh
# Issue #117 functional test on obfuscated dist.
#
# Verifies, in a clean container:
#   1. help advertises Project (cwd-wide) block
#   2. `project` (no subcommand) prints usage
#   3. `project up` with no nodes → friendly message
#   4. `project up` starts 3 nodes (3 tmux sessions alive)
#   5. `project up` again → 3 skip (idempotent)
#   6. `project restart --stagger 0` → 3 restart fast
#   7. `project down` → all tmux killed
#   8. `--only a,b` filter
#   9. `--exclude c` filter
#  10. Invalid --stagger → error exit
set -eu
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

# ── Setup ────────────────────────────────────────────────────────────
echo "── Setup ──"
mkdir -p "$HOME/bin" "$HOME/.anet"

# `anet` shim: route `node start <alias>` to a long-running sleep so tmux
# sessions stay alive for has-session checks; route everything else to the
# real obfuscated dist.
cat > "$HOME/bin/anet" <<'SH'
#!/bin/sh
if [ "$1 $2" = "node start" ]; then
  echo "FAKE_ANET_NODE_START $3"
  exec sleep 9999
fi
exec node /anet/dist/bin/cli.js "$@"
SH
chmod +x "$HOME/bin/anet"
export PATH="$HOME/bin:$PATH"

# Global config — bypasses any hub-probe codepath if reached.
cat > "$HOME/.anet/config.json" <<'JSON'
{"hub":"http://127.0.0.1:9477","token":"utok_test","network_id":"net_test","network_name":"test"}
JSON

# Helper to create a fake node directory.
mknode() {
  local alias="$1"
  mkdir -p ".anet/nodes/$alias"
  cat > ".anet/nodes/$alias/config.json" <<JSON
{"anet_version":"0.1.0","node_id":"n_test_$alias","node_name":"$alias","alias":"$alias","runtime":"claude-code-cli","hub":"http://127.0.0.1:9477","token":"ntok_test_$alias","channels":["server:commhub"],"env":{},"flags":{"dangerouslySkipPermissions":true},"session":"00000000-0000-0000-0000-00000000000${alias}"}
JSON
}

# tmux requires a config dir; mute the noisy default.
echo "set -g default-shell /bin/sh" > "$HOME/.tmux.conf"

trap 'tmux kill-server 2>/dev/null || true' EXIT
echo
# ── Test 1: help block ───────────────────────────────────────────────
echo "── Test 1: --help advertises Project block ──"
H=$(anet --help 2>&1)
echo "$H" | grep -q "Project (cwd-wide)"     && ok "help: Project (cwd-wide) header"     || bad "help: Project header missing"
echo "$H" | grep -q "anet project up"        && ok "help: anet project up"               || bad "help: project up missing"
echo "$H" | grep -q "anet project restart"   && ok "help: anet project restart"          || bad "help: project restart missing"
echo "$H" | grep -q "anet project down"      && ok "help: anet project down"             || bad "help: project down missing"
echo "$H" | grep -q -- "--stagger"           && ok "help: --stagger documented"          || bad "help: --stagger missing"
echo "$H" | grep -q -- "--only"              && ok "help: --only / --exclude documented" || bad "help: --only missing"

# ── Test 2: `project` (no subcmd) prints usage ───────────────────────
echo "── Test 2: bare \`anet project\` prints usage ──"
U=$(anet project 2>&1 || true)
echo "$U" | grep -q "anet project <up|restart|down>" && ok "bare project prints usage" || bad "bare project should print usage: $U"

# ── Test 3: project up with no nodes ─────────────────────────────────
echo "── Test 3: project up with empty .anet/nodes/ ──"
rm -rf .anet
N=$(anet project up 2>&1 || true)
echo "$N" | grep -q "No nodes match" && ok "no-nodes friendly message" || bad "expected 'No nodes match', got: $N"

# ── Test 4: project up starts 3 nodes ────────────────────────────────
echo "── Test 4: project up starts 3 nodes ──"
mknode a; mknode b; mknode c
UP=$(anet project up --stagger 0 2>&1)
echo "$UP" | grep -q "▶  a" && echo "$UP" | grep -q "▶  b" && echo "$UP" | grep -q "▶  c" \
  && ok "all 3 nodes shown as started" || bad "missing one of ▶ a/b/c: $UP"
sleep 0.3
for n in a b c; do
  tmux has-session -t "$n" 2>/dev/null && ok "tmux session '$n' alive" || bad "tmux session '$n' not found"
done
echo "$UP" | grep -q "3/3 up" && ok "summary shows 3/3 up" || bad "summary wrong: $UP"

# ── Test 5: project up again → idempotent skip ───────────────────────
echo "── Test 5: project up again (idempotent) ──"
UP2=$(anet project up --stagger 0 2>&1)
SKIPS=$(echo "$UP2" | grep -c "already running" || true)
[ "$SKIPS" = "3" ] && ok "all 3 nodes skipped (already running)" || bad "expected 3 skips, got $SKIPS: $UP2"
# Ensure tmux sessions are still the same (no kill happened).
for n in a b c; do tmux has-session -t "$n" 2>/dev/null || bad "tmux '$n' died on idempotent up"; done
ok "tmux sessions preserved on idempotent up"

# ── Test 6: project restart kills + restarts ─────────────────────────
echo "── Test 6: project restart --stagger 0 ──"
# Capture tmux pane pids for diff after restart (tmux-native, no procps).
OLD_PIDS=$(for n in a b c; do tmux list-panes -t "$n" -F '#{pane_pid}' 2>/dev/null; done | sort | tr '\n' ' ')
RES=$(anet project restart --stagger 0 2>&1)
RESTARTS=$(echo "$RES" | grep -c "↻" || true)
[ "$RESTARTS" = "3" ] && ok "all 3 nodes show ↻ (kill+start)" || bad "expected 3 ↻, got $RESTARTS: $RES"
sleep 0.5
NEW_PIDS=$(for n in a b c; do tmux list-panes -t "$n" -F '#{pane_pid}' 2>/dev/null; done | sort | tr '\n' ' ')
[ "$OLD_PIDS" != "$NEW_PIDS" ] && ok "tmux pane pids changed → real restart happened" || bad "pane pids unchanged ($OLD_PIDS == $NEW_PIDS) — kill+start didn't fire"
for n in a b c; do tmux has-session -t "$n" 2>/dev/null || bad "tmux '$n' gone after restart"; done
ok "all 3 tmux sessions alive after restart"

# ── Test 7: project down ─────────────────────────────────────────────
echo "── Test 7: project down ──"
DOWN=$(anet project down 2>&1)
STOPS=$(echo "$DOWN" | grep -c "⏹" || true)
[ "$STOPS" = "3" ] && ok "all 3 nodes show ⏹" || bad "expected 3 ⏹, got $STOPS: $DOWN"
sleep 0.3
for n in a b c; do
  if tmux has-session -t "$n" 2>/dev/null; then bad "tmux '$n' still alive after down"; else ok "tmux '$n' gone"; fi
done

# ── Test 8: --only filter ────────────────────────────────────────────
echo "── Test 8: project up --only a,b ──"
FILT=$(anet project up --stagger 0 --only a,b 2>&1)
echo "$FILT" | grep -q "▶  a" && echo "$FILT" | grep -q "▶  b" \
  && ok "--only started a, b" || bad "--only missing a or b: $FILT"
echo "$FILT" | grep -q " c$" && bad "--only leaked c into output" || ok "--only excluded c from output"
sleep 0.3
tmux has-session -t a 2>/dev/null && tmux has-session -t b 2>/dev/null \
  && ok "tmux a, b alive" || bad "tmux a or b not started"
tmux has-session -t c 2>/dev/null && bad "tmux c started despite --only a,b" || ok "tmux c NOT started"
echo "$FILT" | grep -q "2/2 up" && ok "summary 2/2 (filter counted)" || bad "summary wrong for --only: $FILT"

# ── Test 9: --exclude filter ─────────────────────────────────────────
echo "── Test 9: project down + project up --exclude a ──"
anet project down --stagger 0 >/dev/null 2>&1
sleep 0.3
EXCL=$(anet project up --stagger 0 --exclude a 2>&1)
echo "$EXCL" | grep -q "▶  b" && echo "$EXCL" | grep -q "▶  c" \
  && ok "--exclude started b, c" || bad "--exclude missing b or c: $EXCL"
echo "$EXCL" | grep -E "[▶⏭].*\\ba\\b" >/dev/null && bad "--exclude leaked a into output" || ok "--exclude omitted a"
tmux has-session -t a 2>/dev/null && bad "tmux a started despite --exclude" || ok "tmux a NOT started"
tmux has-session -t b 2>/dev/null && tmux has-session -t c 2>/dev/null && ok "tmux b,c alive" || bad "b or c missing"

# ── Test 10: invalid --stagger ───────────────────────────────────────
echo "── Test 10: --stagger abc (invalid) ──"
if anet project up --stagger abc </dev/null >/tmp/bad.log 2>&1; then
  bad "invalid --stagger should have exited non-zero"
else
  grep -q "non-negative" /tmp/bad.log && ok "invalid --stagger rejected" || bad "rejected but wrong msg: $(cat /tmp/bad.log)"
fi

# Cleanup before exit so trap doesn't kill the test stats.
anet project down --stagger 0 >/dev/null 2>&1 || true

echo
echo "──────────────────────────────────────"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "──────────────────────────────────────"
[ "$FAIL" -eq 0 ]

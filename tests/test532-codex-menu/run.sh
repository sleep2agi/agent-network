#!/usr/bin/env bash
# test532-codex-menu — `anet node codex` with no arguments (#532).
#
# Real CLI (agent-network/bin/cli.ts), HOME=$(mktemp -d), fixture codex nodes (no real login:
# auth.json is a fixture string), tmux on a private socket (-L t532 / ANET_TMUX_SOCKET).
# The menu only opens on a TTY, so it is driven through `script` (a real pty) with scripted stdin.
#   U  the bun unit test (src/codex-menu.test.ts)
#   A  piped (no TTY): table + cheat sheet, exit 0
#   B  pty, restart, answer n → the exact command is printed, nothing runs (no receipt written)
#   C  pty, restart, answer y → the real `anet node codex restart my-node` runs (its receipt appears)
#   D  pty, delete my-sdk: a wrong name aborts (dir intact); the exact name deletes it
#   E  no node token and no auth.json content in any output
# M1–M4 are witnessed reds, one per rule; a mutation that does not apply fails (MUTATION_NOOP).
set -euo pipefail
# Exercise Codex behavior, not host resource admission (covered by test612).
# Shared CI runner load/memory must not delay the fixture's app-server startup.
export ANET_START_MEM_GATE=0
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test532-codex-menu.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test532-codex-menu — interactive codex menu + cheat sheet"
echo "source_commit=${TEST532_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"
echo "tmux=$(tmux -V) bun=$(bun --version)"

ROOT=/workspace
CLI="$ROOT/agent-network/bin/cli.ts"
SRC="$ROOT/agent-network/src/codex-menu.ts"
NODE_TOKEN="ntok_FIXTURE_SECRET_0123456789abcdef"
AUTH_SECRET="sk-FIXTURE-AUTH-SECRET-zzzz"
THREAD="0199aa11-2222-7333-8444-555566667777"
TMUX_L=t532
unset TMUX_TMPDIR TMUX TMUX_PANE
# tmux rewrites non-ASCII session names (my-node-桥) to "_" outside a UTF-8 locale.
export LANG=C.UTF-8 LC_ALL=C.UTF-8
export ANET_TMUX_SOCKET="/tmp/tmux-$(id -u)/$TMUX_L"
t() { tmux -L "$TMUX_L" "$@"; }

WORK=""
PROJ=""
PASS=0
FAIL=0
ok() { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

cleanup_tmux() {
  local s
  for s in my-node my-node-appsrv my-node-桥; do t kill-session -t "=$s" 2>/dev/null || true; done
}

setup() {
  cleanup_tmux
  if [ -n "$WORK" ]; then safe_rm_rf "$WORK"; fi
  WORK=$(mktemp -d /tmp/t532.XXXXXX)
  export HOME="$WORK/home"
  mkdir -p "$HOME"
  PROJ="$WORK/proj"
  mkdir -p "$PROJ/.anet/nodes/my-node/codex-home" "$PROJ/.anet/nodes/my-sdk" "$PROJ/.anet/nodes/my-claude"
  cat > "$PROJ/.anet/nodes/my-node/config.json" <<JSON
{"name":"my-node","node_id":"n_fixture1","runtime":"codex-app-server","codexCopresence":true,"codexProjectDir":"$PROJ","codexThreadId":"$THREAD","model":"o3","token":"$NODE_TOKEN","hub":"http://127.0.0.1:9"}
JSON
  cat > "$PROJ/.anet/nodes/my-sdk/config.json" <<JSON
{"name":"my-sdk","node_id":"n_fixture2","runtime":"codex-sdk","token":"$NODE_TOKEN","hub":"http://127.0.0.1:9"}
JSON
  cat > "$PROJ/.anet/nodes/my-claude/config.json" <<JSON
{"name":"my-claude","node_id":"n_fixture3","runtime":"claude-agent-sdk","token":"$NODE_TOKEN"}
JSON
  printf '{"tokens":{"access_token":"%s"}}\n' "$AUTH_SECRET" > "$PROJ/.anet/nodes/my-node/codex-home/auth.json"
  # my-node "running": its three co-presence sessions exist on the private server.
  local s
  for s in my-node-appsrv my-node-桥 my-node; do t new-session -d -s "$s" "sleep 600"; done
}

# menu_pty <stdin-text> <outfile> → sets MENU_RC
menu_pty() {
  printf '%b' "$1" > "$WORK/in"
  MENU_RC=0
  (cd "$PROJ" && timeout 180 script -qefc "bun $CLI node codex" /dev/null < "$WORK/in" > "$2" 2>&1) || MENU_RC=$?
}

no_secrets() { # <file>...
  if grep -Fq -e "$NODE_TOKEN" -e "$AUTH_SECRET" "$@"; then return 1; fi
  return 0
}

case_A() {
  setup
  local out="$WORK/a.out" rc=0
  (cd "$PROJ" && bun "$CLI" node codex < /dev/null > "$out" 2>&1) || rc=$?
  cp "$out" "$ARTIFACT_DIR/A-piped.txt"
  [ "$rc" = 0 ] || { echo "    rc=$rc"; return 1; }
  no_secrets "$out" || { echo "    secret in output"; return 1; }
  grep -Eq 'my-node +co-presence +running +logged in +0199aa11 +o3' "$out" || { echo "    table row my-node missing"; return 1; }
  grep -Eq 'my-sdk +codex-sdk +stopped +NOT logged in \(host\)' "$out" || { echo "    table row my-sdk missing"; return 1; }
  grep -Fq 'my-claude' "$out" && { echo "    non-codex node listed"; return 1; }
  grep -Fq 'I want to … 我想' "$out" || { echo "    cheat sheet missing"; return 1; }
  grep -Fq 'anet node codex restart my-node' "$out" || { echo "    cheat sheet restart line missing"; return 1; }
  return 0
}

case_B() {
  setup
  local out="$WORK/b.out"
  menu_pty '1\n3\nn\n' "$out"
  cp "$out" "$ARTIFACT_DIR/B-restart-n.txt"
  [ "$MENU_RC" = 0 ] || { echo "    rc=$MENU_RC"; return 1; }
  grep -Fq 'Will run 将执行:' "$out" && grep -Eq '^  anet node codex restart my-node' "$out" || { echo "    equivalent command not printed"; return 1; }
  grep -Fq 'nothing was run' "$out" || { echo "    no abort message"; return 1; }
  [ ! -d "$PROJ/.anet/nodes/my-node/receipts" ] || { echo "    restart ran (receipt written) after n"; return 1; }
  grep -Fq '[anet] codex restart:' "$out" && { echo "    restart output present after n"; return 1; }
  no_secrets "$out" || { echo "    secret in output"; return 1; }
  return 0
}

case_C() {
  setup
  local out="$WORK/c.out"
  menu_pty '1\n3\ny\n' "$out"
  cp "$out" "$ARTIFACT_DIR/C-restart-y.txt"
  grep -Eq '^  anet node codex restart my-node' "$out" || { echo "    equivalent command not printed"; return 1; }
  # The real lifecycle command ran: it writes a receipt under the node dir whatever its verdict.
  ls "$PROJ/.anet/nodes/my-node/receipts/"* >/dev/null 2>&1 || { echo "    no receipt — restart did not run"; return 1; }
  # printed before it ran: the command line comes before the restart's own output
  local cmd_line run_line
  cmd_line=$(grep -n -m1 '^  anet node codex restart my-node' "$out" | cut -d: -f1)
  run_line=$(grep -n -m1 -e 'receipt:' -e '\[anet\] codex restart' "$out" | cut -d: -f1)
  [ -n "$run_line" ] && [ "$cmd_line" -lt "$run_line" ] || { echo "    command not printed before the run (cmd=$cmd_line run=${run_line:-none})"; return 1; }
  no_secrets "$out" || { echo "    secret in output"; return 1; }
  return 0
}

case_D() {
  setup
  local out="$WORK/d1.out"
  menu_pty '2\n10\nmy-sd\n' "$out"
  cp "$out" "$ARTIFACT_DIR/D1-delete-wrong-name.txt"
  grep -Eq '^  anet node delete my-sdk --force' "$out" || { echo "    delete command not printed"; return 1; }
  [ -f "$PROJ/.anet/nodes/my-sdk/config.json" ] || { echo "    wrong name deleted the node"; return 1; }
  grep -Fq 'Name did not match' "$out" || { echo "    no mismatch message"; return 1; }
  out="$WORK/d2.out"
  menu_pty '2\n10\ny\n' "$out"
  [ -f "$PROJ/.anet/nodes/my-sdk/config.json" ] || { echo "    y alone deleted the node"; return 1; }
  out="$WORK/d3.out"
  menu_pty '2\n10\nmy-sdk\n' "$out"
  cp "$out" "$ARTIFACT_DIR/D3-delete-typed.txt"
  [ ! -e "$PROJ/.anet/nodes/my-sdk" ] || { echo "    typed name did not delete"; cat "$out"; return 1; }
  [ -f "$PROJ/.anet/nodes/my-node/config.json" ] || { echo "    deleted the wrong node"; return 1; }
  no_secrets "$WORK"/d*.out || { echo "    secret in output"; return 1; }
  return 0
}

case_E() {
  # every pty path through every action of both nodes, answering n / a wrong name
  setup
  local n a out
  for n in 1 2; do for a in 1 2 3 4 5 6 7 8 9 10; do
    out="$WORK/e-$n-$a.out"
    menu_pty "$n\n$a\nx-model\nx-name\n\nn\n" "$out"
  done; done
  no_secrets "$WORK"/e-*.out || { echo "    secret in output"; grep -lF -e "$NODE_TOKEN" -e "$AUTH_SECRET" "$WORK"/e-*.out; return 1; }
  # and nothing ran: both node dirs are still there, no receipt
  [ -f "$PROJ/.anet/nodes/my-sdk/config.json" ] && [ -f "$PROJ/.anet/nodes/my-node/config.json" ] || { echo "    a node was deleted"; return 1; }
  [ ! -d "$PROJ/.anet/nodes/my-node/receipts" ] || { echo "    something ran"; return 1; }
  return 0
}

run_case() { # <name> <fn>
  if "$2"; then ok "$1"; else bad "$1"; fi
}

echo "[U] unit test"
U_RC=0
(cd "$ROOT/agent-network" && bun test src/codex-menu.test.ts) > "$ARTIFACT_DIR/U-unit.txt" 2>&1 || U_RC=$?
cat "$ARTIFACT_DIR/U-unit.txt"
if [ "$U_RC" = 0 ] && grep -Eq '^ *[1-9][0-9]* pass$' "$ARTIFACT_DIR/U-unit.txt" && grep -Eq '^ *0 fail$' "$ARTIFACT_DIR/U-unit.txt"; then ok "U unit"; else bad "U unit (rc=$U_RC)"; fi

echo "[green]"
run_case "A piped: table + cheat sheet, rc 0" case_A
run_case "B restart + n: printed, nothing ran" case_B
run_case "C restart + y: printed, then ran" case_C
run_case "D delete needs the typed name" case_D
run_case "E no secrets on any path" case_E

# A human-paced run of case B for the report (answers typed one at a time, so the pty echo
# lands after each prompt). Not asserted — the assertions above are on the scripted runs.
setup
(cd "$PROJ" && { sleep 3; printf '1\n'; sleep 1; printf '3\n'; sleep 1; printf 'n\n'; sleep 2; } \
  | timeout 60 script -qefc "bun $CLI node codex" /dev/null > "$ARTIFACT_DIR/screenshot.txt" 2>&1) || true
echo "--- text screenshot (restart, answered n) ---"
tr -d '\r' < "$ARTIFACT_DIR/screenshot.txt"
echo "--- end ---"

# ── witnessed reds ──
BAK=/tmp/t532-codex-menu.src.bak
MUTLOG=/tmp/t532-mut.log
cp "$SRC" "$BAK"
mutate() { # <name> <old-literal> <new-literal> <case-fn>
  local name=$1 old=$2 new=$3 fn=$4
  cp "$BAK" "$SRC"
  OLD="$old" NEW="$new" bun -e '
    const fs = require("fs"); const p = process.argv[1]; const s = fs.readFileSync(p, "utf8");
    if (!s.includes(process.env.OLD)) { console.error("MUTATION_NOOP"); process.exit(3); }
    fs.writeFileSync(p, s.replace(process.env.OLD, process.env.NEW));' "$SRC" || { bad "$name MUTATION_NOOP"; return; }
  if cmp -s "$SRC" "$BAK"; then bad "$name MUTATION_NOOP"; return; fi
  if "$fn" > "$MUTLOG" 2>&1; then bad "$name: mutation stayed green"; cat "$MUTLOG"; else ok "$name: red as expected ($(grep -m1 -E '^    ' "$MUTLOG" || true))"; fi
}
echo "[mutations]"
mutate "M1 y/N gate removed" 'if (!/^(y|yes)$/i.test((yn ?? "").trim()))' 'if (false)' case_B
mutate "M2 typed-name gate removed" 'if ((typed ?? "").trim() !== row.alias)' 'if (false)' case_D
mutate "M3 non-TTY branch removed" 'if (!(process.stdin.isTTY && process.stdout.isTTY))' 'if (false)' case_A
mutate "M4 token leaks into the table" '      alias: n.alias,' '      alias: n.alias + " " + String(p.token ?? ""),' case_A
cp "$BAK" "$SRC"

cleanup_tmux
safe_rm_rf "$WORK" "$BAK" "$MUTLOG"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ] && [ "$PASS" = 10 ] || { echo "RESULT: FAIL"; exit 1; }
echo "RESULT: PASS"

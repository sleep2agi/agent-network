#!/usr/bin/env bash
# test561-node-menu — bare `anet node`: a menu for every runtime (#561).
#
# Real CLI (agent-network/bin/cli.ts), HOME=$(mktemp -d), fixture nodes of four runtimes (no real
# login, no hub: the hub URL is a closed port), tmux on a private socket (-L t561 / ANET_TMUX_SOCKET).
# The menu only opens on a TTY, so it is driven through `script` (a real pty) with scripted stdin.
#   U  the bun unit tests (src/node-menu.test.ts + src/codex-menu.test.ts, the module it reuses)
#   A  piped (no TTY): every runtime in the table + cheat sheet + the old usage line, exit 0
#   H  `anet node --help` / `anet node help` / `anet node codex` (piped) unchanged: no node table
#   B  pty, my-sdk → show log, answer n → the exact command is printed, nothing runs
#   C  pty, my-sdk → show log, answer y → `anet logs my-sdk` runs (the log line appears after it)
#   D  pty, delete my-sdk: y alone and a wrong name abort (dir intact); the exact name deletes it
#   E  pty, my-codex → handed to the #532 codex actions; restart + y runs `anet node codex restart`
#   F  no node token and no auth.json content on any path
# M1–M6 are witnessed reds, one per rule; a mutation that does not apply fails (MUTATION_NOOP).
set -euo pipefail
# Exercise Codex behavior, not host resource admission (covered by test612).
# Shared CI runner load/memory must not delay the fixture's app-server startup.
export ANET_START_MEM_GATE=0
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test561-node-menu.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test561-node-menu — interactive menu for every node runtime"
echo "source_commit=${TEST561_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"
echo "tmux=$(tmux -V) bun=$(bun --version)"

ROOT=/workspace
CLI="$ROOT/agent-network/bin/cli.ts"
MENU_SRC="$ROOT/agent-network/src/node-menu.ts"
CODEX_SRC="$ROOT/agent-network/src/codex-menu.ts"
NODE_TOKEN="ntok_FIXTURE_SECRET_0123456789abcdef"
AUTH_SECRET="sk-FIXTURE-AUTH-SECRET-zzzz"
LOG_MARK="LOGLINE-561-fixture-marker"
TMUX_L=t561
unset TMUX_TMPDIR TMUX TMUX_PANE
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
  for s in my-cli my-codex my-codex-appsrv my-codex-桥; do t kill-session -t "=$s" 2>/dev/null || true; done
}

setup() {
  cleanup_tmux
  if [ -n "$WORK" ]; then safe_rm_rf "$WORK"; fi
  WORK=$(mktemp -d /tmp/t561.XXXXXX)
  export HOME="$WORK/home"
  mkdir -p "$HOME"
  PROJ="$WORK/proj"
  local n
  for n in my-sdk my-cli my-grok my-codex; do mkdir -p "$PROJ/.anet/nodes/$n"; done
  cat > "$PROJ/.anet/nodes/my-sdk/config.json" <<JSON
{"name":"my-sdk","node_id":"n_f1","runtime":"claude-agent-sdk","model":"claude-sonnet-4-5","token":"$NODE_TOKEN","hub":"http://127.0.0.1:9"}
JSON
  cat > "$PROJ/.anet/nodes/my-cli/config.json" <<JSON
{"name":"my-cli","node_id":"n_f2","runtime":"claude-code-cli","token":"$NODE_TOKEN","hub":"http://127.0.0.1:9"}
JSON
  cat > "$PROJ/.anet/nodes/my-grok/config.json" <<JSON
{"name":"my-grok","node_id":"n_f3","runtime":"grok-build-cli","grokCopresence":true,"model":"grok-4","token":"$NODE_TOKEN","hub":"http://127.0.0.1:9"}
JSON
  mkdir -p "$PROJ/.anet/nodes/my-codex/codex-home"
  cat > "$PROJ/.anet/nodes/my-codex/config.json" <<JSON
{"name":"my-codex","node_id":"n_f4","runtime":"codex-app-server","codexCopresence":true,"codexProjectDir":"$PROJ","codexThreadId":"0199aa11-2222-7333-8444-555566667777","model":"o3","token":"$NODE_TOKEN","hub":"http://127.0.0.1:9"}
JSON
  printf '{"tokens":{"access_token":"%s"}}\n' "$AUTH_SECRET" > "$PROJ/.anet/nodes/my-codex/codex-home/auth.json"
  mkdir -p "$PROJ/.anet/nodes/my-sdk/logs"
  printf 'boot\n%s\n' "$LOG_MARK" > "$PROJ/.anet/nodes/my-sdk/logs/2026-10-05.log"
  # my-cli "running": its tmux session exists on the private server.
  t new-session -d -s my-cli "sleep 600"
}

# Rows are sorted by alias: 1 my-cli, 2 my-codex, 3 my-grok, 4 my-sdk.
# menu_pty <stdin-text> <outfile> [args…] → sets MENU_RC
menu_pty() {
  printf '%b' "$1" > "$WORK/in"
  MENU_RC=0
  (cd "$PROJ" && timeout 180 script -qefc "bun $CLI node" /dev/null < "$WORK/in" > "$2" 2>&1) || MENU_RC=$?
}

no_secrets() { # <file>...
  if grep -Fq -e "$NODE_TOKEN" -e "$AUTH_SECRET" "$@"; then return 1; fi
  return 0
}

case_A() {
  setup
  local out="$WORK/a.out" rc=0
  (cd "$PROJ" && bun "$CLI" node < /dev/null > "$out" 2>&1) || rc=$?
  cp "$out" "$ARTIFACT_DIR/A-piped.txt"
  [ "$rc" = 0 ] || { echo "    rc=$rc"; return 1; }
  no_secrets "$out" || { echo "    secret in output"; return 1; }
  grep -Eq '^  1 +my-cli +claude-code-cli +running +\(default\) +-$' "$out" || { echo "    row my-cli missing"; return 1; }
  grep -Eq '^  2 +my-codex +codex-app-server +stopped +o3 +logged in$' "$out" || { echo "    row my-codex missing"; return 1; }
  grep -Eq '^  3 +my-grok +grok-build-cli \(tui\) +stopped +grok-4 +-$' "$out" || { echo "    row my-grok missing"; return 1; }
  grep -Eq '^  4 +my-sdk +claude-agent-sdk +stopped +claude-sonnet-4-5 +-$' "$out" || { echo "    row my-sdk missing"; return 1; }
  grep -Fq 'I want to … 我想' "$out" || { echo "    cheat sheet missing"; return 1; }
  grep -Fq 'codex-cheatsheet' "$out" || { echo "    codex cheat sheet link missing"; return 1; }
  grep -Fq 'Usage: anet node <create|' "$out" || { echo "    old usage line missing"; return 1; }
  return 0
}

case_H() {
  setup
  local out rc
  out="$WORK/h1.out"; rc=0
  (cd "$PROJ" && bun "$CLI" node --help < /dev/null > "$out" 2>&1) || rc=$?
  cp "$out" "$ARTIFACT_DIR/H1-node-help.txt"
  [ "$rc" = 0 ] && grep -Fq 'Usage: anet node <command> [name] [options]' "$out" || { echo "    --help changed (rc=$rc)"; return 1; }
  grep -Fq 'Nodes in' "$out" && { echo "    --help shows the node table"; return 1; }
  out="$WORK/h2.out"; rc=0
  (cd "$PROJ" && timeout 60 script -qefc "bun $CLI node help" /dev/null < /dev/null > "$out" 2>&1) || rc=$?
  cp "$out" "$ARTIFACT_DIR/H2-node-help-word.txt"
  grep -Fq 'Usage: anet node <create|' "$out" || { echo "    'node help' lost its usage line"; return 1; }
  grep -Fq 'Nodes in' "$out" && { echo "    'node help' opened the menu"; return 1; }
  out="$WORK/h3.out"; rc=0
  (cd "$PROJ" && bun "$CLI" node codex < /dev/null > "$out" 2>&1) || rc=$?
  cp "$out" "$ARTIFACT_DIR/H3-node-codex.txt"
  [ "$rc" = 0 ] && grep -Fq 'Codex nodes in' "$out" && grep -Eq 'my-codex +co-presence' "$out" || { echo "    'node codex' changed (rc=$rc)"; return 1; }
  grep -Fq 'my-sdk' "$out" && { echo "    'node codex' lists a non-codex node"; return 1; }
  no_secrets "$WORK"/h*.out || { echo "    secret in output"; return 1; }
  return 0
}

case_B() {
  setup
  local out="$WORK/b.out"
  menu_pty '4\n5\nn\n' "$out"
  cp "$out" "$ARTIFACT_DIR/B-log-n.txt"
  [ "$MENU_RC" = 0 ] || { echo "    rc=$MENU_RC"; return 1; }
  grep -Fq 'Nodes in' "$out" || { echo "    menu did not open"; return 1; }
  grep -Fq 'Will run 将执行:' "$out" && grep -Eq '^  anet logs my-sdk' "$out" || { echo "    equivalent command not printed"; return 1; }
  grep -Fq 'nothing was run' "$out" || { echo "    no abort message"; return 1; }
  grep -Fq "$LOG_MARK" "$out" && { echo "    log printed after n"; return 1; }
  no_secrets "$out" || { echo "    secret in output"; return 1; }
  return 0
}

case_C() {
  setup
  local out="$WORK/c.out"
  menu_pty '4\n5\ny\n' "$out"
  cp "$out" "$ARTIFACT_DIR/C-log-y.txt"
  local cmd_line run_line
  cmd_line=$(grep -n -m1 '^  anet logs my-sdk' "$out" | cut -d: -f1 || true)
  run_line=$(grep -n -m1 -F "$LOG_MARK" "$out" | cut -d: -f1 || true)
  [ -n "$cmd_line" ] || { echo "    equivalent command not printed"; return 1; }
  [ -n "$run_line" ] || { echo "    anet logs did not run"; return 1; }
  [ "$cmd_line" -lt "$run_line" ] || { echo "    command not printed before the run"; return 1; }
  no_secrets "$out" || { echo "    secret in output"; return 1; }
  return 0
}

case_D() {
  setup
  local out="$WORK/d1.out"
  menu_pty '4\n7\nmy-sd\n' "$out"
  cp "$out" "$ARTIFACT_DIR/D1-delete-wrong-name.txt"
  grep -Eq '^  anet node delete my-sdk --force' "$out" || { echo "    delete command not printed"; return 1; }
  [ -f "$PROJ/.anet/nodes/my-sdk/config.json" ] || { echo "    wrong name deleted the node"; return 1; }
  grep -Fq 'Name did not match' "$out" || { echo "    no mismatch message"; return 1; }
  out="$WORK/d2.out"
  menu_pty '4\n7\ny\n' "$out"
  [ -f "$PROJ/.anet/nodes/my-sdk/config.json" ] || { echo "    y alone deleted the node"; return 1; }
  out="$WORK/d3.out"
  menu_pty '4\n7\nmy-sdk\n' "$out"
  cp "$out" "$ARTIFACT_DIR/D3-delete-typed.txt"
  [ ! -e "$PROJ/.anet/nodes/my-sdk" ] || { echo "    typed name did not delete"; cat "$out"; return 1; }
  [ -f "$PROJ/.anet/nodes/my-cli/config.json" ] || { echo "    deleted the wrong node"; return 1; }
  no_secrets "$WORK"/d*.out || { echo "    secret in output"; return 1; }
  return 0
}

case_E() {
  setup
  local out="$WORK/e1.out"
  menu_pty '2\n3\nn\n' "$out"
  cp "$out" "$ARTIFACT_DIR/E1-codex-restart-n.txt"
  grep -Fq 'log in 登录 codex' "$out" || { echo "    codex actions not offered"; return 1; }
  grep -Eq '^  anet node codex restart my-codex' "$out" || { echo "    codex command not printed"; return 1; }
  [ ! -d "$PROJ/.anet/nodes/my-codex/receipts" ] || { echo "    restart ran after n"; return 1; }
  out="$WORK/e2.out"
  menu_pty '2\n3\ny\n' "$out"
  cp "$out" "$ARTIFACT_DIR/E2-codex-restart-y.txt"
  ls "$PROJ/.anet/nodes/my-codex/receipts/"* >/dev/null 2>&1 || { echo "    no receipt — codex restart did not run"; return 1; }
  no_secrets "$WORK"/e*.out || { echo "    secret in output"; return 1; }
  return 0
}

case_F() {
  # every pty path through every action of every node, answering n / a wrong name
  setup
  local n a out
  for n in 1 2 3 4; do for a in 1 2 3 4 5 6 7 8 9 10; do
    out="$WORK/f-$n-$a.out"
    menu_pty "$n\n$a\nx-model\nx-name\n\nn\n" "$out"
  done; done
  no_secrets "$WORK"/f-*.out || { echo "    secret in output"; grep -lF -e "$NODE_TOKEN" -e "$AUTH_SECRET" "$WORK"/f-*.out; return 1; }
  local d
  for d in my-sdk my-cli my-grok my-codex; do [ -f "$PROJ/.anet/nodes/$d/config.json" ] || { echo "    $d was deleted"; return 1; }; done
  [ ! -d "$PROJ/.anet/nodes/my-codex/receipts" ] || { echo "    something ran"; return 1; }
  return 0
}

run_case() { # <name> <fn>
  if "$2"; then ok "$1"; else bad "$1"; fi
}

echo "[U] unit tests"
U_RC=0
(cd "$ROOT/agent-network" && bun test src/node-menu.test.ts src/codex-menu.test.ts) > "$ARTIFACT_DIR/U-unit.txt" 2>&1 || U_RC=$?
cat "$ARTIFACT_DIR/U-unit.txt"
if [ "$U_RC" = 0 ] && grep -Eq '^ *[1-9][0-9]* pass$' "$ARTIFACT_DIR/U-unit.txt" && grep -Eq '^ *0 fail$' "$ARTIFACT_DIR/U-unit.txt"; then ok "U unit"; else bad "U unit (rc=$U_RC)"; fi

echo "[green]"
run_case "A piped: every runtime + cheat sheet + usage, rc 0" case_A
run_case "H --help / help / node codex unchanged" case_H
run_case "B log + n: printed, nothing ran" case_B
run_case "C log + y: printed, then ran" case_C
run_case "D delete needs the typed name" case_D
run_case "E codex node → #532 codex actions" case_E
run_case "F no secrets on any path" case_F

# A human-paced run for the report (answers typed one at a time). Not asserted.
setup
(cd "$PROJ" && { sleep 3; printf '4\n'; sleep 1; printf '5\n'; sleep 1; printf 'n\n'; sleep 2; } \
  | timeout 60 script -qefc "bun $CLI node" /dev/null > "$ARTIFACT_DIR/screenshot.txt" 2>&1) || true
echo "--- text screenshot (my-sdk → show log, answered n) ---"
tr -d '\r' < "$ARTIFACT_DIR/screenshot.txt"
echo "--- end ---"

# ── witnessed reds ──
CLI_BAK=/tmp/t561-cli.bak
MENU_BAK=/tmp/t561-node-menu.bak
CODEX_BAK=/tmp/t561-codex-menu.bak
MUTLOG=/tmp/t561-mut.log
cp "$CLI" "$CLI_BAK"; cp "$MENU_SRC" "$MENU_BAK"; cp "$CODEX_SRC" "$CODEX_BAK"
restore_all() { cp "$CLI_BAK" "$CLI"; cp "$MENU_BAK" "$MENU_SRC"; cp "$CODEX_BAK" "$CODEX_SRC"; }
mutate() { # <name> <file> <old-literal> <new-literal> <case-fn>
  local name=$1 file=$2 old=$3 new=$4 fn=$5
  restore_all
  OLD="$old" NEW="$new" bun -e '
    const fs = require("fs"); const p = process.argv[1]; const s = fs.readFileSync(p, "utf8");
    if (!s.includes(process.env.OLD)) { console.error("MUTATION_NOOP"); process.exit(3); }
    fs.writeFileSync(p, s.replace(process.env.OLD, process.env.NEW));' "$file" || { bad "$name MUTATION_NOOP"; return; }
  if cmp -s "$CLI" "$CLI_BAK" && cmp -s "$MENU_SRC" "$MENU_BAK" && cmp -s "$CODEX_SRC" "$CODEX_BAK"; then bad "$name MUTATION_NOOP"; return; fi
  if "$fn" > "$MUTLOG" 2>&1; then bad "$name: mutation stayed green"; cat "$MUTLOG"; else ok "$name: red as expected ($(grep -m1 -E '^    ' "$MUTLOG" || true))"; fi
}
echo "[mutations]"
mutate "M1 bare-node hook removed from cli.ts" "$CLI" 'if (!sub) process.exit(await runNodeMenu(' 'if (false) process.exit(await runNodeMenu(' case_B
mutate "M2 non-TTY branch removed" "$MENU_SRC" 'if (!(process.stdin.isTTY && process.stdout.isTTY))' 'if (false)' case_A
mutate "M3 shared y/N gate removed" "$CODEX_SRC" 'if (!/^(y|yes)$/i.test((yn ?? "").trim()))' 'if (false)' case_B
mutate "M4 delete asks y/N instead of the name" "$MENU_SRC" 'planNodeAction(row, action, input), row, action === "delete")' 'planNodeAction(row, action, input), row, false)' case_D
mutate "M5 codex hand-off removed" "$MENU_SRC" 'if (row.codex) return codexNodeActions(' 'if (false) return codexNodeActions(' case_E
mutate "M6 token leaks into the table" "$MENU_SRC" '      id: n.id, alias: n.alias, runtime,
      state:' '      id: n.id, alias: n.alias + " " + String(p.token ?? ""), runtime,
      state:' case_A
restore_all

cleanup_tmux
safe_rm_rf "$WORK" "$CLI_BAK" "$MENU_BAK" "$CODEX_BAK" "$MUTLOG"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ] && [ "$PASS" = 14 ] || { echo "RESULT: FAIL"; exit 1; }
echo "RESULT: PASS"

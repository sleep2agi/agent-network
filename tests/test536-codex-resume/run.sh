#!/usr/bin/env bash
# test536-codex-resume — `anet resume <codex node> [--thread <id> | --pick]` (#536).
#
# Real CLI (agent-network/bin/cli.ts), fixture nodes written as config.json, fixture CODEX_HOMEs with
# 3 synthetic rollouts (A and B share a 35-char prefix; C stands alone) and a placeholder auth.json.
# No codex binary, no login, no network, no Hub (hub = 127.0.0.1:9, refused). tmux on a private -L socket.
# HOME=$(mktemp -d): the "host" ~/.codex is a fixture too.
#   L  --pick, no TTY           → rc 2, newest-first list (time, short id, first line), recorded marked,
#                                  copy-paste `--thread <full id>`; config untouched
#   T  --pick in a pty, answer 2 → the codex-sdk node's session becomes B (config written before start)
#   P  --thread <unique prefix>  → codex-sdk session becomes C
#   G  recorded thread has no rollout → rc 2 "refusing to start a fresh thread"; config untouched
#   F  --thread not in this CODEX_HOME → rc 2; config untouched
#   N  no codex login (host ~/.codex) → rc 1 with `codex login --device-auth`
#   R  running co-presence node: switch thread → rc 2 "stop it first"; same thread → rc 0 "already running"
#   S  co-presence via old `anet node resume --session` → routed to `anet node codex resume` (never writes
#      `session`); when it stops before touching anything the recorded codexThreadId is restored
#   E  no recorded thread → rc 2 "no recorded codex thread"
#   X  no auth.json content in any output
# M1–M4 are witnessed reds, one per rule; a mutation that does not apply fails (MUTATION_NOOP).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test536-codex-resume.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test536-codex-resume — resume + thread picker for codex nodes"
echo "source_commit=${TEST536_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"
echo "tmux=$(tmux -V) bun=$(bun --version)"

ROOT=/workspace
CLI="$ROOT/agent-network/bin/cli.ts"
SRC="$ROOT/agent-network/src/codex-resume.ts"
CLI_SRC="$CLI"
NODE_TOKEN="ntok_FIXTURE_SECRET_0123456789abcdef"
AUTH_SECRET="sk-FIXTURE-AUTH-SECRET-t536"
A=01a02193-e1fd-70f3-9e16-6fbff295fbae
B=01a02193-e1fd-70f3-9e16-6fbff295fbaf
C=01b0cccc-0000-7000-8000-000000000003
GONE=01ffffff-0000-7000-8000-00000000dead
TMUX_L=t536
unset TMUX_TMPDIR TMUX TMUX_PANE CODEX_HOME
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
  for s in cp-node cp-node-appsrv cp-node-桥 sdk-node; do t kill-session -t "=$s" 2>/dev/null || true; done
}

# Fixture CODEX_HOME — compact JSON like codex writes.
make_home() { # <dir> <with-login 0|1>
  local h=$1
  mkdir -p "$h/sessions/2026/10/01" "$h/sessions/2026/10/02" "$h/sessions/2026/10/03"
  meta() { printf '{"timestamp":"%s","type":"session_meta","payload":{"id":"%s","session_id":"%s","timestamp":"%s","cwd":"/proj"}}\n' "$2" "$1" "$1" "$2"; }
  { meta "$A" 2026-10-01T01:00:00.000Z
    printf '{"type":"event_msg","payload":{"type":"user_message","message":"conversation A: fix the flaky test"}}\n'
  } > "$h/sessions/2026/10/01/rollout-2026-10-01T01-00-00-$A.jsonl"
  { meta "$B" 2026-10-02T02:00:00.000Z
    printf '{"type":"event_msg","payload":{"type":"user_message","message":"conversation B"}}\n'
  } > "$h/sessions/2026/10/02/rollout-2026-10-02T02-00-00-$B.jsonl"
  { meta "$C" 2026-10-03T03:00:00.000Z
    printf '{"type":"event_msg","payload":{"type":"user_message","message":"conversation C: write docs"}}\n'
  } > "$h/sessions/2026/10/03/rollout-2026-10-03T03-00-00-$C.jsonl"
  if [ "$2" = 1 ]; then printf '{"tokens":{"access_token":"%s","refresh_token":"%s-r"}}\n' "$AUTH_SECRET" "$AUTH_SECRET" > "$h/auth.json"; chmod 600 "$h/auth.json"; fi
}

setup() {
  cleanup_tmux
  if [ -n "$WORK" ]; then safe_rm_rf "$WORK"; fi
  WORK=$(mktemp -d /tmp/t536.XXXXXX)
  export HOME="$WORK/home"
  PROJ="$WORK/proj"
  mkdir -p "$HOME" "$PROJ/.anet/nodes/cp-node" "$PROJ/.anet/nodes/sdk-node" "$PROJ/.anet/nodes/sdk-host" "$PROJ/.anet/nodes/sdk-new"
  make_home "$PROJ/.anet/nodes/cp-node/codex-home" 1
  make_home "$PROJ/.anet/nodes/sdk-node/codex-home" 1
  make_home "$HOME/.codex" 0
  cat > "$PROJ/.anet/nodes/cp-node/config.json" <<JSON
{"name":"cp-node","node_id":"n_fixture1","runtime":"codex-app-server","codexCopresence":true,"codexProjectDir":"$PROJ","codexThreadId":"$A","codexAppServerUrl":"ws://127.0.0.1:1","token":"$NODE_TOKEN","hub":"http://127.0.0.1:9"}
JSON
  cat > "$PROJ/.anet/nodes/sdk-node/config.json" <<JSON
{"name":"sdk-node","node_id":"n_fixture2","runtime":"codex-sdk","session":"$A","token":"$NODE_TOKEN","hub":"http://127.0.0.1:9"}
JSON
  cat > "$PROJ/.anet/nodes/sdk-host/config.json" <<JSON
{"name":"sdk-host","node_id":"n_fixture3","runtime":"codex-sdk","session":"$GONE","token":"$NODE_TOKEN","hub":"http://127.0.0.1:9"}
JSON
  cat > "$PROJ/.anet/nodes/sdk-new/config.json" <<JSON
{"name":"sdk-new","node_id":"n_fixture4","runtime":"codex-sdk","token":"$NODE_TOKEN","hub":"http://127.0.0.1:9"}
JSON
  cp "$PROJ/.anet/nodes/cp-node/config.json" "$WORK/cp-before.json"
  cp "$PROJ/.anet/nodes/sdk-host/config.json" "$WORK/host-before.json"
}

cfg() { bun -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=c[process.argv[2]];console.log(v===undefined?"<unset>":v)' "$PROJ/.anet/nodes/$1/config.json" "$2"; }

# an <outfile> <args...> → sets RC (stdin is /dev/null: not a TTY)
an() { local out=$1; shift; RC=0; (cd "$PROJ" && timeout 120 bun "$CLI" "$@" </dev/null >"$out" 2>&1) || RC=$?; }
# an_pty <stdin-text> <outfile> <command-line> → sets RC
an_pty() { printf '%b' "$1" > "$WORK/in"; RC=0; (cd "$PROJ" && timeout 120 script -qefc "bun $CLI $3" /dev/null < "$WORK/in" > "$2" 2>&1) || RC=$?; }

no_secrets() { if grep -Fq -e "$AUTH_SECRET" -e "$NODE_TOKEN" "$@"; then return 1; fi; return 0; }

case_L() {
  setup
  local out="$WORK/l.out"
  an "$out" resume cp-node --pick
  cp "$out" "$ARTIFACT_DIR/L-pick-piped.txt"; sed 's/^/      /' "$out"
  [ "$RC" = 2 ] || { echo "    rc=$RC (want 2)"; return 1; }
  grep -Eq '^ +1\. 2026-10-03 03:00:00Z  01b0cccc  "conversation C: write docs"$' "$out" || { echo "    row 1 is not C (newest first, short id, first line)"; return 1; }
  grep -E '^ +3\. ' "$out" | grep -Fq 'recorded' || { echo "    recorded thread A not marked"; return 1; }
  grep -Fq "anet resume cp-node --thread $C" "$out" || { echo "    no copy-paste --thread command"; return 1; }
  cmp -s "$WORK/cp-before.json" "$PROJ/.anet/nodes/cp-node/config.json" || { echo "    config changed"; return 1; }
  no_secrets "$out" || { echo "    secret in output"; return 1; }
}

case_T() {
  setup
  local out="$WORK/t.out"
  an_pty '2\n' "$out" "resume sdk-node --pick"
  cp "$out" "$ARTIFACT_DIR/T-pick-tty.txt"; tr -d '\r' < "$out" | sed 's/^/      /'
  grep -Fq "Resume which one?" "$out" || { echo "    no prompt"; return 1; }
  grep -Fq "[anet] resume sdk-node: thread $B" "$out" || { echo "    did not resume B"; return 1; }
  [ "$(cfg sdk-node session)" = "$B" ] || { echo "    session is $(cfg sdk-node session), want B"; return 1; }
  no_secrets "$out" || { echo "    secret in output"; return 1; }
}

case_P() {
  setup
  local out="$WORK/p.out"
  an "$out" resume sdk-node --thread 01b0
  cp "$out" "$ARTIFACT_DIR/P-prefix.txt"; sed 's/^/      /' "$out" | head -20
  grep -Fq "[anet] resume sdk-node: thread $C" "$out" || { echo "    did not resolve the prefix to C"; return 1; }
  [ "$(cfg sdk-node session)" = "$C" ] || { echo "    session is $(cfg sdk-node session), want C"; return 1; }
}

case_G() {
  setup
  local out="$WORK/g.out"
  an "$out" resume sdk-host
  cp "$out" "$ARTIFACT_DIR/G-gone.txt"; sed 's/^/      /' "$out"
  [ "$RC" = 2 ] || { echo "    rc=$RC (want 2)"; return 1; }
  grep -Fq "recorded thread $GONE has no rollout" "$out" || { echo "    no 'has no rollout' line"; return 1; }
  grep -Fq "refusing to start a fresh thread" "$out" || { echo "    no refusal"; return 1; }
  cmp -s "$WORK/host-before.json" "$PROJ/.anet/nodes/sdk-host/config.json" || { echo "    config changed"; return 1; }
}

case_F() {
  setup
  local out="$WORK/f.out"
  an "$out" resume cp-node --thread "$GONE"
  sed 's/^/      /' "$out"
  [ "$RC" = 2 ] || { echo "    rc=$RC (want 2)"; return 1; }
  grep -Fq "is not in cp-node's CODEX_HOME" "$out" || { echo "    no 'not in CODEX_HOME' line"; return 1; }
  cmp -s "$WORK/cp-before.json" "$PROJ/.anet/nodes/cp-node/config.json" || { echo "    config changed"; return 1; }
}

case_N() {
  setup
  local out="$WORK/n.out"
  an "$out" resume sdk-host --thread "$C"
  cp "$out" "$ARTIFACT_DIR/N-no-login.txt"; sed 's/^/      /' "$out"
  [ "$RC" = 1 ] || { echo "    rc=$RC (want 1)"; return 1; }
  grep -Fq "has no codex login in $HOME/.codex" "$out" || { echo "    no login refusal"; return 1; }
  grep -Fq "Log in first: codex login --device-auth" "$out" || { echo "    no login command"; return 1; }
  cmp -s "$WORK/host-before.json" "$PROJ/.anet/nodes/sdk-host/config.json" || { echo "    config changed"; return 1; }
}

case_R() {
  setup
  local s out="$WORK/r1.out"
  for s in cp-node-appsrv cp-node-桥 cp-node; do t new-session -d -s "$s" "sleep 600"; done
  an "$out" resume cp-node --thread "$C"
  sed 's/^/      /' "$out"
  [ "$RC" = 2 ] || { echo "    switch: rc=$RC (want 2)"; return 1; }
  grep -Fq "cp-node is running — stop it first" "$out" && grep -Fq "anet node stop cp-node" "$out" || { echo "    no stop-first line"; return 1; }
  out="$WORK/r2.out"
  an "$out" resume cp-node
  sed 's/^/      /' "$out"
  [ "$RC" = 0 ] || { echo "    same thread: rc=$RC (want 0)"; return 1; }
  grep -Fq "already running thread $A" "$out" || { echo    "no already-running line"; return 1; }
  cmp -s "$WORK/cp-before.json" "$PROJ/.anet/nodes/cp-node/config.json" || { echo "    config changed"; return 1; }
  cleanup_tmux
}

case_S() {
  setup
  local out="$WORK/s.out"
  an "$out" node resume cp-node --session "$C"
  cp "$out" "$ARTIFACT_DIR/S-copresence-route.txt"; sed 's/^/      /' "$out"
  grep -Fq "[anet] resume cp-node: thread $C" "$out" || { echo "    not routed through the codex resume path"; return 1; }
  grep -Fq "[anet] codex resume:" "$out" || { echo "    anet node codex resume did not run"; return 1; }
  [ "$(cfg cp-node session)" = "<unset>" ] || { echo "    wrote 'session' on a co-presence node"; return 1; }
  if grep -Fq "stopped at: preflight_before" "$out"; then
    grep -Fq "config codexThreadId restored to $A" "$out" || { echo "    preflight failed but no restore line"; return 1; }
    [ "$(cfg cp-node codexThreadId)" = "$A" ] || { echo "    codexThreadId is $(cfg cp-node codexThreadId), want A restored"; return 1; }
  else
    echo "    (lifecycle got past preflight: $(grep -m1 'stopped at:' "$out" || echo none))"
  fi
  [ "$RC" != 0 ] || { echo "    rc 0 without a running node?"; return 1; }
}

case_E() {
  setup
  local out="$WORK/e.out"
  an "$out" resume sdk-new
  sed 's/^/      /' "$out"
  [ "$RC" = 2 ] || { echo "    rc=$RC (want 2)"; return 1; }
  grep -Fq "sdk-new has no recorded codex thread" "$out" && grep -Fq "anet resume sdk-new --pick" "$out" || { echo "    no refusal with --pick hint"; return 1; }
  [ "$(cfg sdk-new session)" = "<unset>" ] || { echo "    session written"; return 1; }
}

case_X() { no_secrets "$ARTIFACT_DIR"/*.txt || { echo "    secret in an artifact"; return 1; }; }

run_case() { if "$2"; then ok "$1"; else bad "$1"; fi; }

echo "[U] unit test"
U_RC=0
(cd "$ROOT/agent-network" && bun test src/codex-resume.test.ts src/codex-menu.test.ts) > "$ARTIFACT_DIR/U-unit.txt" 2>&1 || U_RC=$?
cat "$ARTIFACT_DIR/U-unit.txt"
if [ "$U_RC" = 0 ] && grep -Eq '^ *[1-9][0-9]* pass$' "$ARTIFACT_DIR/U-unit.txt" && grep -Eq '^ *0 fail$' "$ARTIFACT_DIR/U-unit.txt"; then ok "U unit"; else bad "U unit (rc=$U_RC)"; fi

echo "[green]"
run_case "L --pick without a TTY lists + copy-paste, rc 2" case_L
run_case "T --pick in a pty, answer 2 → B" case_T
run_case "P --thread unique prefix → C" case_P
run_case "G recorded thread gone → refuse, no fresh start" case_G
run_case "F foreign --thread → refuse" case_F
run_case "N no codex login → rc 1 + login command" case_N
run_case "R running: switch refused, same thread = attach" case_R
run_case "S co-presence routed to node codex resume, config restored" case_S
run_case "E no recorded thread → refuse with --pick" case_E
run_case "X no secrets in any artifact" case_X

# ── witnessed reds ──
BAK=/tmp/t536-src.bak
CLI_BAK=/tmp/t536-cli.bak
MUTLOG=/tmp/t536-mut.log
cp "$SRC" "$BAK"; cp "$CLI_SRC" "$CLI_BAK"
mutate() { # <name> <file> <old-literal> <new-literal> <case-fn>
  local name=$1 file=$2 old=$3 new=$4 fn=$5 bak
  bak=$BAK; [ "$file" = "$CLI_SRC" ] && bak=$CLI_BAK
  cp "$bak" "$file"
  OLD="$old" NEW="$new" bun -e '
    const fs = require("fs"); const p = process.argv[1]; const s = fs.readFileSync(p, "utf8");
    if (!s.includes(process.env.OLD)) { console.error("MUTATION_NOOP"); process.exit(3); }
    fs.writeFileSync(p, s.replace(process.env.OLD, process.env.NEW));' "$file" || { bad "$name MUTATION_NOOP"; return; }
  if cmp -s "$file" "$bak"; then bad "$name MUTATION_NOOP"; cp "$bak" "$file"; return; fi
  if "$fn" > "$MUTLOG" 2>&1; then bad "$name: mutation stayed green"; cat "$MUTLOG"; else ok "$name: red as expected ($(grep -m1 -E '^    [a-z(]' "$MUTLOG" || true))"; fi
  cp "$bak" "$file"
}
echo "[mutations]"
mutate "M1 codex nodes fall back to the old resume path" "$CLI_SRC" 'if (resolved && ["codex-sdk", "codex-app-server"].includes(' 'if (false && ["codex-sdk", "codex-app-server"].includes(' case_G
mutate "M2 non-TTY --pick asks anyway" "$SRC" '    if (!req.tty) {' '    if (false) {' case_L
mutate "M3 login check removed" "$SRC" '  if (!f.loggedIn) {' '  if (false) {' case_N
mutate "M4 running check removed" "$SRC" '  if (f.running || f.state.startsWith("partial")) {' '  if (false) {' case_R
cp "$BAK" "$SRC"; cp "$CLI_BAK" "$CLI_SRC"

cleanup_tmux
safe_rm_rf "$WORK" "$BAK" "$CLI_BAK" "$MUTLOG"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ] && [ "$PASS" = 15 ] || { echo "RESULT: FAIL"; exit 1; }
echo "RESULT: PASS"

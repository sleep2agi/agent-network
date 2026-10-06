#!/usr/bin/env bash
set -euo pipefail

# test-codex-external-appserver — board #630 step 1.
#
# `anet node start|stop|restart <alias>` for a codex-app-server node whose
# config.json fixes codexAppServerUrl, run as three tmux sessions:
#   <alias>-appsrv  (codex app-server)  → /readyz 200 →
#   <alias>-tui     (codex resume <codexThreadId> --remote <url>)  →
#   <alias>         (agent-node bridge, the version paired with this anet)
#
# Everything runs against a fake `codex` (serves /readyz, records argv + env
# NAMES) and a fake paired agent-node package, on a PRIVATE tmux socket
# (ANET_TMUX_SOCKET) inside this container. No hub, no network.
#
# The two security/ordering properties are each proven live by an in-suite
# mutation (L9): the suite must go red when the readyz wait or the in-session
# token read is removed. Sources are restored from a copied backup and cmp'd.

ROOT=/workspace
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-$ARTIFACT_DIR/report-test-codex-external-appserver.txt}"
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; PASSES=$((PASSES + 1)); }
PASSES=0

log "# test-codex-external-appserver — #630 three-session codex nodes"
log "date: $(date -Is)"
log "source_commit: ${TEST_EXTAPP_SOURCE_COMMIT:-unset}"
if [ -n "${EXPECTED_SOURCE_COMMIT:-}" ] && [ "${TEST_EXTAPP_SOURCE_COMMIT:-}" != "$EXPECTED_SOURCE_COMMIT" ]; then
  fail "source provenance mismatch image=${TEST_EXTAPP_SOURCE_COMMIT:-unset} expected=$EXPECTED_SOURCE_COMMIT"
fi

log "[L0] isolated environment"
[ ! -e "$ROOT/.git" ] || fail "image contains host .git"
[ ! -e "$ROOT/.anet" ] || fail "image contains host .anet"
command -v tmux >/dev/null 2>&1 || fail "tmux missing"
command -v codex >/dev/null 2>&1 || fail "fake codex missing"
export ANET_TMUX_SOCKET=/tmp/test-extapp.tmux.sock
unset TMUX TMUX_PANE
T() { tmux -u -S "$ANET_TMUX_SOCKET" "$@"; }  # -u: CJK session names survive a C locale
# keep the private server alive between nodes
T new-session -d -s keepalive "sleep 100000"
pass "private tmux socket $ANET_TMUX_SOCKET, fake codex on PATH"

# Fake paired agent-node: exact package identity (validated by anet), records
# argv/env names, prints what the bridge-mode control file says.
PAIRED_VERSION="$(node -p "require('$ROOT/agent-node/package.json').version")"
[ -n "$PAIRED_VERSION" ] || fail "cannot read paired version"
PAIR_BASE="/run/user/$(id -u)/test-extapp-paired-agent-node"
PAIR_ROOT="$PAIR_BASE/node_modules/@sleep2agi/agent-node"
mkdir -p "$PAIR_ROOT/dist"
chmod 700 "/run/user/$(id -u)" "$PAIR_BASE"
cat >"$PAIR_ROOT/package.json" <<JSON
{"name":"@sleep2agi/agent-node","version":"$PAIRED_VERSION","publishConfig":{"tag":"preview"},"bin":{"agent-node":"dist/cli.js"}}
JSON
cat >"$PAIR_ROOT/dist/cli.js" <<'JS'
#!/usr/bin/env node
"use strict";
if (process.argv.includes("--help")) { console.log("--runtime codex-app-server"); process.exit(0); }
const fs = require("fs");
const argv = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(argv[argv.indexOf("--config") + 1], "utf8"));
fs.mkdirSync("/tmp/fake-codex", { recursive: true });
fs.writeFileSync(`/tmp/fake-codex/bridge-${process.pid}.json`, JSON.stringify({
  mode: "bridge", pid: process.pid, argv, cwd: process.cwd(), t: Date.now(), envNames: Object.keys(process.env).sort(),
}));
let mode = "resume";
try { mode = fs.readFileSync("/tmp/fake-codex/bridge-mode", "utf8").trim() || "resume"; } catch {}
console.log("[agent-node] 已注册到 CommHub");
const tid = String(cfg.codexThreadId || "");
if (mode === "resume") console.log(`[codex-app-server] resumed thread ${tid.slice(0, 12)}… in 7ms`);
if (mode === "other") console.log("[codex-app-server] resumed thread 99999999-aaa… in 7ms");
if (mode === "create") console.log("[codex-app-server] created thread 0123456789ab…");
setInterval(() => {}, 1 << 30);
JS
chmod 644 "$PAIR_ROOT/package.json"
chmod 755 "$PAIR_ROOT" "$PAIR_ROOT/dist" "$PAIR_ROOT/dist/cli.js"
export ANET_AGENT_NODE_BIN="$PAIR_ROOT/dist/cli.js"

log "[L1] decision functions (unit)"
cd "$ROOT/agent-network"
UNIT_OUT=$(bun test src/codex-external-appserver.test.ts 2>&1) || { printf '%s\n' "$UNIT_OUT" >>"$REPORT"; fail "unit tests"; }
printf '%s\n' "$UNIT_OUT" >>"$REPORT"
UNIT_PASS=$(printf '%s\n' "$UNIT_OUT" | grep -oE '^ *[0-9]+ pass' | grep -oE '[0-9]+' || true)
[ "${UNIT_PASS:-0}" -ge 14 ] || fail "expected >=14 unit tests, ran ${UNIT_PASS:-0} — did the file resolve?"
pass "unit: $UNIT_PASS tests"

# ── workspace with hand-written node configs (the shape an external launcher keeps) ──
WORK=/tmp/extapp-ws
mkdir -p "$WORK/.anet/nodes"
cd "$WORK"
TOKEN_PLANT="tok-planted-630-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf 'DEMO_DOTENV_SECRET=dotenv-value-should-not-be-logged\n' >"$WORK/.env"
THREAD="0199aaaa-bbbb-cccc-dddd-eeeeffff0001"
mknode() { # mknode <alias> <port> <projectDir> [extra json]
  local a="$1" port="$2" proj="$3" extra="${4:-}"
  mkdir -p "$WORK/.anet/nodes/$a/codex-home" "$WORK/.anet/nodes/$a/logs"
  cat >"$WORK/.anet/nodes/$a/config.json" <<JSON
{"node_name":"$a","alias":"$a","runtime":"codex-app-server","hub":"http://127.0.0.1:9","token":"$TOKEN_PLANT",
 "codexAppServerUrl":"ws://127.0.0.1:$port","codexThreadId":"$THREAD","codexProjectDir":"$proj",
 "codexCopresence":true,"model":"gpt-demo","channels":[],"env":{},"flags":{}$extra}
JSON
  chmod 600 "$WORK/.anet/nodes/$a/config.json"
}
MEM_OK=/tmp/meminfo-ok; printf 'MemTotal: 65000000 kB\nMemAvailable: 8388608 kB\n' >"$MEM_OK"
MEM_LOW=/tmp/meminfo-low; printf 'MemTotal: 65000000 kB\nMemAvailable: 2097152 kB\n' >"$MEM_LOW"
export ANET_MEMINFO_PATH="$MEM_OK"
CLI() { bun "$ROOT/agent-network/bin/cli.ts" "$@"; }
FAKE=/tmp/fake-codex
reset_fake() { rm -rf "$FAKE"; mkdir -p "$FAKE"; }
sessions() { T list-sessions -F '#{session_name}' 2>/dev/null || true; }
has_session() { sessions | grep -qxF -e "$1"; }
pane_pid() { T list-panes -a -F '#{session_name}|#{pane_pid}' | awk -F'|' -v n="$1" '$1==n{print $2}'; }
rec() { # rec <mode> → newest record file of that mode
  local files; files=$(ls -t "$FAKE"/"$1"-*.json 2>/dev/null || true); printf '%s' "${files%%$'\n'*}"; }
jf() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))" "$1" "$2"; }
token_in_cmdlines() { # count processes whose argv carries the planted token
  local n=0 f
  for f in /proc/[0-9]*/cmdline; do
    if tr '\0' ' ' <"$f" 2>/dev/null | grep -qF -e "$TOKEN_PLANT"; then n=$((n + 1)); fi
  done
  printf '%s' "$n"
}
token_in_start_commands() {
  local out; out=$(T list-panes -a -F '#{pane_start_command}' 2>/dev/null || true)
  if printf '%s' "$out" | grep -qF -e "$TOKEN_PLANT"; then echo 1; else echo 0; fi
}

log "[L2] start a CJK-named node (empty codexProjectDir) next to prefix-colliding decoys"
A="示例节点"
mknode "$A" 47101 ""
T new-session -d -s "示例节点2" "sleep 100000"
T new-session -d -s "示例节点2-appsrv" "sleep 100000"
T new-session -d -s "示例节点-appsrv-old" "sleep 100000"
reset_fake
echo 1500 >"$FAKE/ready-delay-ms"
set +e
CLI node start "$A" --external-appserver --verify-timeout 20 >"$WORK/start1.out" 2>&1
RC=$?
set -e
cat "$WORK/start1.out" >>"$REPORT"
log "start rc=$RC"
[ "$RC" = 0 ] || fail "start rc=$RC (want 0)"
grep -qF 'verify: bridge resumed thread' "$WORK/start1.out" || fail "no resumed-thread verification line"
grep -qF 'codexProjectDir is empty' "$WORK/start1.out" || fail "empty projectDir fallback not announced"
for s in "$A-appsrv" "$A-tui" "$A" 示例节点2 示例节点2-appsrv 示例节点-appsrv-old; do has_session "$s" || fail "session $s missing"; done
[ "$(jf "$WORK/.anet/nodes/$A/config.json" "d.get('codexLaunchLayout')")" = "external-appserver" ] || fail "layout not recorded"
pass "three sessions named $A-appsrv / $A-tui / $A; decoys untouched; layout recorded"

APP=$(rec appserver); TUI=$(rec tui); BR=$(rec bridge)
[ -n "$APP" ] && [ -n "$TUI" ] && [ -n "$BR" ] || fail "missing fake records (app=$APP tui=$TUI bridge=$BR)"
APP_PID=$(jf "$APP" "d['pid']")
READY_AT=$(cat "$FAKE/ready-$APP_PID")
T_APP=$(jf "$APP" "d['t']"); T_TUI=$(jf "$TUI" "d['t']"); T_BR=$(jf "$BR" "d['t']")
# The fake records are written by each process once it has booted (node vs bun boot
# at different speeds), so TUI-vs-bridge order is read from the pane shells' kernel
# start times instead (/proc/<pid>/stat field 22, in clock ticks).
starttime() { awk '{sub(/^.*\) /, ""); print $20}' "/proc/$1/stat"; }
ST_APP=$(starttime "$(pane_pid "$A-appsrv")"); ST_TUI=$(starttime "$(pane_pid "$A-tui")"); ST_BR=$(starttime "$(pane_pid "$A")")
log "t(appserver)=$T_APP t(readyz 200)=$READY_AT t(tui record)=$T_TUI t(bridge record)=$T_BR; pane start ticks appsrv=$ST_APP tui=$ST_TUI bridge=$ST_BR"
[ "$T_APP" -lt "$READY_AT" ] && [ "$READY_AT" -le "$T_TUI" ] && [ "$READY_AT" -le "$T_BR" ] \
  || fail "order wrong: TUI and bridge must start after /readyz answered 200"
[ "$ST_APP" -le "$ST_TUI" ] && [ "$ST_TUI" -le "$ST_BR" ] || fail "pane start order wrong: appsrv=$ST_APP tui=$ST_TUI bridge=$ST_BR"
[ $((READY_AT - T_APP)) -ge 1400 ] || fail "readyz answered 200 before the configured 1.5s delay?"
pass "order: app-server → /readyz 200 (after the 1.5s delay) → TUI → bridge"

[ "$(jf "$APP" "' '.join(d['argv'])")" = "-C $WORK app-server --listen ws://127.0.0.1:47101" ] \
  || fail "app-server argv: $(jf "$APP" "d['argv']")"
[ "$(jf "$TUI" "' '.join(d['argv'])")" = "-C $WORK resume $THREAD --remote ws://127.0.0.1:47101 -m gpt-demo --no-alt-screen" ] \
  || fail "TUI argv: $(jf "$TUI" "d['argv']")"
pass "argv: empty codexProjectDir → -C <workspace> (never -C ''); TUI resumes $THREAD on the configured URL"

for n in CODEX_HOME ANET_CODEX_COMMHUB_TOKEN DEMO_DOTENV_SECRET; do
  [ "$(jf "$APP" "'$n' in d['envNames']")" = True ] || fail "app-server env lacks $n"
done
[ "$(jf "$APP" "d['tokenMatchesConfig']")" = True ] || fail "app-server token env does not equal config token"
[ "$(jf "$APP" "d['codexHome']")" = "$WORK/.anet/nodes/$A/codex-home" ] || fail "CODEX_HOME=$(jf "$APP" "d['codexHome']")"
[ "$(jf "$TUI" "d['codexHome']")" = "$WORK/.anet/nodes/$A/codex-home" ] || fail "TUI CODEX_HOME wrong"
[ "$(jf "$BR" "'DEMO_DOTENV_SECRET' in d['envNames']")" = True ] || fail "bridge did not get the workspace .env"
BR_ARGV=$(jf "$BR" "' '.join(d['argv'])")
case "$BR_ARGV" in
  "--config $WORK/.anet/nodes/$A/config.json --alias $A --runtime codex-app-server --model gpt-demo --log-dir $WORK/.anet/nodes/$A/logs") ;;
  *) fail "bridge argv: $BR_ARGV" ;;
esac
pass "env names present (CODEX_HOME, ANET_CODEX_COMMHUB_TOKEN, .env's DEMO_DOTENV_SECRET); token value arrived; bridge argv exact"

N_CMD=$(token_in_cmdlines); N_START=$(token_in_start_commands)
log "planted token in /proc/*/cmdline: $N_CMD; in tmux pane_start_command: $N_START"
[ "$N_CMD" = 0 ] && [ "$N_START" = 0 ] || fail "token visible in argv (cmdline=$N_CMD start_command=$N_START)"
if grep -rqF -e "$TOKEN_PLANT" "$WORK/start1.out" "$FAKE"; then fail "token value written to output or fake records"; fi
# positive control: the scan does see a token when one IS in argv
bash -c 'sleep 30; :' "$TOKEN_PLANT" & CTRL=$!  # '; :' stops bash exec-ing sleep (which would drop $0)
sleep 0.2; N_CTRL=$(token_in_cmdlines); kill "$CTRL" 2>/dev/null || true; wait "$CTRL" 2>/dev/null || true
[ "$N_CTRL" -ge 1 ] || fail "positive control: the /proc scan did not see a planted argv"
pass "token never in any argv / pane start command (scan proven live by a positive control)"

log "[L3] refusals"
set +e
CLI node start "$A" >"$WORK/again.out" 2>&1; RC=$?
set -e
cat "$WORK/again.out" >>"$REPORT"
[ "$RC" != 0 ] && grep -qF 'already exist' "$WORK/again.out" || fail "second start not refused (rc=$RC)"

mknode demo-node-tuiclash 47102 "$WORK"
T new-session -d -s "demo-node-tuiclash-tui" "sleep 100000"
set +e; CLI node start demo-node-tuiclash --external-appserver >"$WORK/clash.out" 2>&1; RC=$?; set -e
cat "$WORK/clash.out" >>"$REPORT"
[ "$RC" != 0 ] && grep -qF 'demo-node-tuiclash-tui' "$WORK/clash.out" || fail "existing exact <alias>-tui not refused (rc=$RC)"
has_session demo-node-tuiclash-appsrv && fail "refused start still created an app-server session"
T kill-session -t "demo-node-tuiclash-tui"

mknode demo-node-busy 47103 "$WORK"
python3 -c "import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',47103));s.listen();time.sleep(600)" & BUSY=$!
sleep 0.5
set +e; CLI node start demo-node-busy --external-appserver >"$WORK/busy.out" 2>&1; RC=$?; set -e
kill "$BUSY" 2>/dev/null || true; wait "$BUSY" 2>/dev/null || true
cat "$WORK/busy.out" >>"$REPORT"
[ "$RC" != 0 ] && grep -qF 'already in use' "$WORK/busy.out" || fail "busy port not refused (rc=$RC)"
has_session demo-node-busy-appsrv && fail "busy-port refusal still created a session"

mknode demo-node-mem 47104 "$WORK"
set +e; ANET_MEMINFO_PATH="$MEM_LOW" CLI node start demo-node-mem --external-appserver >"$WORK/mem.out" 2>&1; RC=$?; set -e
cat "$WORK/mem.out" >>"$REPORT"
[ "$RC" != 0 ] && grep -qF 'below 4.0 GiB' "$WORK/mem.out" && grep -qF -- '--force' "$WORK/mem.out" || fail "low memory not refused (rc=$RC)"
has_session demo-node-mem-appsrv && fail "memory refusal still created a session"
set +e; ANET_MEMINFO_PATH="$MEM_LOW" CLI node start demo-node-mem --force --verify-timeout 10 >"$WORK/memforce.out" 2>&1; RC=$?; set -e
cat "$WORK/memforce.out" >>"$REPORT"
[ "$RC" = 0 ] && grep -qF 'continuing because of --force' "$WORK/memforce.out" || fail "--force did not override the memory check (rc=$RC)"
CLI node stop demo-node-mem >>"$REPORT" 2>&1
pass "refused: existing session (exact CJK name), existing <alias>-tui, busy port, MemAvailable < 4 GiB; --force overrides memory"

log "[L4] restart --bridge-only keeps app-server and TUI"
APPSRV_PANE=$(pane_pid "$A-appsrv"); TUI_PANE=$(pane_pid "$A-tui"); BR_PANE=$(pane_pid "$A")
set +e; CLI node restart "$A" --bridge-only --verify-timeout 20 >"$WORK/bonly.out" 2>&1; RC=$?; set -e
cat "$WORK/bonly.out" >>"$REPORT"
[ "$RC" = 0 ] || fail "bridge-only restart rc=$RC"
[ "$(pane_pid "$A-appsrv")" = "$APPSRV_PANE" ] || fail "app-server pane pid changed ($APPSRV_PANE → $(pane_pid "$A-appsrv"))"
[ "$(pane_pid "$A-tui")" = "$TUI_PANE" ] || fail "TUI pane pid changed"
NEW_BR=$(pane_pid "$A")
[ -n "$NEW_BR" ] && [ "$NEW_BR" != "$BR_PANE" ] || fail "bridge was not restarted ($BR_PANE → $NEW_BR)"
kill -0 "$APP_PID" || fail "fake app-server process $APP_PID died during bridge-only restart"
pass "bridge-only: app-server pid $APPSRV_PANE and TUI pid $TUI_PANE unchanged, bridge $BR_PANE → $NEW_BR"

log "[L5] verification catches a silent new session or a different thread"
echo create >"$FAKE/bridge-mode"
set +e; CLI node restart "$A" --bridge-only --verify-timeout 20 >"$WORK/v-create.out" 2>&1; RC=$?; set -e
cat "$WORK/v-create.out" >>"$REPORT"
[ "$RC" = 3 ] && grep -qF 'CREATED a new thread' "$WORK/v-create.out" || fail "new thread not caught (rc=$RC)"
echo other >"$FAKE/bridge-mode"
set +e; CLI node restart "$A" --bridge-only --verify-timeout 20 >"$WORK/v-other.out" 2>&1; RC=$?; set -e
cat "$WORK/v-other.out" >>"$REPORT"
[ "$RC" = 3 ] && grep -qF 'but config codexThreadId is' "$WORK/v-other.out" || fail "different thread not caught (rc=$RC)"
echo silent >"$FAKE/bridge-mode"
set +e; CLI node restart "$A" --bridge-only --verify-timeout 3 >"$WORK/v-silent.out" 2>&1; RC=$?; set -e
cat "$WORK/v-silent.out" >>"$REPORT"
[ "$RC" = 4 ] && grep -qF 'Registration alone does not prove' "$WORK/v-silent.out" || fail "registration-only not flagged (rc=$RC)"
echo resume >"$FAKE/bridge-mode"
pass "verify: created thread → rc 3, other thread → rc 3, registration only → rc 4"

log "[L6] stop: exactly three sessions by id, bridge first"
set +e; CLI node stop "$A" >"$WORK/stop.out" 2>&1; RC=$?; set -e
cat "$WORK/stop.out" >>"$REPORT"
[ "$RC" = 0 ] || fail "stop rc=$RC"
ORDER=$(grep -oE 'stopped tmux [^ ]+' "$WORK/stop.out" | awk '{print $3}' | tr '\n' ' ')
[ "$ORDER" = "$A $A-tui $A-appsrv " ] || fail "stop order: '$ORDER'"
for s in "$A" "$A-tui" "$A-appsrv"; do has_session "$s" && fail "$s still running"; done
for s in 示例节点2 示例节点2-appsrv 示例节点-appsrv-old; do has_session "$s" || fail "decoy $s was killed"; done
pass "stop order $ORDER; prefix-colliding decoys survive"

log "[L7] full restart (stop + start) and a plain start on the recorded layout"
CLI node start "$A" --verify-timeout 20 >"$WORK/start2.out" 2>&1 || fail "plain start on recorded layout"
cat "$WORK/start2.out" >>"$REPORT"
OLD_APP=$(pane_pid "$A-appsrv")
set +e; CLI node restart "$A" --verify-timeout 20 >"$WORK/restart.out" 2>&1; RC=$?; set -e
cat "$WORK/restart.out" >>"$REPORT"
[ "$RC" = 0 ] || fail "full restart rc=$RC"
[ "$(pane_pid "$A-appsrv")" != "$OLD_APP" ] || fail "full restart kept the old app-server"
CLI node stop "$A" >>"$REPORT" 2>&1
pass "plain start + full restart (new app-server pid)"

log "[L8] not opted in → not this lane; /readyz never 200 → nothing else starts"
mknode demo-node-native 47105 "$WORK"
set +e; timeout 60 bun "$ROOT/agent-network/bin/cli.ts" node start demo-node-native >"$WORK/native.out" 2>&1; set -e
cat "$WORK/native.out" >>"$REPORT"
if grep -qF -e '/readyz' -e 'codexLaunchLayout' "$WORK/native.out"; then fail "a node without the recorded layout took the #630 lane"; fi
[ "$(jf "$WORK/.anet/nodes/demo-node-native/config.json" "d.get('codexLaunchLayout')")" = None ] || fail "layout recorded on a node that never opted in"
for s in $(sessions | grep -F demo-node-native || true); do T kill-session -t "$s" || true; done

never_ready_run() { # never_ready_run <alias> <port> → leaves output in $WORK/never-<alias>.out, rc in NR_RC
  mknode "$1" "$2" "$WORK"
  touch "$FAKE/never-ready"
  set +e; CLI node start "$1" --external-appserver --verify-timeout 3 >"$WORK/never-$1.out" 2>&1; NR_RC=$?; set -e
  rm -f "$FAKE/never-ready"
}
check_never_ready() { # check_never_ready <alias>  → 0 when the guard held
  [ "$NR_RC" != 0 ] || return 1
  grep -qF 'did not answer 200' "$WORK/never-$1.out" || return 1
  has_session "$1-tui" && return 1
  has_session "$1" && return 1
  has_session "$1-appsrv" && return 1
  return 0
}
never_ready_run demo-node-never 47106
cat "$WORK/never-demo-node-never.out" >>"$REPORT"
check_never_ready demo-node-never || fail "readyz timeout did not stop the start cleanly (rc=$NR_RC)"
pass "no recorded layout → other lane; readyz never 200 → clear error after 30s, no TUI/bridge, app-server session removed"

log "[L9] mutations: each guard must turn this suite red when removed"
CLI_SRC="$ROOT/agent-network/bin/cli.ts"
MOD_SRC="$ROOT/agent-network/src/codex-external-appserver.ts"
BK=/tmp/mutation-backup; mkdir -p "$BK"
cp "$CLI_SRC" "$BK/cli.ts"; cp "$MOD_SRC" "$BK/mod.ts"
restore() { cp "$BK/cli.ts" "$CLI_SRC"; cp "$BK/mod.ts" "$MOD_SRC"; cmp -s "$BK/cli.ts" "$CLI_SRC" && cmp -s "$BK/mod.ts" "$MOD_SRC"; }

# M1: drop the readyz wait.
grep -c 'MUTATION-ANCHOR:readyz-wait' "$CLI_SRC" | grep -qx 1 || fail "readyz anchor missing or duplicated"
sed -i 's|^\(\s*\)const ready = await waitForReadyz(.*// MUTATION-ANCHOR:readyz-wait$|\1const ready = { ok: true, status: 200, waitedMs: 0 };|' "$CLI_SRC"
cmp -s "$BK/cli.ts" "$CLI_SRC" && fail "MUTATION_NOOP: readyz mutation changed nothing"
never_ready_run demo-node-m1 47107
cat "$WORK/never-demo-node-m1.out" >>"$REPORT"
if check_never_ready demo-node-m1; then restore; fail "M1 survived: removing the readyz wait left the suite green"; fi
CLI node stop demo-node-m1 >>"$REPORT" 2>&1 || true
restore || fail "restore after M1"
log "M1 (no readyz wait) → caught: rc=$NR_RC, sessions started on a never-ready app-server"

# M2: put the token into the session command line instead of reading it inside the session.
grep -c 'MUTATION-ANCHOR:token-in-session' "$MOD_SRC" | grep -qx 1 || fail "token anchor missing or duplicated"
sed -i 's|^\(\s*\)const tokenExport = tokenInSessionSnippet(.*// MUTATION-ANCHOR:token-in-session$|\1const tokenExport = "export ANET_CODEX_COMMHUB_TOKEN=" + q(JSON.parse(require("fs").readFileSync(plan.configPath, "utf8")).token);|' "$MOD_SRC"
cmp -s "$BK/mod.ts" "$MOD_SRC" && fail "MUTATION_NOOP: token mutation changed nothing"
mknode demo-node-m2 47108 "$WORK"
set +e; CLI node start demo-node-m2 --external-appserver --verify-timeout 10 >"$WORK/m2.out" 2>&1; set -e
cat "$WORK/m2.out" >>"$REPORT"
M2_CMD=$(token_in_cmdlines); M2_START=$(token_in_start_commands)
CLI node stop demo-node-m2 >>"$REPORT" 2>&1 || true
restore || fail "restore after M2"
[ "$M2_CMD" != 0 ] || [ "$M2_START" != 0 ] || fail "M2 survived: token in argv went unseen (cmdline=$M2_CMD start_command=$M2_START)"
log "M2 (token interpolated into the command) → caught: cmdline=$M2_CMD pane_start_command=$M2_START"
pass "mutations M1 (readyz) and M2 (token in argv) both turn the suite red; sources restored byte-identical"

log "RESULT: PASS ($PASSES layers)"

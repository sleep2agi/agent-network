#!/usr/bin/env bash
# test2060 — node env files end-to-end: throwaway hub + `anet secret` (daemon env, this
# machine) / `anet node secret` (node env) + a real agent-node, started through
# `anet node start` and directly. Proves what the unit tests cannot:
#   - the CLI writes ~/.anet/secrets.env and <node dir>/secrets.env as 0600, under umask 0002
#   - a value on argv is refused; `list` / `doctor` never print a value
#   - what the node's child sees: daemon only; node over daemon; config.json `env` above
#     the files; the start command's own env above everything (an EMPTY exported value is
#     kept); `_envRef` resolved from a file — compared by sha256, never by value
#   - the startup line lists key names in the right groups
#   - a restart from a clean env picks up the file values and drops the by-hand ones,
#     including a direct `agent-node --config` start
#   - a loose-mode file is tightened and loaded; a file owned by another user is not loaded
#   - no value in any log
#   - witnessed-red: without the loader line in agent-node, the direct start cannot resolve its secrets
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/test2060}"
PORT="${PORT:-9766}"
BASE="http://127.0.0.1:$PORT"
ALIAS="secrets-node"
ADMIN="secrets_admin"
PASSWORD="Secrets-Strong-1!"
rand() { head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
# Values that cannot appear anywhere by accident.
D_ONLY="sk-T2060D-$(rand)-DAEMON"
D_SHARED="sk-T2060DS-$(rand)-DSHARED"
D_CFG="sk-T2060DC-$(rand)-DCFG"
D_HAND="sk-T2060DH-$(rand)-DHAND"
N_SHARED="sk-T2060N-$(rand)-NODE"
N_SHARED2="sk-T2060N2-$(rand)-NODE2"
N_HAND="sk-T2060NH-$(rand)-NHAND"
N_EMPTY="sk-T2060NE-$(rand)-NEMPTY"
REF_VAL="sk-T2060R-$(rand)-REF"
BY_HAND="by-hand-$(rand)"
ALL_VALUES=("$D_ONLY" "$D_SHARED" "$D_CFG" "$D_HAND" "$N_SHARED" "$N_SHARED2" "$N_HAND" "$N_EMPTY" "$REF_VAL")
sha() { printf '%s' "$1" | sha256sum | cut -c1-64; }
PASS=0
ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

test "${TEST2060_SOURCE_COMMIT:-unknown}" != unknown
safe_rm_rf "$WORK"
mkdir -p "$WORK/home" "$WORK/proj" "$WORK/bin"
export HOME="$WORK/home"
umask 0002

HUB_PID="" LAUNCHER_PID="" DIRECT_PID=""
stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 60); do [[ ! -e "/proc/$pid" ]] && return 0; sleep 0.1; done
  kill -KILL -- "-$pid" 2>/dev/null || true
}
NODE_SRC="$REPO/agent-node/src/cli.ts"
cleanup() {
  stop_group "$LAUNCHER_PID" || true
  stop_group "$DIRECT_PID" || true
  stop_group "$HUB_PID" || true
  if [[ -f "$WORK/cli.ts.orig" ]]; then cp "$WORK/cli.ts.orig" "$NODE_SRC"; fi
}
trap cleanup EXIT

(cd "$REPO/server" && exec setsid env PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
  COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >"$WORK/hub.log" 2>&1) &
HUB_PID=$!
for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/health" >/dev/null || { tail -100 "$WORK/hub.log"; fail 'hub boot'; }
ok "throwaway hub on 127.0.0.1:$PORT (HOME=$HOME)"

REG=$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN\",\"password\":\"$PASSWORD\",\"email\":\"test2060@example.invalid\"}")
UTOK=$(jq -r '.token // empty' <<<"$REG")
NET=$(jq -r '.network_id // empty' <<<"$REG")
[[ "$UTOK" == utok_* && -n "$NET" ]] || fail 'admin registration'
NODE_ID="node_t2060_$(rand | head -c 12)"
NTOK=$(curl -fsS -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET\",\"node_name\":\"$ALIAS\",\"node_id\":\"$NODE_ID\"}" | jq -r '.token // empty')
[[ "$NTOK" == ntok_* ]] || fail 'node token mint'
ok 'admin + node token'

NODE_DIR="$WORK/proj/.anet/nodes/$ALIAS"
CFG="$NODE_DIR/config.json"
mkdir -p "$NODE_DIR"
( umask 077; cat >"$CFG" <<JSON
{"alias":"$ALIAS","node_name":"$ALIAS","node_id":"$NODE_ID","runtime":"claude-agent-sdk","model":"claude-sonnet-4-6","hub":"$BASE","token":"$NTOK","network_id":"$NET","env":{"FROM_CONFIG":"cfg-wins","REF_KEY":{"_envRef":"REF_TARGET"}}}
JSON
)
cat >"$WORK/bin/agent-node" <<SH
#!/usr/bin/env bash
exec bun "$NODE_SRC" "\$@"
SH
chmod +x "$WORK/bin/agent-node"
# The environment a node hands to the programs it runs is what matters, and a
# process's own /proc/<pid>/environ only shows what it was exec'd with — not what
# agent-node put into process.env afterwards. So the probe is the child: a fake
# `claude` (the claude-agent-sdk runtime spawns it for a task) records sha256 of
# each key's value, never the value. The SDK's bundled binary is removed so
# `which claude` picks the fake.
mkdir -p "$WORK/moved-sdk-binaries"
for d in "$REPO"/agent-node/node_modules/@anthropic-ai/claude-agent-sdk-linux-*; do
  if [[ -e "$d" ]]; then mv "$d" "$WORK/moved-sdk-binaries/"; fi
done
mkdir -p "$WORK/envdump"
cat >"$WORK/bin/claude" <<SH
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "2.0.0 (Claude Code)"; exit 0; fi
out="$WORK/envdump/dump.\$(date +%s%N).\$\$"
for k in DAEMON_ONLY SHARED HAND EMPTY_KEPT FROM_CONFIG REF_KEY; do
  if [[ -z "\${!k+x}" ]]; then printf '%s=absent\n' "\$k"
  elif [[ -z "\${!k}" ]]; then printf '%s=empty\n' "\$k"
  else printf '%s=%s\n' "\$k" "\$(printf '%s' "\${!k}" | sha256sum | cut -c1-64)"; fi
done >"\$out.tmp" && mv "\$out.tmp" "\$out"
exit 1
SH
chmod +x "$WORK/bin/claude"

anet() { (cd "$WORK/proj" && bun "$REPO/agent-network/bin/cli.ts" "$@"); }
CLI_LOG="$WORK/cli.log"

# ── 1. CLI: set (piped), argv refusal, reserved key, modes ──
printf '%s\n' "$D_ONLY"   | anet secret set DAEMON_ONLY >>"$CLI_LOG" 2>&1 || fail 'secret set DAEMON_ONLY'
printf '%s\n' "$D_SHARED" | anet secret set SHARED      >>"$CLI_LOG" 2>&1 || fail 'secret set SHARED'
printf '%s'   "$D_CFG"    | anet secret set FROM_CONFIG >>"$CLI_LOG" 2>&1 || fail 'secret set FROM_CONFIG'
printf '%s\n' "$D_HAND"   | anet secret set HAND        >>"$CLI_LOG" 2>&1 || fail 'secret set HAND'
printf '%s\n' "$N_SHARED" | anet node secret set "$ALIAS" SHARED     >>"$CLI_LOG" 2>&1 || fail 'node secret set SHARED'
printf '%s\n' "$REF_VAL"  | anet node secret set "$ALIAS" REF_TARGET >>"$CLI_LOG" 2>&1 || fail 'node secret set REF_TARGET'
printf '%s\n' "$N_HAND"   | anet node secret set "$ALIAS" HAND       >>"$CLI_LOG" 2>&1 || fail 'node secret set HAND'
printf '%s\n' "$N_EMPTY"  | anet node secret set "$ALIAS" EMPTY_KEPT >>"$CLI_LOG" 2>&1 || fail 'node secret set EMPTY_KEPT'
GFILE="$HOME/.anet/secrets.env"; NFILE="$NODE_DIR/secrets.env"
[[ "$(stat -c %a "$GFILE")" == 600 && "$(stat -c %a "$NFILE")" == 600 ]] || fail "modes: daemon $(stat -c %a "$GFILE") node $(stat -c %a "$NFILE") (umask $(umask))"
grep -Fq "running nodes are not touched; it takes effect on their next start" "$CLI_LOG" || fail 'set did not say it only changes the file'
ok 'anet secret set (daemon) / anet node secret set → both files 0600 under umask 0002; output says file-only, next start'


set +e
OUT=$(anet secret set ARGV_KEY "$D_ONLY" 2>&1); RC=$?
OUT2=$(printf 'x' | anet node secret set "$ALIAS" COMMHUB_TOKEN 2>&1); RC2=$?
set -e
[[ $RC -ne 0 && "$OUT" == *"never taken from the command line"* ]] || fail "argv value not refused (rc=$RC)"
[[ $RC2 -ne 0 && "$OUT2" == *reserved* ]] || fail "reserved key not refused (rc=$RC2)"
printf '%s\n%s\n' "$OUT" "$OUT2" >>"$CLI_LOG"
! grep -q ARGV_KEY "$GFILE" && ! grep -q COMMHUB_TOKEN "$NFILE" || fail 'refused key was written'
ok 'value on argv refused; reserved COMMHUB_TOKEN refused; nothing written'

LIST=$(anet secret list --node "$ALIAS" 2>&1)
printf '%s\n' "$LIST" >>"$CLI_LOG"
for k in DAEMON_ONLY SHARED REF_TARGET FROM_CONFIG HAND EMPTY_KEPT "overrides daemon" "ignored: config.json env"; do
  grep -Fq "$k" <<<"$LIST" || fail "list is missing '$k'"
done
grep -Eq "^SHARED +node +${#N_SHARED}  \(overrides daemon\)" <<<"$LIST" || fail "SHARED row: $(grep SHARED <<<"$LIST")"
ok 'anet secret list --node: keys, layer, length, override + config-shadow notes'

# ── 2. `anet node start` with values set by hand: HAND=<by hand>, EMPTY_KEPT="" ──
start_launcher() {  # extra args: VAR=value set by hand for this launch only
  (cd "$WORK/proj" && exec setsid env HOME="$HOME" PATH="$WORK/bin:$PATH" ANTHROPIC_API_KEY=test2060-not-used \
    "$@" bun "$REPO/agent-network/bin/cli.ts" node start "$ALIAS" >>"$WORK/launcher.log" 2>&1 </dev/null) &
  LAUNCHER_PID=$!
}
status_row() {
  curl -fsS "$BASE/api/status?network_id=$NET" -H "Authorization: Bearer $UTOK" | jq -c --arg a "$ALIAS" '.sessions[]? | select(.alias==$a)'
}
# The node process whose environment we inspect: the agent-node whose cmdline names our config.
node_pid() {  # procps is not in the slim image: scan /proc directly
  local d cmd
  for d in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null) || continue
    if [[ "$cmd" == *"agent-node/src/cli.ts"* && "$cmd" == *"--config $CFG"* ]]; then echo "${d#/proc/}"; return 0; fi
  done
  return 1
}
wait_node() {  # → pid of the agent-node for our config once it is up and registered
  local pid="" row
  for _ in $(seq 1 240); do
    pid=$(node_pid || true)
    if [[ -n "$pid" ]]; then
      row=$(status_row || true)
      if [[ -n "$row" ]] && jq -e '.status != "offline"' >/dev/null <<<"$row"; then echo "$pid"; return 0; fi
    fi
    sleep 0.25
  done
  return 1
}
DUMP=""
probe_env() {  # send a task; the fake claude it spawns records the env it got
  rm -f "$WORK/envdump"/dump.*
  local resp
  # Unique text per probe: the hub de-duplicates identical task text in a short window.
  resp=$(jq -nc --arg a "$ALIAS" --arg n "$NET" --arg t "env probe: $1 $(date +%s%N)" '{alias:$a, task:$t, priority:"normal", from:"test2060", network_id:$n}' \
    | curl -sS -X POST "$BASE/api/task" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' --data-binary @-) || true
  jq -e '.task_id // empty' >/dev/null <<<"$resp" || fail "$1: could not send the probe task: $resp"
  for _ in $(seq 1 240); do
    DUMP=$(find "$WORK/envdump" -name 'dump.*' ! -name '*.tmp' -type f | sort | tail -n1)
    [[ -n "$DUMP" ]] && return 0
    sleep 0.25
  done
  dump_diag; fail "$1: the node never ran the probe (no env dump)"
}
env_sha() { sed -n "s/^$1=//p" "$DUMP"; }
dump_diag() { echo "---- processes ----" >&2; for d in /proc/[0-9]*; do printf '%s %s\n' "${d#/proc/}" "$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null | cut -c1-160)"; done >&2; echo "---- status row ----" >&2; status_row >&2 || true; echo "---- launcher.log ----" >&2; tail -60 "$WORK/launcher.log" >&2 || true; echo "---- direct.log ----" >&2; tail -60 "$WORK/direct.log" >&2 || true; find "$WORK/proj/.anet" -path '*logs*' -type f -exec tail -40 {} + >&2 2>/dev/null || true; }
expect() {  # expect <label> <KEY> <absent|empty|value>
  local want="$3"
  [[ "$want" == absent || "$want" == empty ]] || want=$(sha "$want")
  [[ "$(env_sha "$2")" == "$want" ]] || fail "$1: $2 is $(env_sha "$2" | cut -c1-12), expected ${4:-$3 (sha)}"
}
check_env() {  # check_env <label> <node SHARED value> hand|clean
  local label="$1"
  probe_env "$label"
  expect "$label" DAEMON_ONLY "$D_ONLY" "the daemon value (daemon only)"
  expect "$label" SHARED "$2" "the node value (node overrides daemon)"
  expect "$label" FROM_CONFIG cfg-wins "config.json env (above both files)"
  expect "$label" REF_KEY "$REF_VAL" "_envRef resolved from the node file"
  if [[ "$3" == hand ]]; then
    expect "$label" HAND "$BY_HAND" "the by-hand value (process env overrides both files)"
    expect "$label" EMPTY_KEPT empty "the empty by-hand value (empty counts as present)"
  else
    expect "$label" HAND "$N_HAND" "the node file value (by-hand value gone after a clean restart)"
    expect "$label" EMPTY_KEPT "$N_EMPTY" "the node file value (by-hand empty gone after a clean restart)"
  fi
}

start_launcher HAND="$BY_HAND" EMPTY_KEPT=
PID=$(wait_node) || { dump_diag; fail 'node never came up via anet node start'; }
check_env "anet node start (by hand)" "$N_SHARED" hand
grep -Fq "[agent-node] env: daemon=[DAEMON_ONLY] node=[REF_TARGET,SHARED] kept-from-process=[EMPTY_KEPT,HAND] config-json=[FROM_CONFIG]" "$WORK/launcher.log" \
  || fail "startup line: $(grep -F '] env:' "$WORK/launcher.log" || echo none)"
ok "anet node start + by-hand HAND / empty EMPTY_KEPT → pid $PID child: DAEMON_ONLY=daemon, SHARED=node, FROM_CONFIG=config.json, REF_KEY via _envRef, HAND=by hand, EMPTY_KEPT kept empty; startup line groups the names (sha256 compared)"

# ── 2b. claude-code-cli: `anet node start` spawns `claude` itself (no agent-node) ──
CC_ALIAS="secrets-cc"
CC_ID="node_t2060cc_$(rand | head -c 12)"
CC_TOK=$(curl -fsS -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET\",\"node_name\":\"$CC_ALIAS\",\"node_id\":\"$CC_ID\"}" | jq -r '.token // empty')
[[ "$CC_TOK" == ntok_* ]] || fail 'cc node token mint'
CC_DIR="$WORK/proj/.anet/nodes/$CC_ALIAS"
mkdir -p "$CC_DIR"
( umask 077; cat >"$CC_DIR/config.json" <<JSON
{"alias":"$CC_ALIAS","node_name":"$CC_ALIAS","node_id":"$CC_ID","runtime":"claude-code-cli","hub":"$BASE","token":"$CC_TOK","network_id":"$NET","session":"$(cat /proc/sys/kernel/random/uuid)","env":{"FROM_CONFIG":"cfg-wins","REF_KEY":{"_envRef":"REF_TARGET"}}}
JSON
)
printf '%s\n' "$N_SHARED" | anet node secret set "$CC_ALIAS" SHARED     >>"$CLI_LOG" 2>&1 || fail 'cc node secret set SHARED'
printf '%s\n' "$REF_VAL"  | anet node secret set "$CC_ALIAS" REF_TARGET >>"$CLI_LOG" 2>&1 || fail 'cc node secret set REF_TARGET'
rm -f "$WORK/envdump"/dump.*
# claude-code-cli refuses to start without a TTY (#486): give it one.
(cd "$WORK/proj" && env HOME="$HOME" PATH="$WORK/bin:$PATH" HAND="$BY_HAND" EMPTY_KEPT= \
  timeout 60 script -qec "bun $REPO/agent-network/bin/cli.ts node start $CC_ALIAS" /dev/null >"$WORK/cc.log" 2>&1 </dev/null) || true
DUMP=$(find "$WORK/envdump" -name 'dump.*' ! -name '*.tmp' -type f | sort | tail -n1)
[[ -n "$DUMP" ]] || { tail -40 "$WORK/cc.log" >&2; fail 'claude-code-cli: anet never spawned claude'; }
expect cc DAEMON_ONLY "$D_ONLY"; expect cc SHARED "$N_SHARED"; expect cc FROM_CONFIG cfg-wins
expect cc REF_KEY "$REF_VAL"; expect cc HAND "$BY_HAND"; expect cc EMPTY_KEPT empty
grep -Fq "[anet] env: daemon=[DAEMON_ONLY] node=[REF_TARGET,SHARED] kept-from-process=[HAND] config-json=[FROM_CONFIG]" "$WORK/cc.log" \
  || fail "cc startup line: $(grep -F '] env:' "$WORK/cc.log" || echo none)"
ok 'anet node start (claude-code-cli) → the claude it spawns: same layering (daemon, node over daemon, config.json, _envRef, by-hand wins, empty kept)'

# ── 3. restart from a clean env (no by-hand values) after changing the node file ──
printf '%s\n' "$N_SHARED2" | anet node secret set "$ALIAS" SHARED >>"$CLI_LOG" 2>&1 || fail 'node secret update'
stop_group "$LAUNCHER_PID"; LAUNCHER_PID=""
for _ in $(seq 1 40); do node_pid >/dev/null || break; sleep 0.25; done
mv "$WORK/launcher.log" "$WORK/launcher.log.1"
start_launcher
PID2=$(wait_node) || { dump_diag; fail 'node never came back after restart'; }
[[ "$PID2" != "$PID" ]] || fail 'restart reused the old pid'
check_env "after clean restart" "$N_SHARED2" clean
grep -Fq "[agent-node] env: daemon=[DAEMON_ONLY] node=[EMPTY_KEPT,HAND,REF_TARGET,SHARED] kept-from-process=[] config-json=[FROM_CONFIG]" "$WORK/launcher.log" \
  || fail "startup line after restart: $(grep -F '] env:' "$WORK/launcher.log" || echo none)"
ok "clean restart → new pid $PID2: file values in effect (updated SHARED), the by-hand HAND and empty EMPTY_KEPT are gone — the files filled them"
stop_group "$LAUNCHER_PID"; LAUNCHER_PID=""
for _ in $(seq 1 40); do node_pid >/dev/null || break; sleep 0.25; done

# ── 4. direct start (no anet): the loader lives in agent-node ──
# Daemon file loosened to 0644 first: it must be tightened and still loaded.
chmod 0644 "$GFILE"
start_direct() {
  (cd "$WORK/proj" && exec setsid env HOME="$HOME" PATH="$WORK/bin:$PATH" ANTHROPIC_API_KEY=test2060-not-used \
    bun "$NODE_SRC" --alias "$ALIAS" --config "$CFG" >"$WORK/direct.log" 2>&1 </dev/null) &
  DIRECT_PID=$!
}
start_direct
PID3=$(wait_node) || { dump_diag; fail 'direct agent-node never came up'; }
check_env "direct agent-node" "$N_SHARED2" clean
[[ "$(stat -c %a "$GFILE")" == 600 ]] || fail "loose daemon file not tightened ($(stat -c %a "$GFILE"))"
grep -Fq "was mode 0644; tightened to 0600" "$WORK/direct.log" || fail 'no tightened notice in the node log'
ok "direct 'agent-node --config' (no anet, no exports) → pid $PID3 child has every file value; a 0644 daemon file was tightened to 0600 and loaded"
stop_group "$DIRECT_PID"; DIRECT_PID=""
for _ in $(seq 1 40); do node_pid >/dev/null || break; sleep 0.25; done

# ── 5. a node file owned by another user is refused ──
# Its REF_TARGET is what config.json's REF_KEY `_envRef` points at, so refusing the
# file must make the start fail closed on that ref (not silently start without it).
chown nobody "$NFILE"
start_direct
for _ in $(seq 1 120); do [[ -e "/proc/$DIRECT_PID" ]] || break; sleep 0.25; done
[[ ! -e "/proc/$DIRECT_PID" ]] || { dump_diag; fail 'agent-node kept running although its _envRef target was only in a refused file'; }
DIRECT_PID=""
grep -Fq "node secrets NOT loaded" "$WORK/direct.log" || fail 'no refusal line for a foreign-owned node file'
grep -Fq 'references env var "REF_TARGET" but it is not set' "$WORK/direct.log" || fail 'no fail-closed _envRef error after the refusal'
ok 'node secrets.env owned by another user → NOT loaded; the _envRef that needed it fails the start closed'
chown "$(id -u)" "$NFILE"

# ── 6. doctor reports files without values ──
DOC=$(cd "$WORK/proj" && timeout 120 bun "$REPO/agent-network/bin/cli.ts" doctor 2>&1 || true)
printf '%s\n' "$DOC" >"$WORK/doctor.log"
grep -Eq "Daemon env \(this machine\) .*mode 0600, 4 key\(s\)" <<<"$DOC" || fail "doctor daemon line: $(grep -F env <<<"$DOC" || true)"
grep -Eq "Node env $ALIAS .*mode 0600, 4 key\(s\)" <<<"$DOC" || fail "doctor node line: $(grep -F env <<<"$DOC" || true)"
ok 'anet doctor: both files, mode and key count'

# ── 7. no value in any output or log ──
LOGS=("$WORK/hub.log" "$CLI_LOG" "$WORK/cc.log" "$WORK/launcher.log" "$WORK/launcher.log.1" "$WORK/direct.log" "$WORK/doctor.log")
while IFS= read -r f; do LOGS+=("$f"); done < <(find "$WORK/proj/.anet" -path '*logs*' -type f 2>/dev/null)
for f in "${LOGS[@]}"; do
  [[ -f "$f" ]] || continue
  for v in "${ALL_VALUES[@]}"; do ! grep -Fq "$v" "$f" || fail "a secret value is in $f"; done
done
grep -sFq "] env: daemon=[DAEMON_ONLY]" "${LOGS[@]}" || fail 'positive control: no startup env line in the logs we scanned'
ok "no secret value in ${#LOGS[@]} log/output file(s) (the startup env lines are there, names only)"

# ── 8. witnessed-red: drop the loader's apply line → the direct start must not get its secrets ──
cp "$NODE_SRC" "$WORK/cli.ts.orig"
ANCHOR='  Object.assign(process.env, plan.set);'
grep -Fxq "$ANCHOR" "$NODE_SRC" || fail 'mutation anchor missing'
sed -i "s/^  Object.assign(process.env, plan.set);$/  void plan.set;/" "$NODE_SRC"
grep -Fxq '  void plan.set;' "$NODE_SRC" || fail 'mutation did not apply'
start_direct
for _ in $(seq 1 120); do [[ -e "/proc/$DIRECT_PID" ]] || break; sleep 0.25; done
cp "$WORK/cli.ts.orig" "$NODE_SRC"
[[ ! -e "/proc/$DIRECT_PID" ]] || { dump_diag; fail 'mutation stayed green: the node started without the loader line'; }
DIRECT_PID=""
grep -Fq 'references env var "REF_TARGET" but it is not set' "$WORK/direct.log" \
  || { dump_diag; fail 'mutated node died for some other reason (expected the unresolved REF_TARGET)'; }
ok 'witnessed-red: without the loader line the secrets never reach the node — its _envRef to a secrets-file key fails the start (step 4 would fail)'

printf 'source_commit=%s\n' "$TEST2060_SOURCE_COMMIT"
printf 'RESULT: PASS (%s checks)\n' "$PASS"

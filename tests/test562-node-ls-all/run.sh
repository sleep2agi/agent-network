#!/usr/bin/env bash
# test562-node-ls-all — `anet node ls --all` lists every node the Hub shows the logged-in user in one
# network, grouped by machine, with each machine's daemon (host_supervisor) state (#562 step 1, read-only).
#
# Real CLI (agent-network/bin/cli.ts) × real Hub (server/src/index.ts) on a random port, HOME=$(mktemp -d).
# Fixture (seed.ts, through the hub's own REST + MCP):
#   NET   host-alpha: alpha-daemon (role=host_supervisor), a-coder (idle), a-writer (working)
#         host-beta:  b-runner (offline)
#   OTHER host-gamma: x-other                      (another network of the same admin)
#   member t562m in NET, agent access restricted to a-coder only
# Cases:
#   A  admin, current network: grouped table, daemon line, daemon not a node row, OTHER not shown
#   B  admin --json: same grouping as data
#   C  admin --network <name of OTHER>: only x-other; --network nope → rc 1
#   D  restricted member: only a-coder, "daemon: none visible"; with COMMHUB_TOKEN=<a node token>
#      in the env the output is unchanged (the login token is used, never a node token)
#   E  `anet node ls` without --all is unchanged (local directory view)
# M1–M4 are witnessed reds; a mutation that does not apply is a failure (MUTATION_NOOP).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test562-node-ls-all.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test562-node-ls-all — anet node ls --all"
echo "source_commit=${TEST562_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

ROOT=/workspace
CLI="$ROOT/agent-network/bin/cli.ts"
HUB_PID=""
PW='t562-password-xyz-Q1'

anet() { bun "$CLI" "$@"; }
health_ok() { bun -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' "http://127.0.0.1:$PORT/health"; }
free_port() { bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop(true)'; }
cfg() { bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.anet/config.json","utf8"))[process.argv[1]] ?? "")' "$1"; }

start_hub() {
  pushd "$ROOT/server" >/dev/null
  PORT="$PORT" COMMHUB_DB="$HUB_DB" COMMHUB_UPLOADS_DIR="$WORK/uploads" bun src/index.ts >>"$WORK/hub.log" 2>&1 &
  HUB_PID=$!
  popd >/dev/null
  for _ in $(seq 1 100); do
    if health_ok; then return 0; fi
    sleep 0.2
  done
  echo "FAIL: hub did not come up on :$PORT"; tail -50 "$WORK/hub.log"; return 1
}
# Stops exactly the hub this script started (by its pid; never by pattern).
stop_hub() {
  [ -n "$HUB_PID" ] || return 0
  kill "$HUB_PID" 2>/dev/null || true
  wait "$HUB_PID" 2>/dev/null || true
  HUB_PID=""
}

# Lines of the block that starts at the machine header "  <host>   daemon:" up to the next header/blank.
block_of() { awk -v h="  $1   daemon:" 'index($0,h)==1{on=1;print;next} on&&/^  [^ ]/{on=0} on&&/^$/{on=0} on{print}' <<<"$2"; }
has() { printf '%s\n' "$2" | grep -Eq -- "$1"; }

run_cases() {
  WORK=$(mktemp -d)
  local ADMIN_HOME="$WORK/admin" MEMBER_HOME="$WORK/member"
  mkdir -p "$ADMIN_HOME" "$MEMBER_HOME" "$WORK/proj"
  cd "$WORK/proj"
  PORT=$(free_port); HUB_DB="$WORK/hub.db"
  start_hub || return 1
  local hub="http://127.0.0.1:$PORT" out rc seed

  export HOME="$ADMIN_HOME"
  anet register --hub "$hub" --username t562admin --password "$PW" >"$WORK/register.log" 2>&1 || { cat "$WORK/register.log"; echo "FAIL: register"; return 1; }
  anet login --hub "$hub" --username t562admin --password "$PW" >"$WORK/login.log" 2>&1 || { cat "$WORK/login.log"; echo "FAIL: login"; return 1; }
  local ADMIN_TOK NET
  ADMIN_TOK=$(cfg token); NET=$(cfg network_id)
  [[ "$ADMIN_TOK" == utok_* && -n "$NET" ]] || { echo "FAIL: admin login state (token/network_id missing)"; return 1; }
  seed=$(bun "$ROOT/tests/test562-node-ls-all/seed.ts" "$hub" "$ADMIN_TOK" "$NET" t562m "$PW" 2>"$WORK/seed.err") || { cat "$WORK/seed.err"; echo "FAIL: seed"; return 1; }
  local OTHER DAEMON_NTOK
  OTHER=$(bun -e 'console.log(JSON.parse(process.argv[1]).other)' "$seed")
  DAEMON_NTOK=$(bun -e 'console.log(JSON.parse(process.argv[1]).daemonNtok)' "$seed")

  echo "  [A] admin, current network"
  rc=0; out=$(anet node ls --all 2>&1) || rc=$?
  printf '%s\n' "$out" | sed 's/^/      /'
  [ "$rc" -eq 0 ] || { echo "FAIL: A rc=$rc"; return 1; }
  has '3 node\(s\) on 2 machine\(s\)' "$out" || { echo "FAIL: A summary line"; return 1; }
  local alpha beta
  alpha=$(block_of host-alpha "$out"); beta=$(block_of host-beta "$out")
  has 'daemon: alpha-daemon online — remote-manageable' "$alpha" || { echo "FAIL: A host-alpha daemon line"; return 1; }
  has '^    a-coder +claude-agent-sdk +idle +[0-9]+s ago +model-coder-1$' "$alpha" || { echo "FAIL: A a-coder row under host-alpha"; return 1; }
  has '^    a-writer +codex-app-server +working +[0-9]+s ago +model-writer-2$' "$alpha" || { echo "FAIL: A a-writer row under host-alpha"; return 1; }
  has 'daemon: none visible' "$beta" || { echo "FAIL: A host-beta daemon line"; return 1; }
  has '^    b-runner +grok-build-cli +offline ' "$beta" || { echo "FAIL: A b-runner row under host-beta"; return 1; }
  has '^    alpha-daemon ' "$out" && { echo "FAIL: A the daemon is listed as a node row"; return 1; }
  has 'x-other|host-gamma' "$out" && { echo "FAIL: A another network's node leaked into the current network"; return 1; }
  echo "  PASS A"

  echo "  [B] admin --json"
  rc=0; out=$(anet node ls --all --json 2>&1) || rc=$?
  [ "$rc" -eq 0 ] || { printf '%s\n' "$out"; echo "FAIL: B rc=$rc"; return 1; }
  local shape
  shape=$(bun -e '
    const j = JSON.parse(process.argv[1]);
    console.log(j.network.network_id === process.argv[2], j.daemons_readable,
      j.machines.map(m => `${m.hostname}:${m.daemon}:${m.nodes.map(n => n.alias + "/" + n.status).join(",")}`).join(" "));
  ' "$out" "$NET") || { printf '%s\n' "$out"; echo "FAIL: B not JSON"; return 1; }
  echo "      $shape"
  [ "$shape" = "true true host-alpha:online:a-coder/idle,a-writer/working host-beta:none-visible:b-runner/offline" ] || { echo "FAIL: B json shape"; return 1; }
  echo "  PASS B"

  echo "  [C] admin --network"
  rc=0; out=$(anet node ls --all --network t562-other 2>&1) || rc=$?
  printf '%s\n' "$out" | sed 's/^/      /'
  [ "$rc" -eq 0 ] || { echo "FAIL: C rc=$rc"; return 1; }
  has '^    x-other ' "$(block_of host-gamma "$out")" || { echo "FAIL: C x-other under host-gamma"; return 1; }
  has 'a-coder|host-alpha' "$out" && { echo "FAIL: C current network's nodes shown for --network t562-other"; return 1; }
  rc=0; out=$(anet node ls --all --network "$OTHER" 2>&1) || rc=$?
  [ "$rc" -eq 0 ] && has '^    x-other ' "$out" || { echo "FAIL: C --network <id>"; return 1; }
  rc=0; out=$(anet node ls --all --network nope 2>&1) || rc=$?
  [ "$rc" -eq 1 ] || { printf '%s\n' "$out"; echo "FAIL: C --network nope rc=$rc (want 1)"; return 1; }
  has 'no network "nope"' "$out" || { echo "FAIL: C --network nope message"; return 1; }
  echo "  PASS C"

  echo "  [D] restricted member"
  export HOME="$MEMBER_HOME"
  anet login --hub "$hub" --username t562m --password "$PW" >"$WORK/mlogin.log" 2>&1 || { cat "$WORK/mlogin.log"; echo "FAIL: member login"; return 1; }
  rc=0; out=$(anet node ls --all --network "$NET" 2>&1) || rc=$?
  printf '%s\n' "$out" | sed 's/^/      /'
  [ "$rc" -eq 0 ] || { echo "FAIL: D rc=$rc"; return 1; }
  has '1 node\(s\) on 1 machine\(s\)' "$out" || { echo "FAIL: D member summary (want exactly the granted node)"; return 1; }
  has '^    a-coder ' "$(block_of host-alpha "$out")" || { echo "FAIL: D a-coder under host-alpha"; return 1; }
  has 'a-writer|b-runner|x-other|alpha-daemon' "$out" && { echo "FAIL: D member sees nodes that were not granted"; return 1; }
  has 'host-alpha   daemon: none visible' "$out" || { echo "FAIL: D member daemon line"; return 1; }
  has 'hides daemons from members whose agent access is restricted' "$out" || { echo "FAIL: D footnote"; return 1; }
  local member_out=$out
  rc=0; out=$(COMMHUB_TOKEN="$DAEMON_NTOK" anet node ls --all --network "$NET" 2>&1) || rc=$?
  [ "$rc" -eq 0 ] || { printf '%s\n' "$out"; echo "FAIL: D(ntok env) rc=$rc"; return 1; }
  [ "$(printf '%s\n' "$out" | sed 's/[0-9]*s ago/Ns ago/')" = "$(printf '%s\n' "$member_out" | sed 's/[0-9]*s ago/Ns ago/')" ] \
    || { printf '%s\n' "$out" | sed 's/^/      /'; echo "FAIL: D a node token in COMMHUB_TOKEN changed what the member sees"; return 1; }
  echo "  PASS D"

  echo "  [E] node ls without --all is unchanged"
  export HOME="$ADMIN_HOME"
  rc=0; out=$(anet node ls 2>&1) || rc=$?
  printf '%s\n' "$out" | sed 's/^/      /'
  has 'No sessions or nodes in this directory' "$out" || { echo "FAIL: E plain node ls changed"; return 1; }
  has 'host-alpha|daemon:' "$out" && { echo "FAIL: E plain node ls shows the --all view"; return 1; }
  echo "  PASS E"

  stop_hub || true
  cd /; safe_rm_rf "$WORK"
  return 0
}

echo "L0 green: real CLI x real hub"
run_cases || { echo "FAIL: L0 not green"; stop_hub || true; exit 1; }

check_red() {
  local label=$1 file=$2 backup=$3
  if cmp -s "$file" "$backup"; then
    echo "MUTATION_NOOP: $label (anchor not found in $file)"
    exit 1
  fi
  local rc=0
  run_cases > "/tmp/test562-$label.log" 2>&1 || rc=$?
  stop_hub || true
  cd "$ROOT/agent-network"
  cp "$backup" "$file"
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    exit 1
  fi
  echo "MUTATION_RED: $label ($(grep -m1 '^FAIL' "/tmp/test562-$label.log" || echo 'no FAIL line'))"
}

cd "$ROOT/agent-network"
cp bin/cli.ts /tmp/test562-cli.ts
cp src/node-ls-all.ts /tmp/test562-mod.ts

echo "M1 witnessed-red: the daemon list is never read"
sed -i 's|  const daemons = sup.ok && Array.isArray(sup.body?.daemons) ? sup.body.daemons : null;|  const daemons: any[] = [];|' bin/cli.ts
check_red daemons-ignored bin/cli.ts /tmp/test562-cli.ts

echo "M2 witnessed-red: reads with getToken() (COMMHUB_TOKEN wins over the login)"
sed -i 's|  const token = gc.token \|\| "";|  const token = getToken();|' bin/cli.ts
check_red node-token-precedence bin/cli.ts /tmp/test562-cli.ts

echo "M3 witnessed-red: /api/status without network_id (all of the admin's networks)"
sed -i 's|    getJson(`/api/status?${netQ}`),|    getJson(`/api/status`),|' bin/cli.ts
check_red status-unscoped bin/cli.ts /tmp/test562-cli.ts

echo "M4 witnessed-red: the daemon's own session shown as a node row"
sed -i 's|    if (daemonAliases.has(alias)) continue;|    void daemonAliases;|' src/node-ls-all.ts
check_red daemon-as-node src/node-ls-all.ts /tmp/test562-mod.ts

echo "L1 restored green"
run_cases || { echo "FAIL: restore not green"; stop_hub || true; exit 1; }

echo "RESULT: PASS"

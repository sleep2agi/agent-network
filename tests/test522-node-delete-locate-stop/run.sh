#!/usr/bin/env bash
# test522-node-delete-locate-stop — `anet node delete` finds --workdir copies and stops co-presence sessions (#522).
#
# Real CLI (agent-network/bin/cli.ts) × real Hub (server/src/index.ts) on a random port,
# HOME=$(mktemp -d), tmux on a private socket (-L t522 / ANET_TMUX_SOCKET). Cases:
#   A  elsewhere   clone src → cp1 --workdir D; delete cp1 --force from the source dir
#                  → rc 1, nothing deleted, prints exactly `cd 'D' && anet node delete 'cp1' --force`;
#                  running that printed command deletes it (rc 0, dir gone, Hub row gone)
#   B  ambiguous   two copies in two workdirs both answer to "d1" → delete d1 --force refuses
#                  (rc 1, "refusing to delete", both dirs intact, one command per candidate)
#   C  co-presence node c1 carries a co-presence identity marker; tmux session c1-appsrv runs a
#                  process with that marker + the node's CODEX_HOME; c1-appsrv-bak (similar name,
#                  no marker) is unrelated. delete (preview) stops nothing; delete --force kills
#                  c1-appsrv and leaves c1-appsrv-bak running.
# M1–M4 are witnessed reds, one per rule; a mutation that does not apply fails (MUTATION_NOOP).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test522-node-delete-locate-stop.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test522-node-delete-locate-stop — delete finds workdir copies, stops co-presence sessions"
echo "source_commit=${TEST522_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"
echo "tmux=$(tmux -V)"

ROOT=/workspace
CLI="$ROOT/agent-network/bin/cli.ts"
HUB_PID=""
TMUX_L=t522
# Same server for us (-L) and for anet (-S): tmux puts -L sockets at ${TMUX_TMPDIR:-/tmp}/tmux-<uid>/<name>.
unset TMUX_TMPDIR TMUX
export ANET_TMUX_SOCKET="/tmp/tmux-$(id -u)/$TMUX_L"
t() { tmux -L "$TMUX_L" "$@"; }
alive() { t has-session -t "=$1" 2>/dev/null; }

anet() { bun "$CLI" "$@"; }

health_ok() { bun -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' "http://127.0.0.1:$PORT/health"; }
free_port() { bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop(true)'; }

start_hub() {
  pushd "$ROOT/server" >/dev/null
  PORT="$PORT" COMMHUB_DB="$HUB_DB" bun src/index.ts >>"$WORK/hub.log" 2>&1 &
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

# Kill only the sessions this script created, by exact name. Never kill-server.
cleanup_tmux() {
  local s
  for s in c1-appsrv c1-appsrv-bak; do t kill-session -t "=$s" 2>/dev/null || true; done
}

token() { bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.anet/config.json","utf8")).token)'; }
node_id_at() { bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).node_id)' "$1/.anet/nodes/$2/config.json"; }

rows_for() {
  TOKEN=$(token) bun -e '
    const [url, id] = process.argv.slice(1);
    const r = await fetch(`${url}/api/nodes?node_id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${process.env.TOKEN}` } });
    const j = await r.json();
    if (!r.ok || !Array.isArray(j.nodes)) { console.error("rows_for: HTTP", r.status, JSON.stringify(j)); process.exit(1); }
    console.log(j.nodes.filter((n) => n.node_id === id).length);
  ' "http://127.0.0.1:$PORT" "$1"
}

run_cases() {
  WORK=$(mktemp -d)
  export HOME="$WORK/home"; mkdir -p "$HOME" "$WORK/proj"
  cd "$WORK/proj"
  PORT=$(free_port)
  HUB_DB="$WORK/hub.db"
  start_hub || return 1
  local hub="http://127.0.0.1:$PORT" out rc id want

  anet register --hub "$hub" --username t522 --password 't522-password-xyz' >"$WORK/register.log" 2>&1 || { cat "$WORK/register.log"; echo "FAIL: register"; return 1; }
  anet login --hub "$hub" --username t522 --password 't522-password-xyz' >"$WORK/login.log" 2>&1 || { cat "$WORK/login.log"; echo "FAIL: login"; return 1; }
  anet node create src --runtime claude-agent-sdk >"$WORK/src-create.log" 2>&1 || { cat "$WORK/src-create.log"; echo "FAIL: create src"; return 1; }

  echo "  [A] delete from the source dir finds the --workdir copy"
  anet node clone src cp1 --workdir "$WORK/cp1dir" >"$WORK/a-clone.log" 2>&1 || { cat "$WORK/a-clone.log"; echo "FAIL: A clone"; return 1; }
  [ -d "$WORK/cp1dir/.anet/nodes/cp1" ] || { echo "FAIL: A precondition — clone not in its workdir"; return 1; }
  id=$(node_id_at "$WORK/cp1dir" cp1)
  rc=0; out=$(anet node delete cp1 --force 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 1 ] || { echo "FAIL: A rc=$rc (want 1: printed, not acted)"; return 1; }
  [ -d "$WORK/cp1dir/.anet/nodes/cp1" ] || { echo "FAIL: A deleted a node that lives in another directory"; return 1; }
  want="cd '$WORK/cp1dir' && anet node delete 'cp1' --force"
  printf '%s\n' "$out" | grep -Fxq "  $want" || { echo "FAIL: A did not print the exact command: $want"; return 1; }
  rc=0; out=$(bash -c "${want/anet /bun $CLI }" 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 0 ] || { echo "FAIL: A printed command rc=$rc"; return 1; }
  [ ! -e "$WORK/cp1dir/.anet/nodes/cp1" ] || { echo "FAIL: A printed command left the node dir"; return 1; }
  [ "$(rows_for "$id")" = 0 ] || { echo "FAIL: A printed command left the hub row"; return 1; }
  echo "  PASS A"

  echo "  [B] two candidates with the same name → refuse"
  anet node clone src d1 --workdir "$WORK/d1dir" >"$WORK/b-clone1.log" 2>&1 || { cat "$WORK/b-clone1.log"; echo "FAIL: B clone d1"; return 1; }
  anet node clone src d2 --workdir "$WORK/d2dir" >"$WORK/b-clone2.log" 2>&1 || { cat "$WORK/b-clone2.log"; echo "FAIL: B clone d2"; return 1; }
  # The second copy is renamed by hand to answer to "d1" too (same shape as an alias reused elsewhere).
  bun -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));for(const k of ["node_name","name","alias"]) c[k]="d1";fs.writeFileSync(f,JSON.stringify(c,null,2))' "$WORK/d2dir/.anet/nodes/d2/config.json"
  rc=0; out=$(anet node delete d1 --force 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 1 ] || { echo "FAIL: B rc=$rc (want 1)"; return 1; }
  printf '%s\n' "$out" | grep -Fq 'refusing to delete "d1": 2 nodes match it' || { echo "FAIL: B no clear refusal"; return 1; }
  [ -d "$WORK/d1dir/.anet/nodes/d1" ] && [ -d "$WORK/d2dir/.anet/nodes/d2" ] || { echo "FAIL: B deleted one of two candidates"; return 1; }
  printf '%s\n' "$out" | grep -Fq "cd '$WORK/d1dir' && anet node delete '$(node_id_at "$WORK/d1dir" d1)'" || { echo "FAIL: B no command for d1dir"; return 1; }
  printf '%s\n' "$out" | grep -Fq "cd '$WORK/d2dir' && anet node delete '$(node_id_at "$WORK/d2dir" d2)'" || { echo "FAIL: B no command for d2dir"; return 1; }
  echo "  PASS B"

  echo "  [C] co-presence session stopped by identity; similar-named session survives"
  anet node create c1 --runtime claude-agent-sdk >"$WORK/c-create.log" 2>&1 || { cat "$WORK/c-create.log"; echo "FAIL: C create"; return 1; }
  local ndir="$WORK/proj/.anet/nodes/c1" uuid
  mkdir -p "$ndir/codex-home"
  uuid=$(cat /proc/sys/kernel/random/uuid)
  printf '{"marker":"%s","boot_id":"%s","started_at_epoch_ms":%s,"owner_uid":%s,"sessions":{}}\n' \
    "$uuid" "$(cat /proc/sys/kernel/random/boot_id)" "$(date +%s000)" "$(id -u)" > "$ndir/copresence-identity.json"
  chmod 600 "$ndir/copresence-identity.json"
  t new-session -d -s c1-appsrv -e "ANET_NODE_MARKER=$uuid" -e "CODEX_HOME=$(realpath "$ndir/codex-home")" bash -c 'exec sleep 600'
  t new-session -d -s c1-appsrv-bak bash -c 'exec sleep 600'
  alive c1-appsrv && alive c1-appsrv-bak || { echo "FAIL: C precondition — sessions not up"; return 1; }
  rc=0; out=$(anet node delete c1 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 0 ] && alive c1-appsrv || { echo "FAIL: C preview (no --force) stopped something or failed rc=$rc"; return 1; }
  rc=0; out=$(anet node delete c1 --force 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 0 ] || { echo "FAIL: C rc=$rc"; return 1; }
  ! alive c1-appsrv || { echo "FAIL: C the node's co-presence session c1-appsrv survived delete"; return 1; }
  alive c1-appsrv-bak || { echo "FAIL: C unrelated session c1-appsrv-bak was killed"; return 1; }
  [ ! -e "$ndir" ] || { echo "FAIL: C node dir still there"; return 1; }
  echo "  PASS C"

  cleanup_tmux
  stop_hub || true
  cd /; safe_rm_rf "$WORK"
  return 0
}

echo "L0 green: real CLI x real hub x private tmux"
run_cases || { echo "FAIL: L0 not green"; cleanup_tmux; stop_hub || true; exit 1; }

check_red() {
  local label=$1 file=$2 backup=$3
  if cmp -s "$file" "$backup"; then
    echo "MUTATION_NOOP: $label (anchor not found in $file)"
    exit 1
  fi
  local rc=0
  run_cases > "/tmp/test522-$label.log" 2>&1 || rc=$?
  cleanup_tmux
  stop_hub || true
  cd "$ROOT/agent-network"
  cp "$backup" "$file"
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    exit 1
  fi
  echo "MUTATION_RED: $label ($(grep -m1 '^FAIL' "/tmp/test522-$label.log" || echo 'no FAIL line'))"
}

cd "$ROOT/agent-network"
cp bin/cli.ts /tmp/test522-cli.ts
cp src/node-locate.ts /tmp/test522-locate.ts

echo "M1 witnessed-red (A): delete looks only in the current directory"
sed -i 's|^  for (const root of otherNodeRoots(cwdRoot, codexFingerprintIndexDir())) matches.push(...inRoot(root));$|  void otherNodeRoots;|' bin/cli.ts
check_red cwd-only bin/cli.ts /tmp/test522-cli.ts

echo "M2 witnessed-red (B): several candidates ⇒ take the first"
sed -i 's|^  return { kind: "ambiguous", matches: all };$|  return place(all[0]!);|' src/node-locate.ts
check_red first-candidate src/node-locate.ts /tmp/test522-locate.ts

echo "M3 witnessed-red (C): delete only stops the pidfile process (the pre-#522 stop)"
sed -i 's|^  await stopResolvedNode({ id: nodeId, profile });$|  await stopNode(nodeId); await notifyServerOffline(profile, nodeId);|' bin/cli.ts
check_red pidfile-only bin/cli.ts /tmp/test522-cli.ts

echo "M4 witnessed-red (C): sessions matched by name prefix"
sed -i 's|^  await stopResolvedNode({ id: nodeId, profile });$|  await stopResolvedNode({ id: nodeId, profile }); try { for (const s of execTmux(["ls", "-F", "#{session_name}"], { encoding: "utf-8" }).split("\\n")) if (s \&\& s.startsWith(displayName)) killTmuxSession(s); } catch {}|' bin/cli.ts
check_red prefix-kill bin/cli.ts /tmp/test522-cli.ts

echo "L1 restored green"
run_cases || { echo "FAIL: restore not green"; cleanup_tmux; stop_hub || true; exit 1; }

echo "RESULT: PASS"

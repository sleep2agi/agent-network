#!/usr/bin/env bash
# test516-node-delete-hub-row — `anet node delete` also removes the node's Hub row (#516 part 2).
#
# Real CLI (agent-network/bin/cli.ts) × real Hub (server/src/index.ts) on a random
# port, with HOME=$(mktemp -d). Three cases:
#   A  row removed        create → row exists → delete --force → rc 0, row gone, local dir gone
#   B  hub down           create → stop hub → delete --force → rc 1, local dir gone, warning
#                         carries the retry command; hub back → that exact command removes the row
#   C  node_id mismatch   create → local config's node_id replaced (alias reuse) → delete --force
#                         → the Hub row with that alias is untouched, rc 0, "Left untouched"
# M1–M3 are witnessed reds: each one breaks one rule and the cases must go red.
# A mutation that does not apply is a failure too (MUTATION_NOOP).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test516-node-delete-hub-row.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test516-node-delete-hub-row — node delete removes the Hub row"
echo "source_commit=${TEST516D_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

ROOT=/workspace
CLI="$ROOT/agent-network/bin/cli.ts"
HUB_PID=""

anet() { bun "$CLI" "$@"; }

# oven/bun has no curl: tiny fetch helpers in bun.
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
  for _ in $(seq 1 50); do
    health_ok || return 0
    sleep 0.1
  done
  echo "FAIL: hub still answering after stop"; return 1
}

token() { bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.anet/config.json","utf8")).token)'; }
node_id_of() { bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).node_id)' "$PWD/.anet/nodes/$1/config.json"; }

# rows on the Hub with exactly this node_id (0 or 1)
rows_for() {
  TOKEN=$(token) bun -e '
    const [url, id] = process.argv.slice(1);
    const r = await fetch(`${url}/api/nodes?node_id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${process.env.TOKEN}` } });
    const j = await r.json();
    if (!r.ok || !Array.isArray(j.nodes)) { console.error("rows_for: HTTP", r.status, JSON.stringify(j)); process.exit(1); }
    console.log(j.nodes.filter((n) => n.node_id === id).length);
  ' "http://127.0.0.1:$PORT" "$1"
}

# One full pass over A/B/C. Returns non-zero on the first broken expectation.
run_cases() {
  WORK=$(mktemp -d)
  export HOME="$WORK/home"; mkdir -p "$HOME" "$WORK/proj"
  cd "$WORK/proj"
  PORT=$(free_port)
  HUB_DB="$WORK/hub.db"
  start_hub || return 1
  local hub="http://127.0.0.1:$PORT" out rc id

  anet register --hub "$hub" --username t516 --password 't516-password-xyz' >"$WORK/register.log" 2>&1 || { cat "$WORK/register.log"; echo "FAIL: register"; return 1; }
  anet login --hub "$hub" --username t516 --password 't516-password-xyz' >"$WORK/login.log" 2>&1 || { cat "$WORK/login.log"; echo "FAIL: login"; return 1; }

  echo "  [A] row removed"
  anet node create a1 --runtime claude-agent-sdk >"$WORK/a-create.log" 2>&1 || { cat "$WORK/a-create.log"; echo "FAIL: A create"; return 1; }
  id=$(node_id_of a1)
  [ "$(rows_for "$id")" = 1 ] || { echo "FAIL: A precondition — no hub row for $id"; return 1; }
  rc=0; out=$(anet node delete a1 --force 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 0 ] || { echo "FAIL: A rc=$rc (want 0)"; return 1; }
  [ ! -e .anet/nodes/a1 ] || { echo "FAIL: A local dir still there"; return 1; }
  [ "$(rows_for "$id")" = 0 ] || { echo "FAIL: A hub row for $id still there"; return 1; }
  echo "  PASS A"

  echo "  [B] hub down"
  anet node create b1 --runtime claude-agent-sdk >"$WORK/b-create.log" 2>&1 || { cat "$WORK/b-create.log"; echo "FAIL: B create"; return 1; }
  id=$(node_id_of b1)
  [ "$(rows_for "$id")" = 1 ] || { echo "FAIL: B precondition — no hub row for $id"; return 1; }
  stop_hub || return 1
  rc=0; out=$(anet node delete b1 --force 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 1 ] || { echo "FAIL: B rc=$rc (want 1)"; return 1; }
  [ ! -e .anet/nodes/b1 ] || { echo "FAIL: B local dir must be deleted even when the hub is down"; return 1; }
  printf '%s\n' "$out" | grep -Fq "Hub row was NOT removed" || { echo "FAIL: B no warning"; return 1; }
  local retry
  retry=$(printf '%s\n' "$out" | grep -Eo "anet node delete [^ ]+ --hub-only.*$" || true)
  [ "$retry" = "anet node delete $id --hub-only" ] || { echo "FAIL: B retry command is '$retry'"; return 1; }
  start_hub || return 1
  [ "$(rows_for "$id")" = 1 ] || { echo "FAIL: B hub row should still exist before the retry"; return 1; }
  rc=0; out=$(anet ${retry#anet } 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 0 ] || { echo "FAIL: B retry rc=$rc"; return 1; }
  [ "$(rows_for "$id")" = 0 ] || { echo "FAIL: B retry left the hub row"; return 1; }
  echo "  PASS B"

  echo "  [C] node_id mismatch (alias reuse)"
  anet node create c1 --runtime claude-agent-sdk >"$WORK/c-create.log" 2>&1 || { cat "$WORK/c-create.log"; echo "FAIL: C create"; return 1; }
  id=$(node_id_of c1)
  [ "$(rows_for "$id")" = 1 ] || { echo "FAIL: C precondition — no hub row for $id"; return 1; }
  # Same alias, different identity: this local config is not the node that owns the Hub row.
  bun -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.node_id="n_t516_someone_else";fs.writeFileSync(f,JSON.stringify(c,null,2))' "$PWD/.anet/nodes/c1/config.json"
  rc=0; out=$(anet node delete c1 --force 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$(rows_for "$id")" = 1 ] || { echo "FAIL: C deleted the Hub row of node_id $id, which is not ours"; return 1; }
  [ "$rc" -eq 0 ] || { echo "FAIL: C rc=$rc (want 0: nothing of ours was on the hub)"; return 1; }
  printf '%s\n' "$out" | grep -Fq "Left untouched" || { echo "FAIL: C did not say the other row was left untouched"; return 1; }
  [ ! -e .anet/nodes/c1 ] || { echo "FAIL: C local dir still there"; return 1; }
  echo "  PASS C"

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
  run_cases > "/tmp/test516d-$label.log" 2>&1 || rc=$?
  stop_hub || true
  cd "$ROOT/agent-network"   # run_cases changes directory
  cp "$backup" "$file"
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    exit 1
  fi
  echo "MUTATION_RED: $label ($(grep -m1 '^FAIL' "/tmp/test516d-$label.log" || echo 'no FAIL line'))"
}

cd "$ROOT/agent-network"
cp src/node-delete-hub.ts /tmp/test516d-hub.ts
cp bin/cli.ts /tmp/test516d-cli.ts

echo "M1 witnessed-red: delete by alias instead of node_id (the alias-reuse hazard)"
sed -i 's|const mine = list.nodes.filter((r: any) => r \&\& r.node_id === nodeId);|const mine = [1];|' src/node-delete-hub.ts
sed -i 's|const delRes = await call(`${hub}/api/nodes/${encodeURIComponent(nodeId)}`, "DELETE");|const delRes = await call(`${hub}/api/nodes/${encodeURIComponent(input.alias \|\| nodeId)}`, "DELETE");|' src/node-delete-hub.ts
check_red delete-by-alias src/node-delete-hub.ts /tmp/test516d-hub.ts

echo "M2 witnessed-red: hub failure exits 0"
sed -i 's|^  if (removal.kind === "failed") markFailed(); // hub half failed: exit 1 (#2321)$|  void removal;|' bin/cli.ts
check_red hub-failure-exit-0 bin/cli.ts /tmp/test516d-cli.ts

echo "M3 witnessed-red: delete never calls the hub"
sed -i 's|const removal = await removeNodeFromHub({ hub, token, nodeId: profile.node_id, alias: displayName });|const removal = { kind: "skipped", reason: "no-hub" } as const;|' bin/cli.ts
check_red no-hub-call bin/cli.ts /tmp/test516d-cli.ts

echo "L1 restored green"
run_cases || { echo "FAIL: restore not green"; stop_hub || true; exit 1; }

echo "RESULT: PASS"

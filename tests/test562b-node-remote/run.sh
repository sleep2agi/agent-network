#!/usr/bin/env bash
# test562b-node-remote — `anet node <start|stop|restart> <alias> --remote` and
# `anet node edit <alias> --model <id> --remote` (#562 step 2).
#
# Real hub (random port, throwaway DB) + real `anet daemon up` (host_supervisor) on hostname machine-b
# (the container is run with --hostname machine-b) + a real child it created (coder-b). The CLI under
# test is agent-network/bin/cli.ts from source, with its OWN HOME and an empty cwd: coder-b is not a
# local node to it — every action goes through the hub.
# Fixture also: hand-c (reported from hostname machine-c, which has no daemon), a member whose agent
# access is restricted to coder-b, a viewer with access to every agent.
# Cases:
#   A  stop, answer n            → nothing dispatched, still running, rc 1 ("Nothing was done")
#   B  stop, answer y            → coder-b's agent-node is gone, hub lifecycle stopped, "✓ … is stopped on machine-b"
#   C  start --yes               → it comes back up (process + hub), "✓ … is up on machine-b"
#   D  restart --yes             → a new agent-node pid, "✓ … restarted"
#   E  edit --model m2 --yes     → hub config shows m2, "✓ … now runs model m2"
#   F  machine without daemon    → "this machine can't be managed remotely: no daemon online on machine-c", rc 1
#   G  restricted member         → refused before dispatch, even with an admin token in COMMHUB_TOKEN
#   H  viewer                    → the hub's permission_denied surfaced, nothing changed
#   I  unknown alias / local-only flag / saved node token → refused (rc 1 / 2 / 1)
# M1–M4 are witnessed reds against mutated source; a mutation that does not apply is a failure (MUTATION_NOOP).
set -uo pipefail

if [[ ! -f /.dockerenv && "${ALLOW_NON_DOCKER:-}" != "1" ]]; then
  echo "REFUSING: /.dockerenv absent — this suite boots a hub and a daemon; run it in its container." >&2
  exit 2
fi
source /app/tests/lib/safe-rm.sh

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
mkdir -p "$ARTIFACT_DIR"
REPORT="$ARTIFACT_DIR/report-test562b-node-remote.txt"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test562b-node-remote — anet node … --remote"
sha=${TEST562B_SOURCE_COMMIT:-}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: exact SOURCE_COMMIT required (got '${sha:-unset}')"; exit 1; }
echo "source_commit=$sha"
echo "date=$(date -Is)"
HOSTB=$(hostname)
[[ "$HOSTB" == machine-b ]] || { echo "FAIL: run the container with --hostname machine-b (got '$HOSTB')"; exit 1; }

CLI=/app/agent-network/bin/cli.ts
free_port() { bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop(true)'; }
PORT=$(free_port)
[[ "$PORT" != 9200 ]] || { echo "FAIL: refusing port 9200"; exit 1; }
HUB="http://127.0.0.1:$PORT"
WORK=$(mktemp -d)
HUB_DB="$WORK/hub.db"
DAEMON_HOME="$WORK/daemon-home"; ADMIN_HOME="$WORK/admin"; MEMBER_HOME="$WORK/member"; VIEWER_HOME="$WORK/viewer"; NTOK_HOME="$WORK/ntok"
CLI_CWD="$WORK/elsewhere"
mkdir -p "$DAEMON_HOME/.anet" "$DAEMON_HOME/d" "$ADMIN_HOME" "$MEMBER_HOME" "$VIEWER_HOME" "$NTOK_HOME/.anet" "$CLI_CWD"
PW='t562b_Password_xyz_Q1'
CHILD=coder-b

cleanup() {
  local p
  for p in $(pgrep -f "agent-node.*--alias" 2>/dev/null); do kill "$p" 2>/dev/null; done
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

anet_as() { local h=$1; shift; (cd "$CLI_CWD" && HOME="$h" bun "$CLI" "$@"); }
api() { curl -sS -H "Authorization: Bearer $UTOK" "$HUB$1"; }
mcp_tool() { # token name args-json → inner JSON text
  local resp
  resp=$(curl -sS -X POST "$HUB/mcp" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "$(jq -cn --arg n "$2" --argjson a "$3" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')")
  printf '%s\n' "$resp" | sed -n 's/^data: //p' | tail -n 1 | jq -r '.result.content[0].text' 2>/dev/null || true
}
agent_pids() { pgrep -f "agent-node.*--alias $1( |\$)" 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }
lifecycle() { api "/api/nodes?network_id=$NET&node_id=$CHILD_ID" | jq -r '.nodes[0].lifecycle_state // "?"'; }
sess_status() { api "/api/status?network_id=$NET" | jq -r --arg a "$1" '[.sessions[]? | select(.alias==$a)][0].status // "?"'; }
cfg_model() { api "/api/nodes/$CHILD_ID/config" | jq -r '.model // "?"'; }
has() { printf '%s\n' "$2" | grep -Fq -- "$1"; }
show() { printf '%s\n' "$1" | sed 's/^/      /'; }

# Bring coder-b back to running through the hub directly (independent of the CLI under test).
ensure_running() {
  local i st started=""
  for i in $(seq 1 90); do
    st=$(lifecycle)
    # a stop still in flight (stopping) has to land before start_node accepts it
    if [[ "$st" == stopped && -z "$started" ]]; then
      mcp_tool "$UTOK" start_node "$(jq -cn --arg c "$CHILD_ID" --arg n "$NET" '{child_node_id:$c,network_id:$n}')" >/dev/null
      started=1
    fi
    if [[ "$st" == active && -n "$(agent_pids "$CHILD")" && "$(sess_status "$CHILD")" != offline ]]; then sleep 3; return 0; fi
    sleep 1
  done
  echo "FAIL: could not bring $CHILD back to running (lifecycle=$(lifecycle) pids='$(agent_pids "$CHILD")' status=$(sess_status "$CHILD"))"
  return 1
}

# ── setup (once) ───────────────────────────────────────────────────────
echo "== setup: hub :$PORT, daemon on $HOSTB, child $CHILD"
(cd /app/server && PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" COMMHUB_UPLOADS_DIR="$WORK/uploads" exec bun run src/index.ts) >"$WORK/hub.log" 2>&1 &
HUB_PID=$!
for _ in $(seq 1 100); do curl -fsS "$HUB/health" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fsS "$HUB/health" >/dev/null 2>&1 || { echo "FAIL: hub did not start"; tail -30 "$WORK/hub.log"; exit 1; }

REG=$(curl -sS -X POST "$HUB/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"t562badmin\",\"password\":\"$PW\",\"email\":\"t562b@test.local\"}")
UTOK=$(printf '%s' "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] || { echo "FAIL: admin register: $REG"; exit 1; }
NET=$(api /api/auth/me | jq -r '.networks[0].network_id')
[[ -n "$NET" && "$NET" != null ]] || { echo "FAIL: no network"; exit 1; }

# daemon: its own HOME, logged in as the admin, exactly as `anet daemon up` is used on a machine
printf '{"hub":"%s","token":"%s","network_id":"%s"}\n' "$HUB" "$UTOK" "$NET" > "$DAEMON_HOME/.anet/config.json"
export ANET_BIN_ABS=$(realpath -e "$(command -v anet)")
export ANET_DAEMON_ALLOW_ENV_BIN=1
(cd "$DAEMON_HOME/d" && HOME="$DAEMON_HOME" exec anet daemon up daemon-b) >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!
DAEMON_ID=""
for _ in $(seq 1 90); do
  DAEMON_ID=$(api "/api/host-supervisors?network_id=$NET" | jq -r '.daemons[]? | select(.alias=="daemon-b" and .online==true) | .daemon_node_id' 2>/dev/null)
  [[ -n "$DAEMON_ID" ]] && break; sleep 1
done
[[ -n "$DAEMON_ID" ]] || { echo "FAIL: daemon never came online"; tail -40 "$WORK/daemon.log"; exit 1; }
echo "  daemon-b online ($DAEMON_ID) on $(api "/api/host-supervisors?network_id=$NET" | jq -r '.daemons[0].hostname')"

R=$(mcp_tool "$UTOK" create_node "$(jq -cn --arg d "$DAEMON_ID" --arg n "$NET" --arg c "$CHILD" '{daemon_node_id:$d,network_id:$n,node_spec:{name:$c,runtime:"claude-agent-sdk",model:"m1"}}')")
REQ=$(printf '%s' "$R" | jq -r '.request_id // empty')
[[ "$REQ" == cr_* ]] || { echo "FAIL: create_node: $R"; exit 1; }
CHILD_ID="node_${REQ#cr_}"
for _ in $(seq 1 90); do
  [[ "$(sess_status "$CHILD")" =~ ^(idle|working)$ && -n "$(agent_pids "$CHILD")" ]] && grep -q "capability check OK" "$WORK/daemon.log" && break
  sleep 1
done
[[ -n "$(agent_pids "$CHILD")" && "$(sess_status "$CHILD")" != offline ]] || { echo "FAIL: $CHILD never came up"; tail -40 "$WORK/daemon.log"; exit 1; }
sleep 3
echo "  $CHILD up ($CHILD_ID) pids=$(agent_pids "$CHILD") lifecycle=$(lifecycle)"

# hand-c: a node reported from machine-c, which has no daemon
HT=$(curl -sS -X POST "$HUB/api/auth/node-token" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET\",\"node_name\":\"hand-c\",\"node_id\":\"n_t562b_handc\"}" | jq -r .token)
[[ "$HT" == ntok_* ]] || { echo "FAIL: hand-c node token"; exit 1; }
mcp_tool "$HT" report_status "$(jq -cn --arg n "$NET" '{resume_id:"resume_handc",alias:"hand-c",status:"idle",hostname:"machine-c",agent:"claude-agent-sdk",node_id:"n_t562b_handc",network_id:$n}')" >/dev/null

# member restricted to coder-b; viewer with every agent
MID=$(curl -sS -X POST "$HUB/api/admin/users" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"username\":\"t562bm\",\"password\":\"$PW\",\"network_id\":\"$NET\",\"role\":\"member\"}" | jq -r '.user.user_id // empty')
[[ -n "$MID" ]] || { echo "FAIL: member create"; exit 1; }
G=$(curl -sS -X PUT "$HUB/api/networks/$NET/members/$MID/agent-grants" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"grants\":[\"$CHILD_ID\"]}")
[[ "$(printf '%s' "$G" | jq -r .restricted)" == true ]] || { echo "FAIL: member not restricted: $G"; exit 1; }
VID=$(curl -sS -X POST "$HUB/api/admin/users" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"username\":\"t562bv\",\"password\":\"$PW\",\"network_id\":\"$NET\",\"role\":\"viewer\"}" | jq -r '.user.user_id // empty')
[[ -n "$VID" ]] || { echo "FAIL: viewer create"; exit 1; }
G=$(curl -sS -X PUT "$HUB/api/networks/$NET/members/$VID/agent-grants" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d '{"agent_access":"all"}')
[[ "$(printf '%s' "$G" | jq -r .restricted)" == false ]] || { echo "FAIL: viewer restricted: $G"; exit 1; }

for who in admin:t562badmin member:t562bm viewer:t562bv; do
  h="$WORK/${who%%:*}"
  (cd "$CLI_CWD" && HOME="$h" bun "$CLI" login --hub "$HUB" --username "${who#*:}" --password "$PW") >"$WORK/login-${who%%:*}.log" 2>&1 \
    || { cat "$WORK/login-${who%%:*}.log"; echo "FAIL: login ${who%%:*}"; exit 1; }
done
[[ "$(jq -r .token "$ADMIN_HOME/.anet/config.json")" == utok_* ]] || { echo "FAIL: admin CLI login state"; exit 1; }
printf '{"hub":"%s","token":"%s","network_id":"%s"}\n' "$HUB" "$HT" "$NET" > "$NTOK_HOME/.anet/config.json"
[[ ! -d "$ADMIN_HOME/.anet/nodes" && ! -d "$CLI_CWD/.anet" ]] || { echo "FAIL: the CLI side has local nodes; the test would not be remote"; exit 1; }

# ── cases ──────────────────────────────────────────────────────────────
case_A() {
  echo "  [A] stop, answer n"
  ensure_running || return 1
  local before rc=0 out
  before=$(agent_pids "$CHILD")
  out=$(printf 'n\n' | anet_as "$ADMIN_HOME" node stop "$CHILD" --remote 2>&1) || rc=$?
  show "$out"
  [[ $rc -eq 1 ]] || { echo "FAIL: A rc=$rc (want 1)"; return 1; }
  has "Node $CHILD — on machine-b, daemon daemon-b online" "$out" || { echo "FAIL: A where-line"; return 1; }
  has "Will run 将执行:" "$out" && has "anet node stop $CHILD --remote --network $NET --yes" "$out" || { echo "FAIL: A plan/equivalent command"; return 1; }
  has "Aborted" "$out" && has "Nothing was done" "$out" || { echo "FAIL: A abort message"; return 1; }
  sleep 2
  [[ "$(lifecycle)" == active && "$(agent_pids "$CHILD")" == "$before" ]] || { echo "FAIL: A something was dispatched (lifecycle=$(lifecycle) pids='$(agent_pids "$CHILD")')"; return 1; }
  echo "  PASS A"
}
case_B() {
  echo "  [B] stop, answer y"
  ensure_running || return 1
  local rc=0 out
  out=$(printf 'y\n' | anet_as "$ADMIN_HOME" node stop "$CHILD" --remote --wait 60 2>&1) || rc=$?
  show "$out"
  [[ $rc -eq 0 ]] || { echo "FAIL: B rc=$rc"; return 1; }
  has "✓ \"$CHILD\" is stopped on machine-b" "$out" || { echo "FAIL: B outcome line"; return 1; }
  [[ -z "$(agent_pids "$CHILD")" ]] || { echo "FAIL: B agent-node still running after the CLI reported stopped (pids=$(agent_pids "$CHILD"))"; return 1; }
  [[ "$(lifecycle)" == stopped ]] || { echo "FAIL: B hub lifecycle=$(lifecycle)"; return 1; }
  echo "  PASS B"
}
case_C() {
  echo "  [C] start --yes"
  [[ "$(lifecycle)" == stopped ]] || { echo "FAIL: C precondition: $CHILD is not stopped ($(lifecycle))"; return 1; }
  local rc=0 out
  out=$(anet_as "$ADMIN_HOME" node start "$CHILD" --remote --yes 2>&1) || rc=$?
  show "$out"
  [[ $rc -eq 0 ]] || { echo "FAIL: C rc=$rc"; return 1; }
  has "✓ \"$CHILD\" is up on machine-b" "$out" || { echo "FAIL: C outcome line"; return 1; }
  [[ -n "$(agent_pids "$CHILD")" && "$(lifecycle)" == active ]] || { echo "FAIL: C not up (pids='$(agent_pids "$CHILD")' lifecycle=$(lifecycle))"; return 1; }
  echo "  PASS C"
}
case_D() {
  echo "  [D] restart --yes"
  ensure_running || return 1
  local before rc=0 out after
  before=$(agent_pids "$CHILD")
  out=$(anet_as "$ADMIN_HOME" node restart "$CHILD" --remote --yes --wait 90 2>&1) || rc=$?
  show "$out"
  [[ $rc -eq 0 ]] || { echo "FAIL: D rc=$rc"; return 1; }
  has "✓ \"$CHILD\" restarted on machine-b" "$out" || { echo "FAIL: D outcome line"; return 1; }
  after=$(agent_pids "$CHILD")
  [[ -n "$after" && "$after" != "$before" ]] || { echo "FAIL: D agent-node pid did not change ('$before' → '$after')"; return 1; }
  echo "  PASS D (pid $before → $after)"
}
case_E() {
  echo "  [E] edit --model m2 --yes"
  ensure_running || return 1
  local rc=0 out
  out=$(anet_as "$ADMIN_HOME" node edit "$CHILD" --model m2 --remote --yes --wait 90 2>&1) || rc=$?
  show "$out"
  [[ $rc -eq 0 ]] || { echo "FAIL: E rc=$rc"; return 1; }
  has "✓ \"$CHILD\" on machine-b now runs model m2" "$out" || { echo "FAIL: E outcome line"; return 1; }
  [[ "$(cfg_model)" == m2 ]] || { echo "FAIL: E hub config model=$(cfg_model)"; return 1; }
  echo "  PASS E"
}
case_F() {
  echo "  [F] machine without a daemon"
  local rc=0 out
  out=$(anet_as "$ADMIN_HOME" node start hand-c --remote --yes 2>&1) || rc=$?
  show "$out"
  [[ $rc -eq 1 ]] || { echo "FAIL: F rc=$rc (want 1)"; return 1; }
  has "this machine can't be managed remotely: no daemon online on machine-c" "$out" || { echo "FAIL: F refusal text"; return 1; }
  has "Dispatched" "$out" && { echo "FAIL: F dispatched anyway"; return 1; }
  echo "  PASS F"
}
case_G() {
  echo "  [G] restricted member (granted $CHILD), admin token in COMMHUB_TOKEN"
  ensure_running || return 1
  local rc=0 out
  out=$(cd "$CLI_CWD" && COMMHUB_TOKEN="$UTOK" HOME="$MEMBER_HOME" bun "$CLI" node stop "$CHILD" --remote --yes --network "$NET" 2>&1) || rc=$?
  show "$out"
  [[ $rc -eq 1 ]] || { echo "FAIL: G rc=$rc (want 1)"; return 1; }
  has "restricted" "$out" || { echo "FAIL: G refusal does not say why"; return 1; }
  has "Dispatched" "$out" && { echo "FAIL: G dispatched"; return 1; }
  sleep 2
  [[ "$(lifecycle)" == active && -n "$(agent_pids "$CHILD")" ]] || { echo "FAIL: G $CHILD was touched (lifecycle=$(lifecycle))"; return 1; }
  echo "  PASS G"
}
case_H() {
  echo "  [H] viewer"
  ensure_running || return 1
  local rc=0 out
  out=$(anet_as "$VIEWER_HOME" node stop "$CHILD" --remote --yes --network "$NET" 2>&1) || rc=$?
  show "$out"
  [[ $rc -eq 1 ]] || { echo "FAIL: H rc=$rc (want 1)"; return 1; }
  has "the hub refused to stop \"$CHILD\": permission_denied" "$out" || { echo "FAIL: H the hub's error is not surfaced"; return 1; }
  sleep 2
  [[ "$(lifecycle)" == active && -n "$(agent_pids "$CHILD")" ]] || { echo "FAIL: H $CHILD was touched"; return 1; }
  echo "  PASS H"
}
case_I() {
  echo "  [I] unknown alias / local-only flag / saved node token"
  local rc=0 out
  out=$(anet_as "$ADMIN_HOME" node stop ghost --remote --yes 2>&1) || rc=$?
  [[ $rc -eq 1 ]] && has 'no node "ghost"' "$out" || { show "$out"; echo "FAIL: I unknown alias rc=$rc"; return 1; }
  rc=0; out=$(anet_as "$ADMIN_HOME" node start "$CHILD" --remote --tmux 2>&1) || rc=$?
  [[ $rc -eq 2 ]] && has "--tmux is not supported with --remote" "$out" || { show "$out"; echo "FAIL: I --tmux rc=$rc"; return 1; }
  rc=0; out=$(anet_as "$NTOK_HOME" node stop "$CHILD" --remote --yes 2>&1) || rc=$?
  [[ $rc -eq 1 ]] && has "node token" "$out" || { show "$out"; echo "FAIL: I saved node token rc=$rc"; return 1; }
  echo "  PASS I"
}

run_all() { case_A && case_B && case_C && case_D && case_E && case_F && case_G && case_H && case_I; }

echo "L0 green: real CLI x real hub x real daemon"
run_all || { echo "FAIL: L0 not green"; echo "── daemon log (tail)"; tail -60 "$WORK/daemon.log"; exit 1; }

# ── witnessed reds ─────────────────────────────────────────────────────
# Each mutation is a literal `sed -i` (checked by scripts/check-mutation-pins.py); check_red runs the
# cases it must turn red against the mutated source, then restores the file and the node's state.
check_red() { # label file backup case...
  local label=$1 file=$2 backup=$3; shift 3
  if cmp -s "$file" "$backup"; then echo "MUTATION_NOOP: $label (anchor not found in $file)"; exit 1; fi
  local rc=0 c
  for c in "$@"; do "$c" > "$WORK/mut-$label.log" 2>&1 || { rc=1; break; }; done
  cp "$backup" "$file"
  if [[ $rc -eq 0 ]]; then echo "MUTATION_FALSE_GREEN: $label"; cat "$WORK/mut-$label.log"; exit 1; fi
  echo "MUTATION_RED: $label ($(grep -m1 '^FAIL' "$WORK/mut-$label.log" || echo 'no FAIL line'))"
  ensure_running >/dev/null || { echo "FAIL: could not restore state after $label"; exit 1; }
}
cd /app/agent-network
cp bin/cli.ts "$WORK/cli.ts.orig"
cp src/node-remote.ts "$WORK/node-remote.ts.orig"

echo "M1 witnessed-red: no online-daemon check on the node's machine"
sed -i 's|  if (!onHost.some((d) => d.online === true)) {|  if (false) {|' src/node-remote.ts
check_red no-daemon-check src/node-remote.ts "$WORK/node-remote.ts.orig" case_F

echo "M2 witnessed-red: dispatch without confirmation"
sed -i 's|  if (flags.yes) {|  if (true) {|' bin/cli.ts
check_red no-confirm bin/cli.ts "$WORK/cli.ts.orig" case_A

echo "M3 witnessed-red: token from getToken() (COMMHUB_TOKEN wins over the login)"
sed -i 's|  const token = String(gc.token \|\| "");|  const token = getToken();|' bin/cli.ts
check_red env-token bin/cli.ts "$WORK/cli.ts.orig" case_G

echo "M4 witnessed-red: report success without waiting for the hub"
sed -i 's|    if (flags.waitSeconds === 0) {|    if (true) {|' bin/cli.ts
check_red no-wait bin/cli.ts "$WORK/cli.ts.orig" case_B

echo "L1 restored green (B C F)"
{ case_B && case_C && case_F; } || { echo "FAIL: restore not green"; exit 1; }

echo "RESULT: PASS"

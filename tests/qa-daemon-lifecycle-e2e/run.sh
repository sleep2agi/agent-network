#!/usr/bin/env bash
# Daemon full-chain lifecycle e2e — `anet daemon up` → create_node →
# child registers → update_node_config → restart_node → stop_node.
#
# WHY THIS SUITE EXISTS (gap analysis against what already ships):
#   qa-rfc026-create-node   covers create_node + child register
#   qa-rfc027-stop-delete   covers stop_node / restart_node / delete_node
#   qa-rfc024-config-apply  covers update_node_config's CONTRACT surface
#                           only — its live stage self-documents the hole:
#                           "A real 'next think uses new value' check needs
#                            a vendor key + a live agent-node consuming the
#                            SSE doorbell. That belongs in the longer-form
#                            QA." and it takes the `skip` branch because no
#                            agent-node is running (node_not_found).
#
# So the uncovered square is NOT any single tool — it is the STATE HANDOFF
# BETWEEN them on one daemon-created child within one daemon lifetime:
#   · does update_node_config actually rewrite the CHILD's on-disk config?
#   · does that survive restart_node?
#   · does stop_node really reap the process the earlier steps configured?
#
# JUDGEMENT RULES (通信龙 2026-08-27):
#   · assert hub-side TERMINAL state + the child's REAL on-disk config
#   · a startup banner is NOT readiness — never assert on stdout text
#   · witnessed-red first: every load-bearing assertion is proven to go
#     RED at a moment when it must be red, BEFORE it is trusted green
#
# start_node is deliberately a TODO — the tool is not in main yet (#1273
# under independent review). Chain stops at stop_node.

set -uo pipefail

# This suite boots a hub, forks real node processes and kills pids. It is
# written for its own container and must REFUSE to run on a developer or
# production host, where those actions are not safe.
if [[ ! -f /.dockerenv && "${ALLOW_NON_DOCKER:-}" != "1" ]]; then
  echo "REFUSING: /.dockerenv absent — this suite boots a hub and kills pids; run it in its container." >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# ── provenance ────────────────────────────────────────────────────────
# Bind this run to the commit its report will claim. Format alone is not
# enough: any 40 hex chars pass, and that SHA might not even contain the
# file inside the image. So we also recompute the git blob hash of THIS
# file — sha1("blob <len>\0" + bytes) — and compare. No git needed here.
# Same shape as test798/test823; qa.sh supplies both build-args.
SOURCE_COMMIT=${DLIFE_SOURCE_COMMIT:-}
RUNSH_BLOB=${DLIFE_RUNSH_BLOB:-}
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FAIL: DLIFE_SOURCE_COMMIT must be one full lowercase Git SHA (got '${SOURCE_COMMIT:-unset}')" >&2
  echo "      build with: --build-arg SOURCE_COMMIT=\$(git rev-parse HEAD) --build-arg RUNSH_BLOB=\$(git rev-parse HEAD:tests/qa-daemon-lifecycle-e2e/run.sh)" >&2
  exit 1
fi
if [[ ! "$RUNSH_BLOB" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FAIL: DLIFE_RUNSH_BLOB missing/malformed — cannot bind SOURCE_COMMIT to the bytes under test" >&2
  exit 1
fi
_self="$SCRIPT_DIR/run.sh"
_actual=$( { printf 'blob %d\0' "$(wc -c < "$_self")"; cat "$_self"; } | sha1sum | cut -d' ' -f1 )
if [[ "$_actual" != "$RUNSH_BLOB" ]]; then
  echo "FAIL: run.sh in the image is not the one SOURCE_COMMIT=$SOURCE_COMMIT claims" >&2
  echo "      expected blob $RUNSH_BLOB, actual $_actual" >&2
  exit 1
fi
echo "provenance: source_commit=$SOURCE_COMMIT run.sh blob=$_actual (verified)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/safe-rm.sh"

HUB_PORT=9251
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=/tmp/qa-daemon-lifecycle.db
ADMIN_USER="dlifeadmin"
ADMIN_PW="dlife_TestPass_1234!"
DAEMON_NAME="dlife-daemon"
CHILD="dlife-child-a"
WORK=/tmp/qa-daemon-lifecycle-work

PASS=0; FAIL=0; SKIP=0; RED=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
todo() { printf "  ⊘ %s — TODO: %s\n" "$1" "$2"; SKIP=$((SKIP+1)); }

# witnessed-red: run an assertion AT A MOMENT WHEN IT MUST FAIL.
# If it passes there, the assertion has no discriminating power and every
# later green reading from it is worthless — that is a FAIL, not a pass.
expect_red() {
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then
    bad "RED-GATE  $what — assertion passed when it MUST have failed (no discriminating power)"
  else
    printf "  ✓ RED-GATE %s — correctly red before the action\n" "$what"; PASS=$((PASS+1)); RED=$((RED+1))
  fi
}

mcp_init_once() {
  curl -sS -X POST "$HUB_BASE/mcp" -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"qa-dlife","version":"0"}}}' >/dev/null 2>&1 || true
}
mcp_call() {
  local tok="$1" body="$2" resp inner
  resp=$(curl -sS -X POST "$HUB_BASE/mcp" -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' -d "$body")
  inner=$(echo "$resp" | grep -oP '(?<=data: ).+' | head -1 | jq -r '.result.content[0].text' 2>/dev/null)
  if [[ -z "$inner" || "$inner" == "null" ]]; then
    inner=$(echo "$resp" | jq -r '.result.content[0].text' 2>/dev/null)
  fi
  [[ -z "$inner" || "$inner" == "null" ]] && echo "$resp" || echo "$inner"
}

CHILD_CFG=""      # set after create; the file every config assertion reads

# ---- the load-bearing predicates, defined ONCE so the red gate and the
# ---- green assertion are provably the SAME criterion (not two lookalikes).
child_cfg_exists()      { [[ -f "$CHILD_CFG" ]]; }
child_flag_equals()     { [[ "$(jq -r ".flags.${1} // empty" "$CHILD_CFG" 2>/dev/null)" == "$2" ]]; }
child_model_equals()    { [[ "$(jq -r '.model // empty' "$CHILD_CFG" 2>/dev/null)" == "$1" ]]; }
hub_lifecycle_is()      { [[ "$(curl -sS "$HUB_BASE/api/nodes?node_id=$CHILD_NODE_ID" -H "Authorization: Bearer $UTOK" | jq -r '.nodes[0].lifecycle_state // empty')" == "$1" ]]; }
# The long-lived process is the GRANDCHILD `agent-node --alias <name>`,
# NOT the `anet node start <name>` launcher that spawns it (create-node-
# daemon.ts:420 spawns the launcher; the launcher then execs the node).
# The launcher can be gone while the node is very much alive, so asserting
# on it would measure the wrong object. This is the same pattern
# qa-rfc027 uses for its proven reap assertions — do not "simplify" it.
child_pids()            { pgrep -af "agent-node.*--alias $CHILD" 2>/dev/null | grep -v grep | awk '{print $1}'; }
child_proc_count()      { child_pids | wc -l; }
child_proc_alive()      { [[ "$(child_proc_count)" -ge 1 ]]; }

# NOTE: this suite contains NO `pkill -f` / `killall` anywhere (network
# rule — a subagent's pattern kill took down a live hub once). We resolve
# concrete pids with pgrep, re-read /proc/<pid>/cmdline to confirm the pid
# is really ours, and only then kill that exact pid.
kill_child_procs() {
  local p
  for p in $(child_pids); do
    if tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- "--alias $CHILD"; then
      kill "$p" 2>/dev/null
    fi
  done
}
cleanup() {
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null
  kill_child_procs
  return 0
}
trap cleanup EXIT

# ── 0. hub ────────────────────────────────────────────────────────────
note "0. boot isolated hub :$HUB_PORT (local server source, test DB)"
safe_rm_rf "$WORK" 2>/dev/null || true
rm -f "$HUB_DB" "${HUB_DB}-wal" "${HUB_DB}-shm" 2>/dev/null
mkdir -p "$WORK"
cd /app/server
PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" bun run src/index.ts >/tmp/hub-dlife.log 2>&1 &
HUB_PID=$!
for i in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && ok "hub /health 200" || { bad "hub did not start"; tail -30 /tmp/hub-dlife.log; exit 1; }

REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"email\":\"dlife@test.local\"}")
UTOK=$(echo "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint failed: $REG"; exit 1; }
mcp_init_once "$UTOK"
NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r '.networks[0].network_id')
[[ -n "$NET_ID" && "$NET_ID" != null ]] && ok "network = $NET_ID" || { bad "no network"; exit 1; }

# ── 0.A `anet daemon up` — the real user entrypoint ───────────────────
# qa-rfc027 hand-writes the daemon config.json; qa-anet-daemon-cmd drives
# init+start separately. Neither exercises the ONE-SHOT `up` path, which
# is what a first-time user actually types.
note "0.A anet daemon up — one-shot init+start (NOT hand-written config)"
export HOME="$WORK"
mkdir -p "$HOME/.anet"
cat > "$HOME/.anet/config.json" <<EOF
{"hub":"$HUB_BASE","token":"$UTOK","network_id":"$NET_ID"}
EOF
cd "$WORK"
export ANET_BIN_ABS=$(realpath -e "$(which anet)")
# 本套件绕过 `anet daemon`(用 `anet node start`),CLI 的自动声明到不了这里 —— 见 #1299
export ANET_DAEMON_ALLOW_ENV_BIN=1
nohup anet daemon up "$DAEMON_NAME" >/tmp/daemon-dlife.log 2>&1 &
DAEMON_PID=$!

# readiness = hub says the node is there with role=host_supervisor.
# The startup banner is explicitly NOT consulted (banner != readiness).
DAEMON_NODE_ID=""
for i in $(seq 1 45); do
  sleep 1
  R=$(curl -sS "$HUB_BASE/api/nodes" -H "Authorization: Bearer $UTOK")
  DAEMON_NODE_ID=$(echo "$R" | jq -r --arg n "$DAEMON_NAME" '.nodes[]? | select(.node_name==$n or .alias==$n) | .node_id' | head -1)
  [[ -n "$DAEMON_NODE_ID" && "$DAEMON_NODE_ID" != null ]] && break
done
if [[ -n "$DAEMON_NODE_ID" && "$DAEMON_NODE_ID" != null ]]; then
  ok "daemon registered via \`anet daemon up\` (node_id=$DAEMON_NODE_ID)"
else
  bad "daemon never appeared in hub /api/nodes"; tail -40 /tmp/daemon-dlife.log; exit 1
fi
# The hub does NOT expose the role as `nodes[0].role`. It lands inside
# `config_snapshot`, which the daemon reports AFTER registering — so this
# is a genuine race, not a formality: `list_host_supervisors` filters on
# `config_snapshot.role`, and qa-rfc026 documents the same race. Dispatch
# create_node before it converges and the daemon is not yet a supervisor.
DROLE=""
for i in $(seq 1 45); do
  DROLE=$(curl -sS "$HUB_BASE/api/nodes?node_id=$DAEMON_NODE_ID" -H "Authorization: Bearer $UTOK" \
    | jq -r '.nodes[0].config_snapshot.role // .nodes[0].role // empty')
  [[ "$DROLE" == "host_supervisor" ]] && break
  sleep 1
done
if [[ "$DROLE" == "host_supervisor" ]]; then
  ok "hub-side config_snapshot.role=host_supervisor (converged)"
else
  bad "config_snapshot.role never became host_supervisor (last='$DROLE')"
  echo "  ── /api/nodes raw ──"
  curl -sS "$HUB_BASE/api/nodes?node_id=$DAEMON_NODE_ID" -H "Authorization: Bearer $UTOK" | jq -c '.nodes[0] | {node_id,node_name,alias,role,config_snapshot}' 2>/dev/null | head -5
fi

# ── A. create_node ────────────────────────────────────────────────────
note "A. create_node → child config on disk + child registers"
CHILD_CFG="$WORK/.anet/nodes/$CHILD/config.json"

# RED GATE 1 — the exact predicate used later must be red RIGHT NOW.
expect_red "child config.json absent before create_node" child_cfg_exists

CREATE_BODY=$(cat <<JSON
{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"create_node","arguments":{
 "daemon_node_id":"$DAEMON_NODE_ID","network_id":"$NET_ID",
 "node_spec":{"name":"$CHILD","runtime":"claude-agent-sdk","model":"claude-opus-original","flags":{"maxTurns":7}}}}}
JSON
)
CREATE_RESP=$(mcp_call "$UTOK" "$CREATE_BODY")
REQ_ID=$(echo "$CREATE_RESP" | jq -r '.request_id // empty')
[[ -n "$REQ_ID" ]] && ok "create_node dispatched (request_id=$REQ_ID)" || { bad "create_node failed: $CREATE_RESP"; exit 1; }

# child node_id is derived from request_id by the daemon:
#   node_id = "node_" + request_id.replace(/^cr_/, "")   (create-node-daemon.ts)
CHILD_NODE_ID="node_${REQ_ID#cr_}"

for i in $(seq 1 60); do sleep 1; child_cfg_exists && break; done
if child_cfg_exists; then
  ok "child config.json written: .anet/nodes/$CHILD/config.json"
else
  bad "child config.json never written"
  echo "  ── daemon log (last 40) ──"; tail -40 /tmp/daemon-dlife.log
  echo "  ── what landed under .anet/nodes ──"; ls -la "$WORK/.anet/nodes/" 2>/dev/null
  echo "  ── hub view of the create request ──"
  curl -sS "$HUB_BASE/api/nodes" -H "Authorization: Bearer $UTOK" | jq -c '[.nodes[]? | {node_name,alias,lifecycle_state}]' 2>/dev/null
  exit 1
fi

# baseline: the value we will later change, read from the REAL file
child_flag_equals maxTurns 7 && ok "child on-disk flags.maxTurns=7 (as created)" \
  || bad "unexpected initial maxTurns: $(jq -c '.flags' "$CHILD_CFG" 2>/dev/null)"

REGISTERED=""
for i in $(seq 1 60); do
  sleep 1
  curl -sS "$HUB_BASE/api/nodes?node_id=$CHILD_NODE_ID" -H "Authorization: Bearer $UTOK" \
    | jq -e --arg id "$CHILD_NODE_ID" '.nodes[0].node_id == $id' >/dev/null 2>&1 && { REGISTERED=yes; break; }
done
[[ -n "$REGISTERED" ]] && ok "child registered with hub (node_id=$CHILD_NODE_ID)" \
  || bad "child never registered — later hub-side assertions will be vacuous"

# ── B. update_node_config — THE UNCOVERED SQUARE ──────────────────────
note "B. update_node_config → does the CHILD's real on-disk config change?"

# RED GATE 2 — assert the POST-update value BEFORE updating. Must be red.
# This is what proves the assertion reads the file and can tell 7 from 99;
# without it, a green after the update could just be a tautology.
expect_red "child flags.maxTurns=99 before update_node_config" child_flag_equals maxTurns 99

UPD_BODY=$(cat <<JSON
{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"update_node_config","arguments":{
 "node_id":"$CHILD_NODE_ID","network_id":"$NET_ID","base_revision":0,
 "patch":{"flags":{"maxTurns":99}}}}}
JSON
)
UPD_RESP=$(mcp_call "$UTOK" "$UPD_BODY")
UPD_MODE=$(echo "$UPD_RESP" | jq -r '.apply_mode // empty')
UPD_ID=$(echo "$UPD_RESP" | jq -r '.update_id // empty')
UPD_ERR=$(echo "$UPD_RESP" | jq -r '.error // empty')
if [[ -n "$UPD_ID" ]]; then
  ok "hub accepted patch (apply_mode=$UPD_MODE update_id=$UPD_ID)"
else
  bad "update_node_config rejected: ${UPD_ERR:-$UPD_RESP}"
fi

# hub accepting the patch is NOT the deliverable. The deliverable is the
# child's file changing. Poll the file, then report honestly either way.
APPLIED=""
for i in $(seq 1 45); do sleep 1; child_flag_equals maxTurns 99 && { APPLIED=yes; break; }; done
if [[ -n "$APPLIED" ]]; then
  ok "CHILD on-disk flags.maxTurns 7 → 99 (config actually applied)"
else
  bad "hub returned update_id but CHILD file still shows maxTurns=$(jq -r '.flags.maxTurns // "?"' "$CHILD_CFG" 2>/dev/null) after 45s"
fi
CFG_REV=$(jq -r '.config_revision // empty' "$CHILD_CFG" 2>/dev/null)
[[ -n "$CFG_REV" && "$CFG_REV" != "0" ]] && ok "child config_revision advanced to $CFG_REV" \
  || printf "  · note: config_revision=%s (informational — not all apply modes stamp it)\n" "${CFG_REV:-unset}"

# ── C. restart_node ───────────────────────────────────────────────────
note "C. restart_node → process really restarts AND config survives"
PID_BEFORE=$(child_pids | head -1)
printf "  · agent-node --alias %s process count = %s\n" "$CHILD" "$(child_proc_count)"
[[ -n "$PID_BEFORE" ]] && ok "child process alive before restart (pid=$PID_BEFORE)" \
  || bad "no child process found — restart assertions would be vacuous"

RST_BODY=$(cat <<JSON
{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"restart_node","arguments":{
 "node_id":"$CHILD_NODE_ID","network_id":"$NET_ID"}}}
JSON
)
RST_RESP=$(mcp_call "$UTOK" "$RST_BODY")
echo "$RST_RESP" | jq -e '.ok == true or (.request_id|length>0)' >/dev/null 2>&1 \
  && ok "restart_node dispatched" || bad "restart_node failed: $RST_RESP"

PID_AFTER=""
for i in $(seq 1 60); do
  sleep 1
  P=$(child_pids | head -1)
  [[ -n "$P" && "$P" != "$PID_BEFORE" ]] && { PID_AFTER="$P"; break; }
done
[[ -n "$PID_AFTER" ]] && ok "process really restarted (pid $PID_BEFORE → $PID_AFTER)" \
  || bad "pid never changed within 60s (still ${PID_BEFORE:-none}) — restart not observed at process level"

# the point of the whole chain: the value set in stage B must survive C
child_flag_equals maxTurns 99 && ok "config SURVIVED restart (maxTurns still 99)" \
  || bad "config lost across restart: maxTurns=$(jq -r '.flags.maxTurns // "?"' "$CHILD_CFG" 2>/dev/null)"

# ── D. stop_node ──────────────────────────────────────────────────────
note "D. stop_node → hub terminal state + process really reaped"

# RED GATE 3 — the terminal state must not already read 'stopped'.
printf "  · pre-stop hub lifecycle_state = %s (the value red-gate 3 judges)\n" \
  "$(curl -sS "$HUB_BASE/api/nodes?node_id=$CHILD_NODE_ID" -H "Authorization: Bearer $UTOK" | jq -r '.nodes[0].lifecycle_state // "<node absent>"')"
expect_red "hub lifecycle_state=stopped before stop_node" hub_lifecycle_is stopped

# NOTE: stop_node takes `child_node_id`, while restart_node above takes
# `node_id` for the same object. Not a typo here — the two tools really do
# name the same argument differently (tools.ts: stop_node child_node_id
# vs restart_node node_id). Getting it wrong costs a -32602, not a
# silently wrong result, so this is annoying rather than dangerous.
STOP_BODY=$(cat <<JSON
{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"stop_node","arguments":{
 "child_node_id":"$CHILD_NODE_ID","network_id":"$NET_ID","force":true}}}
JSON
)
STOP_RESP=$(mcp_call "$UTOK" "$STOP_BODY")
echo "$STOP_RESP" | jq -e '.ok == true or (.request_id|length>0)' >/dev/null 2>&1 \
  && ok "stop_node dispatched" || bad "stop_node failed: $STOP_RESP"

STOPPED=""
for i in $(seq 1 60); do sleep 1; hub_lifecycle_is stopped && { STOPPED=yes; break; }; done
[[ -n "$STOPPED" ]] && ok "hub-side TERMINAL state lifecycle_state=stopped" \
  || bad "hub lifecycle_state=$(curl -sS "$HUB_BASE/api/nodes?node_id=$CHILD_NODE_ID" -H "Authorization: Bearer $UTOK" | jq -r '.nodes[0].lifecycle_state // "?"') after 60s"

REAPED=""
for i in $(seq 1 45); do sleep 1; child_proc_alive || { REAPED=yes; break; }; done
[[ -n "$REAPED" ]] && ok "child process really reaped (pgrep finds nothing)" \
  || bad "process still alive after stop_node — hub state and reality disagree"

# the daemon itself must SURVIVE stopping one of its children
kill -0 "$DAEMON_PID" 2>/dev/null && ok "daemon survived the child stop" \
  || bad "daemon died along with its child"

# ── E. start_node — TODO ──────────────────────────────────────────────
note "E. start_node"
todo "start_node re-start after stop" "tool not in main yet (#1273 under independent review); add a stage here once merged"

# ── result ────────────────────────────────────────────────────────────
note "Result"
echo "  PASS=$PASS  FAIL=$FAIL  TODO=$SKIP   (red gates witnessed: $RED)"
if [[ "$RED" -lt 3 ]]; then
  echo "  ✗ fewer than 3 red gates witnessed — the suite cannot vouch for its own greens"
  FAIL=$((FAIL+1))
fi
[[ "$FAIL" -eq 0 ]] && { echo "RESULT: PASS"; exit 0; } || { echo "RESULT: FAIL ($FAIL)"; exit 1; }

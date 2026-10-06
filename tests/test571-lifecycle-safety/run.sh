#!/usr/bin/env bash
# #571 — lifecycle safety, on real processes in one container.
#
#   S1  daemon-created child `dup571` + an unrelated agent-node with the SAME alias in
#       another workdir and HOME. stop_node(child) must reap the child and leave the
#       other one alive. (Before: the daemon's post-pgid residual sweep SIGTERMed every
#       `agent-node --alias dup571` on the machine.)
#   S2  no creation/binding authority: Hub refuses even an explicit daemon.
#       Then seed Hub creation authority only (no daemon local record): the daemon
#       must independently refuse (stop_failed / not_my_child) and signal nothing.
#       (Before: map miss → machine-wide pgrep-by-alias SIGTERM + ack stopped.)
#   S3  hand-started node (`n_…` id) + explicit same-network daemon_node_id → hub refuses
#       with not_daemon_managed, writes no stop request, the process lives.
#   S4  `anet project up` with a node running outside tmux (live .pid) → "already running",
#       pidfile untouched, no second copy; a dead pid's .pid is still cleared.
#   S5  (#579) daemon restart while its own child is dead and a same-alias agent-node
#       runs in another workdir/HOME. Boot rebuild must not adopt that process (its
#       --config is not the one the daemon wrote), so the following stop_node acks
#       stopped without signalling it. (Before: rebuild matched by --alias alone,
#       recorded the foreign pid as the child, and stop SIGTERMed its process group.)
#
# Never touches anything outside the container: own hub port + DB, HOME per actor,
# tmux only through ANET_TMUX_SOCKET (a private -S socket); no kill-server.

set -uo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/safe-rm.sh"

echo "[test571] source commit: ${T571_SOURCE_COMMIT:-unknown}"

HUB_PORT=9271
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=/tmp/t571-hub.db
ROOT=/tmp/t571
DAEMON_WD="$ROOT/daemon"
DAEMON_NAME="daemon-t571"
CHILD="dup571"
TMUX_SOCK="$ROOT/tmux/t571.sock"

PASS=0; FAIL=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
alive() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }

FAKE_PIDS=()
HUB_PID=""; DAEMON_PID=""
cleanup() {
  for p in "${FAKE_PIDS[@]}" "$DAEMON_PID" "$HUB_PID"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  # private socket only; kill the sessions this suite may have created, never the server
  for s in live571 stale571; do ANET_TMUX_SOCKET="$TMUX_SOCK" tmux -S "$TMUX_SOCK" kill-session -t "=$s" 2>/dev/null; done
  return 0
}
trap cleanup EXIT

mcp_init_once() {
  curl -sS -X POST "$HUB_BASE/mcp" -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t571","version":"0"}}}' >/dev/null 2>&1 || true
}
# tool <token> <name> <json-args> → inner result text
tool() {
  local resp inner
  resp=$(curl -sS -X POST "$HUB_BASE/mcp" -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$RANDOM,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}")
  inner=$(printf '%s\n' "$resp" | sed -n 's/^data: //p' | jq -r '.result.content[0].text' 2>/dev/null | sed -n 1p)
  if [[ -z "$inner" || "$inner" == "null" ]]; then inner=$(printf '%s' "$resp" | jq -r '.result.content[0].text' 2>/dev/null); fi
  if [[ -z "$inner" || "$inner" == "null" ]]; then printf '%s' "$resp"; else printf '%s' "$inner"; fi
}
wait_stop_request_done() {
  local req="$1" deadline=$(( $(date +%s) + ${2:-40} )) st=""
  while [[ $(date +%s) -lt $deadline ]]; do
    st=$(sqlite3 "$HUB_DB" "SELECT status FROM node_stop_requests WHERE request_id='$req';" 2>/dev/null)
    case "$st" in stopped|stop_failed|noop_not_my_child) echo "$st"; return 0;; esac
    sleep 0.5
  done
  echo "$st"; return 1
}
# A process that looks exactly like an agent-node to every matcher in the product
# (argv has `…/agent-node`, `--config <path>`, `--alias <alias>`), run under its own
# HOME and cwd, in its own session. Prints its pid.
start_foreign_agent_node() {
  local home="$1" alias="$2" id="$3"
  mkdir -p "$home/bin" "$home/.anet/nodes/$id"
  printf '#!/bin/bash\nwhile :; do sleep 1; done\n' > "$home/bin/agent-node"
  chmod +x "$home/bin/agent-node"
  # cd on its own line: `cd && cmd &` would background the whole and-list in a subshell
  # that keeps this command substitution's stdout open forever.
  ( cd "$home" || exit 1
    HOME="$home" setsid "$home/bin/agent-node" \
      --config "$home/.anet/nodes/$id/config.json" --alias "$alias" --runtime claude-agent-sdk \
      </dev/null >/dev/null 2>&1 &
    echo $! )
}
insert_node_row() {  # node_id alias
  sqlite3 "$HUB_DB" "INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
    VALUES ('$1', '$2', '$2', '$NET_ID', '{\"role\":\"member\"}', 'elsewhere', datetime('now'), datetime('now'), 'active');"
}

# ── 0. hub + admin ────────────────────────────────────────────────
note "0. boot throwaway hub :$HUB_PORT"
safe_rm_rf "$ROOT" 2>/dev/null || true
rm -f "$HUB_DB" "${HUB_DB}-shm" "${HUB_DB}-wal"
mkdir -p "$DAEMON_WD" "$(dirname "$TMUX_SOCK")"
chmod 700 "$(dirname "$TMUX_SOCK")"
( cd /app/server && PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" exec bun run src/index.ts ) >/tmp/t571-hub.log 2>&1 &
HUB_PID=$!
for _ in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && ok "hub up" || { bad "hub did not start"; tail -40 /tmp/t571-hub.log; exit 1; }

REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"username":"t571admin","password":"t571_TestPass_1234!","email":"t571@test.local"}')
UTOK=$(printf '%s' "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] && ok "admin utok" || { bad "register: $REG"; exit 1; }
mcp_init_once "$UTOK"
NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r '.networks[0].network_id')
[[ -n "$NET_ID" && "$NET_ID" != null ]] && ok "network $NET_ID" || { bad "no network"; exit 1; }

# ── 0.A daemon ────────────────────────────────────────────────────
note "0.A host_supervisor daemon in $DAEMON_WD (HOME=$DAEMON_WD)"
DAEMON_NTOK=$(curl -sS -X POST "$HUB_BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"$DAEMON_NAME\"}" | jq -r .token)
[[ "$DAEMON_NTOK" == ntok_* ]] && ok "daemon ntok" || { bad "daemon ntok"; exit 1; }
DAEMON_NODE_ID="node_daemon_t571_$(date +%s%N | sha256sum | head -c 12)"
mkdir -p "$DAEMON_WD/.anet/nodes/$DAEMON_NAME"
cat > "$DAEMON_WD/.anet/nodes/$DAEMON_NAME/config.json" <<EOF
{"node_id":"$DAEMON_NODE_ID","node_name":"$DAEMON_NAME","alias":"$DAEMON_NAME","role":"host_supervisor",
 "runtime":"claude-agent-sdk","model":"claude-opus-original",
 "hub":"$HUB_BASE","token":"$DAEMON_NTOK"}
EOF
ANET_BIN_ABS=$(realpath -e "$(command -v anet)")
( cd "$DAEMON_WD" && HOME="$DAEMON_WD" ANET_BIN_ABS="$ANET_BIN_ABS" ANET_DAEMON_ALLOW_ENV_BIN=1 \
    exec anet node start "$DAEMON_NAME" ) >/tmp/t571-daemon.log 2>&1 &
DAEMON_PID=$!
REGISTERED=""
for _ in $(seq 1 40); do
  sleep 1
  curl -sS "$HUB_BASE/api/nodes?node_id=$DAEMON_NODE_ID" -H "Authorization: Bearer $UTOK" \
    | jq -e ".nodes[0].node_id == \"$DAEMON_NODE_ID\"" >/dev/null 2>&1 && { REGISTERED=1; break; }
done
[[ -n "$REGISTERED" ]] && ok "daemon registered" || { bad "daemon never registered"; tail -40 /tmp/t571-daemon.log; exit 1; }
sleep 4   # past rebuildChildrenMapOnBoot (3s after register)

# ── S1 ────────────────────────────────────────────────────────────
note "S1. stop a daemon child while a same-alias agent-node runs in another workdir/HOME"
RESP=$(tool "$UTOK" create_node "{\"daemon_node_id\":\"$DAEMON_NODE_ID\",\"node_spec\":{\"name\":\"$CHILD\",\"runtime\":\"claude-agent-sdk\",\"model\":\"claude-opus-t571\"},\"network_id\":\"$NET_ID\"}")
CR=$(printf '%s' "$RESP" | jq -r .request_id 2>/dev/null)
[[ "$CR" == cr_* ]] && ok "create_node dispatched ($CR)" || bad "create_node: $RESP"
CHILD_NODE_ID="node_${CR#cr_}"
CHILD_CFG="$DAEMON_WD/.anet/nodes/$CHILD/config.json"
CHILD_PID=""
for _ in $(seq 1 60); do
  sleep 1
  CHILD_PID=$(pgrep -f -- "--config $CHILD_CFG --alias $CHILD" | sed -n 1p)
  [[ -n "$CHILD_PID" ]] && grep -q "capability check OK" /tmp/t571-daemon.log && break
done
alive "$CHILD_PID" && ok "child agent-node pid=$CHILD_PID (--config $CHILD_CFG)" || { bad "child agent-node never came up"; tail -40 /tmp/t571-daemon.log; }
sleep 2

FOREIGN1=$(start_foreign_agent_node "$ROOT/other1" "$CHILD" "n_571aaaa")
FAKE_PIDS+=("$FOREIGN1")
sleep 0.5
alive "$FOREIGN1" && ok "foreign same-alias agent-node pid=$FOREIGN1 (HOME=$ROOT/other1)" || bad "foreign process did not start"

RESP=$(tool "$UTOK" stop_node "{\"child_node_id\":\"$CHILD_NODE_ID\",\"network_id\":\"$NET_ID\",\"force\":true}")
SR=$(printf '%s' "$RESP" | jq -r .request_id 2>/dev/null)
[[ "$SR" == sr_* ]] && ok "stop_node dispatched ($SR)" || bad "stop_node: $RESP"
ST=$(wait_stop_request_done "$SR" 40)
[[ "$ST" == stopped ]] && ok "daemon acked stopped" || { bad "stop request status='$ST'"; tail -30 /tmp/t571-daemon.log; }
for _ in $(seq 1 10); do alive "$CHILD_PID" || break; sleep 1; done
alive "$CHILD_PID" && bad "daemon child pid=$CHILD_PID survived its stop" || ok "daemon child reaped"
sleep 1
if alive "$FOREIGN1"; then ok "S1 foreign same-alias agent-node in another HOME survived"
else bad "S1 foreign same-alias agent-node pid=$FOREIGN1 was KILLED by the child's stop (sweep by alias)"; fi

# ── S2 ────────────────────────────────────────────────────────────
note "S2. no authority refuses at Hub; Hub-only authority still refuses at daemon"
GHOST_ID="node_ghost571"; GHOST_ALIAS="ghost571"
insert_node_row "$GHOST_ID" "$GHOST_ALIAS" && ok "hub row $GHOST_ID (no create record)" || bad "insert ghost row"
FOREIGN2=$(start_foreign_agent_node "$ROOT/other2" "$GHOST_ALIAS" "n_571bbbb")
FAKE_PIDS+=("$FOREIGN2")
sleep 0.5
alive "$FOREIGN2" && ok "same-alias agent-node pid=$FOREIGN2 (HOME=$ROOT/other2)" || bad "foreign2 did not start"
RESP=$(tool "$UTOK" stop_node "{\"child_node_id\":\"$GHOST_ID\",\"daemon_node_id\":\"$DAEMON_NODE_ID\",\"network_id\":\"$NET_ID\"}")
[[ "$(printf '%s' "$RESP" | jq -r .error)" == daemon_not_resolvable ]] && ok "unbound node_ rejected despite explicit daemon" || bad "unbound stop: $RESP"
[[ "$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM node_stop_requests WHERE child_node_id='$GHOST_ID';")" == 0 ]] && ok "unbound stop wrote no request" || bad "unbound stop wrote a request"
[[ "$(sqlite3 "$HUB_DB" "SELECT lifecycle_state FROM nodes WHERE node_id='$GHOST_ID';")" == active ]] && ok "unbound lifecycle untouched" || bad "unbound lifecycle changed"
alive "$FOREIGN2" && ok "unbound same-alias process survived" || bad "unbound process killed"
# Hub authority is not a daemon-local ownership record. Preserve the independent
# daemon safety regression instead of weakening the new Hub authorization gate.
sqlite3 "$HUB_DB" "INSERT INTO node_create_requests(request_id,daemon_node_id,child_name,network_id,runtime,model,flags_json,env_keys,status,created_at,created_by_token,child_node_id)
  VALUES('cr_ghost571','$DAEMON_NODE_ID','$GHOST_ALIAS','$NET_ID','claude-agent-sdk','x','{}','[]','succeeded',1,'test571','$GHOST_ID');" || { bad "seed Hub-only authority"; exit 1; }
RESP=$(tool "$UTOK" stop_node "{\"child_node_id\":\"$GHOST_ID\",\"daemon_node_id\":\"$DAEMON_NODE_ID\",\"network_id\":\"$NET_ID\"}")
SR2=$(printf '%s' "$RESP" | jq -r .request_id 2>/dev/null)
[[ "$SR2" == sr_* ]] && ok "Hub-only creation authority dispatched to daemon" || bad "dispatch: $RESP"
ST2=$(wait_stop_request_done "$SR2" 40)
ERR2=$(sqlite3 "$HUB_DB" "SELECT COALESCE(error,'') FROM node_stop_requests WHERE request_id='$SR2';")
[[ "$ST2" == stop_failed ]] && ok "daemon refused: status=stop_failed" || bad "daemon ack status='$ST2' (expected stop_failed)"
[[ "$ERR2" == *not_my_child* ]] && ok "error carries not_my_child" || bad "error='$ERR2'"
sleep 1
if alive "$FOREIGN2"; then ok "S2 same-alias agent-node survived"
else bad "S2 same-alias agent-node pid=$FOREIGN2 was KILLED by a stop for a node the daemon never created"; fi

# ── S3 ────────────────────────────────────────────────────────────
note "S3. hand-started node (n_ id) + explicit daemon_node_id → hub refuses"
HAND_ID="n_571cccc"; HAND_ALIAS="hand571"
insert_node_row "$HAND_ID" "$HAND_ALIAS" && ok "hub row $HAND_ID" || bad "insert hand row"
FOREIGN3=$(start_foreign_agent_node "$ROOT/other3" "$HAND_ALIAS" "$HAND_ID")
FAKE_PIDS+=("$FOREIGN3")
RESP=$(tool "$UTOK" stop_node "{\"child_node_id\":\"$HAND_ID\",\"daemon_node_id\":\"$DAEMON_NODE_ID\",\"network_id\":\"$NET_ID\"}")
E3=$(printf '%s' "$RESP" | jq -r .error 2>/dev/null)
[[ "$E3" == not_daemon_managed ]] && ok "stop_node → not_daemon_managed" || bad "stop_node: $RESP"
RESP=$(tool "$UTOK" delete_node "{\"child_node_id\":\"$HAND_ID\",\"daemon_node_id\":\"$DAEMON_NODE_ID\",\"confirm_alias\":\"$HAND_ALIAS\",\"network_id\":\"$NET_ID\"}")
E3D=$(printf '%s' "$RESP" | jq -r .error 2>/dev/null)
[[ "$E3D" == not_daemon_managed ]] && ok "delete_node → not_daemon_managed" || bad "delete_node: $RESP"
N3=$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM node_stop_requests WHERE child_node_id='$HAND_ID';")
[[ "$N3" == 0 ]] && ok "no stop request written" || bad "$N3 stop request(s) written for a hand-started node"
LS3=$(sqlite3 "$HUB_DB" "SELECT lifecycle_state FROM nodes WHERE node_id='$HAND_ID';")
[[ "$LS3" == active ]] && ok "lifecycle_state untouched (active)" || bad "lifecycle_state=$LS3"
sleep 3
alive "$FOREIGN3" && ok "S3 hand-started process alive" || bad "S3 hand-started process pid=$FOREIGN3 was KILLED"

# ── S4 ────────────────────────────────────────────────────────────
note "S4. anet project up with a node running outside tmux"
PROJ="$ROOT/proj"
mkdir -p "$PROJ/.anet/nodes/live571" "$PROJ/.anet/nodes/stale571"
for n in live571 stale571; do
  cat > "$PROJ/.anet/nodes/$n/config.json" <<EOF
{"node_id":"n_${n}","node_name":"$n","alias":"$n","runtime":"claude-agent-sdk","model":"x","hub":"http://127.0.0.1:9","token":"ntok_t571_fake_$n"}
EOF
  chmod 600 "$PROJ/.anet/nodes/$n/config.json"
done
LIVE=$(start_foreign_agent_node "$PROJ" "live571" "live571")
FAKE_PIDS+=("$LIVE")
echo "$LIVE" > "$PROJ/.anet/nodes/live571/.pid"
DEAD=$(bash -c 'echo $$')    # a pid that has already exited
echo "$DEAD" > "$PROJ/.anet/nodes/stale571/.pid"
sleep 0.5
alive "$LIVE" && ok "live571 running outside tmux, pid=$LIVE in .pid" || bad "live571 fake did not start"
alive "$DEAD" && bad "dead-pid fixture is alive (pid reused?)" || ok "stale571 .pid holds dead pid $DEAD"

OUT=$(cd "$PROJ" && HOME="$PROJ" ANET_TMUX_SOCKET="$TMUX_SOCK" timeout 90 anet project up --stagger 0 2>&1); RC=$?
printf '%s\n' "$OUT" | sed 's/^/    | /'
echo "    (project up rc=$RC)"
printf '%s' "$OUT" | grep -Eq 'live571 — already running' && ok "live571 reported already running" || bad "live571 not reported as already running"
[[ "$(cat "$PROJ/.anet/nodes/live571/.pid" 2>/dev/null)" == "$LIVE" ]] && ok "live571 .pid untouched" || bad "live571 .pid changed/deleted: '$(cat "$PROJ/.anet/nodes/live571/.pid" 2>/dev/null)'"
if tmux -S "$TMUX_SOCK" list-sessions -F '#{session_name}' 2>/dev/null | grep -qx live571; then
  bad "a tmux session live571 was started (second copy)"
else ok "no tmux session for live571"; fi
SECOND=$(pgrep -f "anet node start live571|--alias live571" | grep -vx "$LIVE" | tr '\n' ' ')
[[ -z "$SECOND" ]] && ok "no second live571 process" || bad "second live571 process(es): $SECOND"
alive "$LIVE" && ok "original live571 still alive" || bad "original live571 died"
[[ "$(cat "$PROJ/.anet/nodes/stale571/.pid" 2>/dev/null)" != "$DEAD" ]] && ok "stale571 dead-pid .pid cleared (stale cleanup kept)" || bad "stale571 still holds the dead pid"
printf '%s' "$OUT" | grep -Eq 'stale571 — starting' && ok "stale571 was started" || bad "stale571 was not started"

# ── S5 ────────────────────────────────────────────────────────────
note "S5. daemon restart: own child dead + same-alias agent-node elsewhere → rebuild must not adopt it"
CHILD5="dup579"
RESP=$(tool "$UTOK" create_node "{\"daemon_node_id\":\"$DAEMON_NODE_ID\",\"node_spec\":{\"name\":\"$CHILD5\",\"runtime\":\"claude-agent-sdk\",\"model\":\"claude-opus-t579\"},\"network_id\":\"$NET_ID\"}")
CR5=$(printf '%s' "$RESP" | jq -r .request_id 2>/dev/null)
[[ "$CR5" == cr_* ]] && ok "create_node dispatched ($CR5)" || bad "create_node: $RESP"
CHILD5_NODE_ID="node_${CR5#cr_}"
CHILD5_CFG="$DAEMON_WD/.anet/nodes/$CHILD5/config.json"
CHILD5_PID=""
for _ in $(seq 1 60); do
  sleep 1
  CHILD5_PID=$(pgrep -f -- "--config $CHILD5_CFG --alias $CHILD5" | sed -n 1p)
  [[ -n "$CHILD5_PID" ]] && break
done
alive "$CHILD5_PID" && ok "child $CHILD5 pid=$CHILD5_PID" || { bad "child $CHILD5 never came up"; tail -40 /tmp/t571-daemon.log; }
sleep 3

# stop the daemon (wrapper + its agent-node), then kill the child's whole process group:
# the hub row stays lifecycle_state=active, which is exactly what list_my_children returns.
DAEMON_CFG="$DAEMON_WD/.anet/nodes/$DAEMON_NAME/config.json"
kill "$DAEMON_PID" 2>/dev/null; pkill -f -- "--config $DAEMON_CFG" 2>/dev/null
for _ in $(seq 1 20); do pgrep -f -- "--config $DAEMON_CFG" >/dev/null || break; sleep 0.5; done
pgrep -f -- "--config $DAEMON_CFG" >/dev/null && bad "daemon still running after kill" || ok "daemon stopped"
C5_PGID=$(ps -o pgid= -p "$CHILD5_PID" 2>/dev/null | tr -d ' ')
[[ -n "$C5_PGID" ]] && kill -KILL -- "-$C5_PGID" 2>/dev/null
for _ in $(seq 1 20); do alive "$CHILD5_PID" || break; sleep 0.5; done
alive "$CHILD5_PID" && bad "own child pid=$CHILD5_PID still alive" || ok "own child $CHILD5 is dead (pgid $C5_PGID killed)"
LS5=$(sqlite3 "$HUB_DB" "SELECT COALESCE(lifecycle_state,'active') FROM nodes WHERE node_id='$CHILD5_NODE_ID';")
[[ "$LS5" == active ]] && ok "hub still lists $CHILD5 as active" || bad "hub lifecycle_state=$LS5 (rebuild would not see it)"

FOREIGN5=$(start_foreign_agent_node "$ROOT/other5" "$CHILD5" "n_579eeee")
FAKE_PIDS+=("$FOREIGN5")
sleep 0.5
alive "$FOREIGN5" && ok "foreign same-alias agent-node pid=$FOREIGN5 (HOME=$ROOT/other5)" || bad "foreign5 did not start"

( cd "$DAEMON_WD" && HOME="$DAEMON_WD" ANET_BIN_ABS="$ANET_BIN_ABS" ANET_DAEMON_ALLOW_ENV_BIN=1 \
    exec anet node start "$DAEMON_NAME" ) >/tmp/t571-daemon2.log 2>&1 &
DAEMON_PID=$!
REBUILT=""
for _ in $(seq 1 60); do sleep 1; grep -q '\[rebuild\] done' /tmp/t571-daemon2.log && { REBUILT=1; break; }; done
[[ -n "$REBUILT" ]] && ok "restarted daemon ran boot rebuild" || { bad "no [rebuild] done in restarted daemon log"; tail -40 /tmp/t571-daemon2.log; }
grep '\[rebuild\]' /tmp/t571-daemon2.log | sed 's/^/    | /'
if grep -q "\[rebuild\] recovered alias=$CHILD5 → pid=$FOREIGN5" /tmp/t571-daemon2.log; then
  bad "rebuild adopted the foreign pid=$FOREIGN5 as child $CHILD5"
else ok "rebuild did not adopt the foreign pid"; fi
grep -q "\[rebuild\] ignoring pid=$FOREIGN5 alias=$CHILD5" /tmp/t571-daemon2.log \
  && ok "rebuild logged why it ignored pid=$FOREIGN5" || bad "no ignore line for pid=$FOREIGN5"

RESP=$(tool "$UTOK" stop_node "{\"child_node_id\":\"$CHILD5_NODE_ID\",\"network_id\":\"$NET_ID\",\"force\":true}")
SR5=$(printf '%s' "$RESP" | jq -r .request_id 2>/dev/null)
[[ "$SR5" == sr_* ]] && ok "stop_node dispatched ($SR5)" || bad "stop_node: $RESP"
ST5=$(wait_stop_request_done "$SR5" 40)
[[ "$ST5" == stopped ]] && ok "daemon acked stopped (own config on disk → converge)" || { bad "stop request status='$ST5'"; tail -30 /tmp/t571-daemon2.log; }
sleep 2
if alive "$FOREIGN5"; then ok "S5 foreign same-alias agent-node survived the daemon restart + stop"
else bad "S5 foreign same-alias agent-node pid=$FOREIGN5 was KILLED (boot rebuild adopted it by alias)"; fi

printf "\n────────────────────────────────────────────\n"
printf "test571 lifecycle safety — PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
printf "────────────────────────────────────────────\n"
[[ "$FAIL" -eq 0 ]]

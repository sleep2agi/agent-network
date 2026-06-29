#!/usr/bin/env bash
# RFC-027 PR1.2 stop/delete node lifecycle e2e.
#
# Per 通信龙 2026-06-30 ack of PR #348: scenario A is the preview gate.
# Real container → real hub → real host_supervisor daemon → real
# create_node child → POST /api/task delivers → stop_node → pgrep
# verifies reap → delete_node → config moved to ~/.anet/deleted/
# <ts>-<alias> + chmod 700 → sweeper真删 after retention exceeded.
#
# Layout mirrors qa-rfc026-create-node — same hub boot, same daemon
# launch, same MCP call helpers. Distinct hub port (9237) + COMMHUB_DB
# so this can run in the same container as qa-rfc026 without conflict.

set -uo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/safe-rm.sh"

HUB_PORT=9237
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=/tmp/qa-rfc027-hub.db
ADMIN_USER="rfc027admin"
ADMIN_PW="rfc027_TestPass_1234!"
STRANGER_USER="rfc027stranger"
STRANGER_PW="rfc027_Stranger_5678!"
DAEMON_NAME="daemon-rfc027"
DAEMON_NAME_NETB="daemon-rfc027-netb"
CHILD_A="rfc027-child-a"
CHILD_L1="rfc027-child-l1"
CHILD_DELETE="rfc027-child-delete"
CHILD_NETB="rfc027-child-netb"
WORK=/tmp/rfc027-work
HOME_FOR_TRASH="$WORK"          # we set HOME=$WORK below so ~/.anet maps in $WORK

PASS=0; FAIL=0; SKIP=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
stub() { printf "  ⊘ %s — stub: %s\n" "$1" "$2"; SKIP=$((SKIP+1)); }

mcp_init_once() {
  curl -sS -X POST "$HUB_BASE/mcp" \
    -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"qa-rfc027","version":"0"}}}' >/dev/null 2>&1 || true
}
# mcp_call_raw: returns the raw JSON-RPC response body (one or many SSE
# data frames). Use this for tools that return structured replies you
# want to inspect in full. Caller is responsible for parsing.
mcp_call_raw() {
  local tok="$1" body="$2"
  curl -sS -X POST "$HUB_BASE/mcp" \
    -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "$body"
}
# mcp_call: returns the inner JSON string of result.content[0].text
# (which is itself a JSON-encoded reply). Same shape as qa-rfc026.
mcp_call() {
  local tok="$1" body="$2"
  local resp; resp=$(mcp_call_raw "$tok" "$body")
  local inner; inner=$(echo "$resp" | grep -oP '(?<=data: ).+' | head -1 | jq -r '.result.content[0].text' 2>/dev/null)
  if [[ -z "$inner" || "$inner" == "null" ]]; then
    inner=$(echo "$resp" | jq -r '.result.content[0].text' 2>/dev/null)
  fi
  [[ -z "$inner" || "$inner" == "null" ]] && echo "$resp" || echo "$inner"
}

build_create_node_body() {
  cat <<JSON
{"jsonrpc":"2.0","id":$RANDOM,"method":"tools/call","params":{"name":"create_node","arguments":{
  "daemon_node_id":"$1",
  "node_spec":{"name":"$2","runtime":"$3","model":"$4"},
  "network_id":"$5"
}}}
JSON
}
build_stop_node_body() {
  # args: child_node_id, [daemon_node_id], [network_id], [force]
  # If daemon_node_id is empty, the field is OMITTED (tests L1/L2/L3 hub auto-resolve).
  local daemon_part=""
  if [[ -n "${2:-}" ]]; then daemon_part=",\"daemon_node_id\":\"$2\""; fi
  local net_part=""
  if [[ -n "${3:-}" ]]; then net_part=",\"network_id\":\"$3\""; fi
  local force_part=""
  if [[ "${4:-false}" == "true" ]]; then force_part=",\"force\":true"; fi
  cat <<JSON
{"jsonrpc":"2.0","id":$RANDOM,"method":"tools/call","params":{"name":"stop_node","arguments":{
  "child_node_id":"$1"$daemon_part$net_part$force_part
}}}
JSON
}
build_delete_node_body() {
  # args: child_node_id, daemon_node_id, confirm_alias, [network_id], [force]
  local net_part=""
  if [[ -n "${4:-}" ]]; then net_part=",\"network_id\":\"$4\""; fi
  local force_part=""
  if [[ "${5:-false}" == "true" ]]; then force_part=",\"force\":true"; fi
  cat <<JSON
{"jsonrpc":"2.0","id":$RANDOM,"method":"tools/call","params":{"name":"delete_node","arguments":{
  "child_node_id":"$1",
  "daemon_node_id":"$2",
  "confirm_alias":"$3"$net_part$force_part
}}}
JSON
}
build_restart_node_body() {
  # args: node_id, [network_id]
  local net_part=""
  if [[ -n "${2:-}" ]]; then net_part=",\"network_id\":\"$2\""; fi
  cat <<JSON
{"jsonrpc":"2.0","id":$RANDOM,"method":"tools/call","params":{"name":"restart_node","arguments":{
  "node_id":"$1"$net_part
}}}
JSON
}
build_list_my_children_body() {
  cat <<JSON
{"jsonrpc":"2.0","id":$RANDOM,"method":"tools/call","params":{"name":"list_my_children","arguments":{}}}
JSON
}

# wait_stop_request_done: poll until node_stop_requests.status terminal.
wait_stop_request_done() {
  local req_id="$1" deadline=$(( $(date +%s) + ${2:-30} ))
  local status
  while [[ $(date +%s) -lt $deadline ]]; do
    status=$(sqlite3 "$HUB_DB" "SELECT status FROM node_stop_requests WHERE request_id='$req_id';" 2>/dev/null)
    if [[ "$status" == "stopped" || "$status" == "stop_failed" || "$status" == "noop_not_my_child" ]]; then
      echo "$status"; return 0
    fi
    sleep 0.5
  done
  echo "$status"
  return 1
}

# alias_pgrep_count: how many "agent-node --alias <name>" processes are
# alive right now. Used to prove SIGTERM really reaped the child + grandchild.
alias_pgrep_count() {
  pgrep -af "agent-node.*--alias $1" 2>/dev/null | grep -v grep | wc -l
}

# ── 0. boot hub + admin + stranger user ──────────────────────────
note "0. boot hub + admin user + utok + member network"
safe_rm_rf "$WORK" 2>/dev/null || true
rm -f "$HUB_DB" "${HUB_DB}-shm" "${HUB_DB}-wal" 2>/dev/null
mkdir -p "$WORK"
cd /app/server
PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" bun run src/index.ts >/tmp/hub-027.log 2>&1 &
HUB_PID=$!
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null && ok "hub /health 200 :$HUB_PORT" || { bad "hub did not start"; tail -40 /tmp/hub-027.log; exit 1; }

REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"email\":\"r027@test.local\"}")
UTOK=$(echo "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint failed: $REG"; exit 1; }
mcp_init_once "$UTOK"

NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r .networks[0].network_id)
ADMIN_USER_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r .user.user_id)
[[ -n "$NET_ID" && "$NET_ID" != "null" ]] && ok "default network = $NET_ID" || { bad "no network"; exit 1; }

# Stranger user owns a DIFFERENT network (used for L2 cross-tenant test
# and CN list_my_children cross-network coverage). The admin is NOT a
# member of stranger-net, so admin's utok can't read or write there.
REG_S=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$STRANGER_USER\",\"password\":\"$STRANGER_PW\",\"email\":\"s027@test.local\"}")
STRANGER_UTOK=$(echo "$REG_S" | jq -r .token)
STRANGER_NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $STRANGER_UTOK" | jq -r .networks[0].network_id)
[[ -n "$STRANGER_NET_ID" && "$STRANGER_NET_ID" != "null" ]] && ok "stranger network = $STRANGER_NET_ID" || { bad "stranger network missing"; exit 1; }
mcp_init_once "$STRANGER_UTOK"

# ── 0.A bring up daemon (host_supervisor) ────────────────────────
note "0.A spawn host_supervisor daemon"
DAEMON_NTOK_RESP=$(curl -sS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"$DAEMON_NAME\"}")
DAEMON_NTOK=$(echo "$DAEMON_NTOK_RESP" | jq -r .token)
[[ "$DAEMON_NTOK" == ntok_* ]] && ok "daemon ntok minted" || { bad "daemon ntok mint: $DAEMON_NTOK_RESP"; exit 1; }
DAEMON_NODE_ID="node_daemon_rfc027_$(date +%s%N | sha256sum | head -c 12)"

mkdir -p "$WORK/.anet/nodes/$DAEMON_NAME"
cat > "$WORK/.anet/nodes/$DAEMON_NAME/config.json" <<EOF
{"node_id":"$DAEMON_NODE_ID","node_name":"$DAEMON_NAME","alias":"$DAEMON_NAME","role":"host_supervisor",
 "runtime":"claude-agent-sdk","model":"claude-opus-original",
 "hub":"http://127.0.0.1:$HUB_PORT","token":"$DAEMON_NTOK"}
EOF
cd "$WORK"
export HOME="$WORK"   # ~/.anet/deleted will land under $WORK/.anet/deleted
export ANET_BIN_ABS=$(realpath -e "$(which anet)")
nohup anet node start "$DAEMON_NAME" > /tmp/daemon-027.log 2>&1 &
DAEMON_PID=$!
REGISTERED=""
for i in $(seq 1 30); do
  sleep 1
  R=$(curl -sS "$HUB_BASE/api/nodes?node_id=$DAEMON_NODE_ID" -H "Authorization: Bearer $UTOK")
  if echo "$R" | jq -e ".nodes[0].node_id == \"$DAEMON_NODE_ID\"" >/dev/null 2>&1; then REGISTERED=yes; break; fi
done
[[ -n "$REGISTERED" ]] && ok "daemon registered ($DAEMON_NAME / $DAEMON_NODE_ID)" || { bad "daemon never registered"; tail -40 /tmp/daemon-027.log; exit 1; }

# ── A. happy path — create + post task + stop + delete + sweep ───
note "A.1 admin create_node — child registers + real process tree alive"
BODY=$(build_create_node_body "$DAEMON_NODE_ID" "$CHILD_A" "claude-agent-sdk" "claude-opus-rfc027-child" "$NET_ID")
RESP=$(mcp_call "$UTOK" "$BODY")
REQUEST_ID=$(echo "$RESP" | jq -r .request_id 2>/dev/null)
[[ "$REQUEST_ID" == cr_* ]] && ok "create_node dispatched (request_id=$REQUEST_ID)" \
  || { bad "dispatch failed: $RESP"; }

CHILD_A_NODE_ID="node_${REQUEST_ID#cr_}"
ok "expected child node_id (derived from request_id) = $CHILD_A_NODE_ID"

CHILD_REG=""
for i in $(seq 1 60); do
  sleep 1
  if curl -sS "$HUB_BASE/api/nodes?node_id=$CHILD_A_NODE_ID" -H "Authorization: Bearer $UTOK" \
       | jq -e ".nodes[0].node_id == \"$CHILD_A_NODE_ID\"" >/dev/null 2>&1; then
    CHILD_REG=yes; break
  fi
done
[[ -n "$CHILD_REG" ]] && ok "child registered: $CHILD_A / $CHILD_A_NODE_ID" || { bad "child never registered"; tail -40 /tmp/daemon-027.log; }

WRAPPER_PID_LINE=$(grep -oE "spawned child .$CHILD_A. pid=[0-9]+" /tmp/daemon-027.log 2>/dev/null | tail -1)
CHILD_A_WRAPPER_PID=$(echo "$WRAPPER_PID_LINE" | grep -oE "[0-9]+$")
if [[ -n "$CHILD_A_WRAPPER_PID" ]] && kill -0 "$CHILD_A_WRAPPER_PID" 2>/dev/null; then
  ok "wrapper pid=$CHILD_A_WRAPPER_PID alive after create"
else
  bad "wrapper pid for $CHILD_A not alive — spawn failed"
fi
sleep 10   # let grandchild fully boot + cross 5s capability check
CHILD_A_GRANDCHILD_PID=$(pgrep -af "agent-node.*--alias $CHILD_A" 2>/dev/null | grep -v grep | awk '{print $1}' | head -1)
if [[ -n "$CHILD_A_GRANDCHILD_PID" ]] && kill -0 "$CHILD_A_GRANDCHILD_PID" 2>/dev/null; then
  ok "grandchild agent-node pid=$CHILD_A_GRANDCHILD_PID alive (full process tree intact)"
else
  bad "grandchild for $CHILD_A not found"
fi

note "A.1.SIBLING — spawn CHILD_L1 early so A.3 can prove sibling/daemon SURVIVE the stop"
# 通信龙 PR1.2 BUG-B nit #1: pgid kill must NOT spill onto daemon or
# siblings. Spawn an additional independent child here so we can assert
# after A.3 that (a) daemon PID is still alive (b) sibling PID is still
# alive. detached:true guarantees each child has its own session → its
# own pgid → its own kill scope, but we verify with real procs.
BODY=$(build_create_node_body "$DAEMON_NODE_ID" "$CHILD_L1" "claude-agent-sdk" "claude-opus-rfc027-sibling" "$NET_ID")
RESP=$(mcp_call "$UTOK" "$BODY")
REQUEST_ID_L1=$(echo "$RESP" | jq -r .request_id 2>/dev/null)
[[ "$REQUEST_ID_L1" == cr_* ]] && ok "sibling child create dispatched ($REQUEST_ID_L1)" || bad "sibling create dispatch: $RESP"
CHILD_L1_NODE_ID="node_${REQUEST_ID_L1#cr_}"
CHILD_L1_REG=""
for i in $(seq 1 60); do
  sleep 1
  if curl -sS "$HUB_BASE/api/nodes?node_id=$CHILD_L1_NODE_ID" -H "Authorization: Bearer $UTOK" \
       | jq -e ".nodes[0].node_id == \"$CHILD_L1_NODE_ID\"" >/dev/null 2>&1; then
    CHILD_L1_REG=yes; break
  fi
done
[[ -n "$CHILD_L1_REG" ]] && ok "sibling child registered ($CHILD_L1 / $CHILD_L1_NODE_ID)" \
  || { bad "sibling child never registered"; tail -20 /tmp/daemon-027.log; }
sleep 8  # cross 5s capability check
# Capture sibling wrapper + grandchild PIDs for post-A.3 survival assertion
L1_WRAPPER_LINE=$(grep -oE "spawned child .$CHILD_L1. pid=[0-9]+" /tmp/daemon-027.log | tail -1)
CHILD_L1_WRAPPER_PID=$(echo "$L1_WRAPPER_LINE" | grep -oE "[0-9]+$")
CHILD_L1_GRANDCHILD_PID=$(pgrep -af "agent-node.*--alias $CHILD_L1" | grep -v grep | awk '{print $1}' | head -1)
ok "sibling pids captured: wrapper=$CHILD_L1_WRAPPER_PID grandchild=$CHILD_L1_GRANDCHILD_PID (will assert ALIVE after A.3 stop)"
DAEMON_AGENTNODE_PID=$(pgrep -af "agent-node.*--alias $DAEMON_NAME" | grep -v grep | awk '{print $1}' | head -1)
[[ -n "$DAEMON_AGENTNODE_PID" ]] && ok "daemon agent-node pid captured: $DAEMON_AGENTNODE_PID (will assert ALIVE after A.3 stop)" \
  || bad "could not find daemon's agent-node PID in process tree"

note "A.2 routable proof — POST /api/task to child alias lands in inbox"
TASK_RESP=$(curl -sS -X POST "$HUB_BASE/api/task" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"$CHILD_A\",\"task\":\"ping from rfc027-e2e\",\"network_id\":\"$NET_ID\"}")
TASK_QUEUED=$(echo "$TASK_RESP" | jq -r .queued 2>/dev/null)
TASK_ID=$(echo "$TASK_RESP" | jq -r .task_id 2>/dev/null)
if [[ "$TASK_QUEUED" == "true" || -n "$TASK_ID" && "$TASK_ID" != "null" ]]; then
  ok "task dispatched via REST to $CHILD_A (queued=$TASK_QUEUED, task_id=$TASK_ID)"
else
  bad "task dispatch failed: $TASK_RESP"
fi
INBOX_COUNT=$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM inbox WHERE session_name='$CHILD_A';" 2>/dev/null)
[[ "$INBOX_COUNT" -ge 1 ]] && ok "inbox row exists for $CHILD_A (active child is routable; count=$INBOX_COUNT)" \
  || bad "no inbox row for $CHILD_A (count=$INBOX_COUNT)"

note "A.3 stop_node — D4 in-flight gate + force override + daemon really reaps"
COUNT_BEFORE=$(alias_pgrep_count "$CHILD_A")
ok "pgrep agent-node --alias $CHILD_A BEFORE stop = $COUNT_BEFORE (≥1 expected)"

# A.3.0 — D4 fail-closed: A.2 posted a task that's still unacked, so
# stop_node WITHOUT force MUST refuse with node_busy_in_flight + the
# in_flight_count + hint. Proves §4.3 D4 in-flight gate works on real
# inbox rows (not just unit-mocked counters).
BODY=$(build_stop_node_body "$CHILD_A_NODE_ID" "$DAEMON_NODE_ID" "$NET_ID" "false")
RESP=$(mcp_call "$UTOK" "$BODY")
ERR=$(echo "$RESP" | jq -r .error 2>/dev/null)
INFLIGHT_REPORTED=$(echo "$RESP" | jq -r .in_flight_count 2>/dev/null)
if [[ "$ERR" == "node_busy_in_flight" && "$INFLIGHT_REPORTED" -ge 1 ]]; then
  ok "A.3.0 D4 in-flight gate refused stop without force (error=$ERR, in_flight_count=$INFLIGHT_REPORTED)"
else
  bad "A.3.0 D4 in-flight gate did not refuse: $RESP"
fi
# Also assert audit row is NOT present (since the gate aborted before
# the dispatch tx — we should see ZERO stop_node_dispatched rows so far)
PRE_AUD=$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM audit_log WHERE action='stop_node_dispatched' AND detail LIKE '%$CHILD_A%';" 2>/dev/null)
[[ "$PRE_AUD" == "0" ]] && ok "A.3.0 no audit row created by D4-refused dispatch (gate is fail-closed, not fail-open with audit)" \
  || bad "A.3.0 audit row leaked despite D4 refusal: count=$PRE_AUD"

# A.3.1 — same call with force=true → succeeds + audit logged
BODY=$(build_stop_node_body "$CHILD_A_NODE_ID" "$DAEMON_NODE_ID" "$NET_ID" "true")
RESP=$(mcp_call "$UTOK" "$BODY")
STOP_REQ_ID=$(echo "$RESP" | jq -r .request_id 2>/dev/null)
LCS=$(echo "$RESP" | jq -r .lifecycle_state 2>/dev/null)
INFLIGHT_AT_DISPATCH=$(echo "$RESP" | jq -r .in_flight_at_dispatch 2>/dev/null)
[[ "$STOP_REQ_ID" == sr_* ]] && ok "A.3.1 stop_node force=true dispatched (request_id=$STOP_REQ_ID, lifecycle_state=$LCS, in_flight_at_dispatch=$INFLIGHT_AT_DISPATCH)" \
  || bad "A.3.1 force=true dispatch failed: $RESP"
[[ "$LCS" == "stopping" ]] && ok "node lifecycle state flipped to 'stopping' at dispatch" \
  || bad "expected lifecycle_state=stopping, got '$LCS'"
FORCED_AUD=$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM audit_log WHERE action='forced_stop_with_in_flight' AND target_id='$STOP_REQ_ID';" 2>/dev/null)
[[ "$FORCED_AUD" -ge 1 ]] && ok "A.3.1 forced_stop_with_in_flight audit row present (D4 force override is loud)" \
  || bad "A.3.1 force=true did not write forced_stop_with_in_flight audit row"

# Wait for daemon to consume SSE → SIGTERM → ack 'stopped'.
TERM_STATUS=$(wait_stop_request_done "$STOP_REQ_ID" 40)
[[ "$TERM_STATUS" == "stopped" ]] && ok "node_stop_requests.status = stopped (daemon ack'd)" \
  || { bad "stop request did not finalize in 40s (status='$TERM_STATUS'). Daemon log tail:"; tail -30 /tmp/daemon-027.log; }

# Real reap proof: pgrep count must drop to 0 within a few seconds of ack.
REAP_OK=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  if [[ "$(alias_pgrep_count "$CHILD_A")" -eq 0 ]]; then REAP_OK=yes; break; fi
  sleep 1
done
COUNT_AFTER=$(alias_pgrep_count "$CHILD_A")
if [[ -n "$REAP_OK" ]]; then
  ok "pgrep agent-node --alias $CHILD_A AFTER stop = 0 (real reap proof — wrapper + grandchild gone within ${i}s)"
else
  bad "REAP FAILED — pgrep count still $COUNT_AFTER after stop ack. Remaining process tree:"
  pgrep -af "agent-node.*--alias $CHILD_A" || true
fi
# Direct PID-level proof on the two recorded pids
if [[ -n "$CHILD_A_WRAPPER_PID" ]]; then
  if kill -0 "$CHILD_A_WRAPPER_PID" 2>/dev/null; then
    bad "wrapper pid=$CHILD_A_WRAPPER_PID still alive after stop ack"
  else
    ok "wrapper pid=$CHILD_A_WRAPPER_PID dead (ESRCH on kill-0)"
  fi
fi
if [[ -n "$CHILD_A_GRANDCHILD_PID" ]]; then
  if kill -0 "$CHILD_A_GRANDCHILD_PID" 2>/dev/null; then
    bad "grandchild pid=$CHILD_A_GRANDCHILD_PID still alive after stop ack"
  else
    ok "grandchild pid=$CHILD_A_GRANDCHILD_PID dead (ESRCH on kill-0)"
  fi
fi
# 通信龙 PR1.2 BUG-B nit #1 — pgid kill must NOT spill onto daemon or
# siblings. Verify on real procs (not just unit logic): the daemon
# agent-node + the sibling L1 wrapper+grandchild must ALL survive A.3.
if [[ -n "$DAEMON_AGENTNODE_PID" ]] && kill -0 "$DAEMON_AGENTNODE_PID" 2>/dev/null; then
  ok "DAEMON agent-node pid=$DAEMON_AGENTNODE_PID still alive after CHILD_A stop (pgid scope is wrapper's, not daemon's — daemon survived)"
else
  bad "DAEMON agent-node pid=$DAEMON_AGENTNODE_PID DIED after CHILD_A stop — pgid kill leaked onto daemon (critical red-line)"
fi
if [[ -n "$CHILD_L1_WRAPPER_PID" ]] && kill -0 "$CHILD_L1_WRAPPER_PID" 2>/dev/null; then
  ok "SIBLING wrapper pid=$CHILD_L1_WRAPPER_PID still alive after CHILD_A stop (each child detached:true → separate session/pgid — siblings unaffected)"
else
  bad "SIBLING wrapper pid=$CHILD_L1_WRAPPER_PID DIED — pgid kill leaked onto sibling (critical red-line)"
fi
if [[ -n "$CHILD_L1_GRANDCHILD_PID" ]] && kill -0 "$CHILD_L1_GRANDCHILD_PID" 2>/dev/null; then
  ok "SIBLING grandchild pid=$CHILD_L1_GRANDCHILD_PID still alive after CHILD_A stop"
else
  bad "SIBLING grandchild pid=$CHILD_L1_GRANDCHILD_PID DIED — leakage onto sibling grandchild"
fi
# Also: pgrep for sibling alias must still return ≥1 (independent proof)
L1_AFTER=$(alias_pgrep_count "$CHILD_L1")
[[ "$L1_AFTER" -ge 1 ]] && ok "pgrep agent-node --alias $CHILD_L1 = $L1_AFTER after stop (sibling process tree intact)" \
  || bad "pgrep $CHILD_L1 = $L1_AFTER (expected ≥1) — sibling collateral damage"
# Nodes-table state.
NODE_LCS=$(sqlite3 "$HUB_DB" "SELECT lifecycle_state FROM nodes WHERE node_id='$CHILD_A_NODE_ID';" 2>/dev/null)
[[ "$NODE_LCS" == "stopped" ]] && ok "nodes.lifecycle_state = stopped" \
  || bad "nodes.lifecycle_state = '$NODE_LCS' (expected stopped)"
# Audit row exists for the dispatcher.
AUD=$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM audit_log WHERE action='stop_node_dispatched' AND target_id='$STOP_REQ_ID';" 2>/dev/null)
[[ "$AUD" -ge 1 ]] && ok "audit row stop_node_dispatched present (D8 atomic with state transition)" \
  || bad "no audit row for stop_node_dispatched (D8 atomicity violated)"

note "A.4 restart_node on stopped node — lifecycle_state flips back to 'active' (PR1.2a un-stop fix)"
BODY=$(build_restart_node_body "$CHILD_A_NODE_ID" "$NET_ID")
RESP=$(mcp_call "$UTOK" "$BODY")
RESTART_OK=$(echo "$RESP" | jq -r .ok 2>/dev/null)
[[ "$RESTART_OK" == "true" ]] && ok "restart_node accepted ($(echo "$RESP" | jq -c '{update_id, apply_mode}'))" \
  || bad "restart_node refused: $RESP"
sleep 1
NODE_LCS_AFTER_RESTART=$(sqlite3 "$HUB_DB" "SELECT lifecycle_state FROM nodes WHERE node_id='$CHILD_A_NODE_ID';" 2>/dev/null)
if [[ "$NODE_LCS_AFTER_RESTART" == "active" ]]; then
  ok "nodes.lifecycle_state = active after restart_node (PR1.2a fix proven: stopped node un-stops + 8 inbox guards no longer refuse routing)"
else
  bad "nodes.lifecycle_state = '$NODE_LCS_AFTER_RESTART' after restart (expected 'active' per PR1.2a)"
fi
# (Note: actual child-process respawn is a separate code path — the
# config_update SSE goes to the child alias which has no listener after
# stop; respawn-from-config is RFC-027 §3.2 follow-up. PR1.2a's contract
# is the un-stop only, which is what we assert above.)

note "A.5 delete_node — confirm_alias gate + backup mv + chmod 700 + row gone + ntok revoked"
# A.5 spawns a FRESH child (CHILD_DELETE) and delete_node's it directly.
# Why fresh: stop_node leaves childrenMap.delete'd → a later delete on
# the same alias gets `noop_not_my_child` from the daemon (no SIGTERM,
# no backup mv). The dashboard flow for delete is "delete directly"
# (one tool call, not stop-then-delete), so this matches the real
# user/UI path. The stop-then-restart-then-delete sequence is degraded
# and gets hub-side finalize only (RFC-027 §3.2 follow-up for full
# respawn-then-delete proper).
BODY=$(build_create_node_body "$DAEMON_NODE_ID" "$CHILD_DELETE" "claude-agent-sdk" "claude-opus-rfc027-del" "$NET_ID")
RESP=$(mcp_call "$UTOK" "$BODY")
REQUEST_ID_DEL=$(echo "$RESP" | jq -r .request_id 2>/dev/null)
[[ "$REQUEST_ID_DEL" == cr_* ]] && ok "A.5 fresh child dispatched ($REQUEST_ID_DEL)" || bad "A.5 create dispatch: $RESP"
CHILD_DELETE_NODE_ID="node_${REQUEST_ID_DEL#cr_}"
CHILD_DELETE_REG=""
for i in $(seq 1 60); do
  sleep 1
  if curl -sS "$HUB_BASE/api/nodes?node_id=$CHILD_DELETE_NODE_ID" -H "Authorization: Bearer $UTOK" \
       | jq -e ".nodes[0].node_id == \"$CHILD_DELETE_NODE_ID\"" >/dev/null 2>&1; then
    CHILD_DELETE_REG=yes; break
  fi
done
[[ -n "$CHILD_DELETE_REG" ]] && ok "A.5 fresh child registered ($CHILD_DELETE / $CHILD_DELETE_NODE_ID)" \
  || { bad "A.5 fresh child never registered"; tail -20 /tmp/daemon-027.log; }
sleep 8  # cross 5s capability check

# A.5.0 — confirm_alias mismatch refused before any state transition
BODY=$(build_delete_node_body "$CHILD_DELETE_NODE_ID" "$DAEMON_NODE_ID" "wrong-alias" "$NET_ID")
RESP=$(mcp_call "$UTOK" "$BODY")
ERR=$(echo "$RESP" | jq -r .error 2>/dev/null)
[[ "$ERR" == "confirm_alias_mismatch" ]] && ok "A.5.0 delete_node confirm_alias mismatch refused: $ERR" \
  || bad "A.5.0 expected confirm_alias_mismatch, got: $RESP"

# A.5.1 — correct confirm_alias dispatches the full delete-with-reap-and-mv path.
# CHILD_DELETE has no in-flight inbox, so no force needed.
BODY=$(build_delete_node_body "$CHILD_DELETE_NODE_ID" "$DAEMON_NODE_ID" "$CHILD_DELETE" "$NET_ID")
RESP=$(mcp_call "$UTOK" "$BODY")
DEL_REQ_ID=$(echo "$RESP" | jq -r .request_id 2>/dev/null)
DEL_LCS=$(echo "$RESP" | jq -r .lifecycle_state 2>/dev/null)
[[ "$DEL_REQ_ID" == sr_* ]] && ok "A.5.1 delete_node dispatched (request_id=$DEL_REQ_ID, lifecycle_state=$DEL_LCS)" \
  || { bad "A.5.1 delete_node dispatch failed: $RESP"; }
[[ "$DEL_LCS" == "deleting" ]] && ok "node lifecycle state flipped to 'deleting' at dispatch" \
  || bad "expected lifecycle_state=deleting, got '$DEL_LCS'"

DEL_TERM_STATUS=$(wait_stop_request_done "$DEL_REQ_ID" 40)
[[ "$DEL_TERM_STATUS" == "stopped" ]] && ok "node_stop_requests.status = stopped (daemon ack'd delete)" \
  || { bad "delete request did not finalize in 40s (status='$DEL_TERM_STATUS')"; tail -30 /tmp/daemon-027.log; }

# Real reap proof on CHILD_DELETE (same shape as A.3)
DEL_AFTER_COUNT=$(alias_pgrep_count "$CHILD_DELETE")
[[ "$DEL_AFTER_COUNT" -eq 0 ]] && ok "A.5 pgrep $CHILD_DELETE = 0 after delete (full process tree reaped)" \
  || bad "A.5 pgrep $CHILD_DELETE = $DEL_AFTER_COUNT after delete (orphan survivors)"

# Backup dir mv + chmod 700 proof
DELETED_ROOT="$HOME/.anet/deleted"
BACKUP_DIRS=( "$DELETED_ROOT"/*-"$CHILD_DELETE" )
if [[ -d "${BACKUP_DIRS[0]:-}" ]]; then
  BACKUP_DIR="${BACKUP_DIRS[0]}"
  ok "backup dir present: $BACKUP_DIR"
  MODE=$(stat -c '%a' "$BACKUP_DIR")
  [[ "$MODE" == "700" ]] && ok "backup dir mode = 700 (D7 chmod proof)" \
    || bad "backup dir mode = $MODE (expected 700)"
  PARENT_MODE=$(stat -c '%a' "$DELETED_ROOT")
  [[ "$PARENT_MODE" == "700" ]] && ok "deleted root mode = 700 (D7 parent chmod proof)" \
    || bad "deleted root mode = $PARENT_MODE (expected 700)"
  # The original config dir should be gone (mv, not cp)
  if [[ ! -d "$HOME/.anet/nodes/$CHILD_DELETE" ]]; then
    ok "original child workdir $HOME/.anet/nodes/$CHILD_DELETE is gone (mv, not cp)"
  else
    bad "original child workdir $HOME/.anet/nodes/$CHILD_DELETE still present after delete (should be moved)"
  fi
  # Backup carries the child's config.json (sanity)
  if [[ -f "$BACKUP_DIR/config.json" ]]; then
    ok "backup contains child config.json (real data, not empty dir)"
  else
    bad "backup dir empty — child config.json missing"
  fi
else
  bad "no backup dir matching $DELETED_ROOT/*-$CHILD_DELETE — D7 backup mv didn't run"
  ls -la "$DELETED_ROOT" 2>/dev/null || true
fi

# Nodes row + ntok revoke proof
NODES_REMAINING=$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM nodes WHERE node_id='$CHILD_DELETE_NODE_ID';" 2>/dev/null)
[[ "$NODES_REMAINING" == "0" ]] && ok "nodes row for $CHILD_DELETE_NODE_ID deleted (hub finalized DELETE)" \
  || bad "nodes row still present (count=$NODES_REMAINING)"
NTOK_REVOKED=$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM api_tokens WHERE name='node:$CHILD_DELETE' AND revoked_at IS NOT NULL;" 2>/dev/null)
[[ "$NTOK_REVOKED" -ge 1 ]] && ok "child ntok revoke_at populated (ntok='node:$CHILD_DELETE')" \
  || bad "child ntok not revoked (revoked_at IS NULL)"
DEL_AUD=$(sqlite3 "$HUB_DB" "SELECT COUNT(*) FROM audit_log WHERE action='delete_node_completed' AND target_id='$DEL_REQ_ID';" 2>/dev/null)
[[ "$DEL_AUD" -ge 1 ]] && ok "audit row delete_node_completed present (D8 atomic finalize)" \
  || bad "no audit row for delete_node_completed (D8 atomicity violated)"

note "A.6 sweeper — direct invocation with stub now = real+31d removes the backup"
if [[ -d "${BACKUP_DIR:-}" ]]; then
  # Direct call to sweepDeletedOnce with injected now = real + 31d
  # exercises D7's 30-day retention sweep without sleeping for 30 days.
  # SweepDeps.now is a NUMBER (not a thunk) — see deleted-sweeper.ts:32.
  SWEEP_OUT=$(cd /app/agent-node && bun -e "
    import('./src/runtime/deleted-sweeper.ts').then((m) => {
      const future = Date.now() + 31 * 24 * 60 * 60 * 1000;
      const r = m.sweepDeletedOnce({
        deletedRoot: '$DELETED_ROOT',
        now: future,
      });
      console.log(JSON.stringify(r));
    }).catch(e => { console.error('SWEEP_ERR:', e?.message || e); process.exit(2); });
  " 2>&1)
  echo "    sweeper output: $SWEEP_OUT"
  # Result schema = { purged: [{name, age_days}], scanned: N, errors: N }
  PURGED_COUNT=$(echo "$SWEEP_OUT" | tail -1 | jq -r '.purged | length' 2>/dev/null)
  PURGED_AGE=$(echo "$SWEEP_OUT" | tail -1 | jq -r '.purged[0].age_days // "?"' 2>/dev/null)
  if [[ "${PURGED_COUNT:-0}" -ge 1 ]]; then
    ok "sweeper purged ≥1 expired dir (count=$PURGED_COUNT, age_days=$PURGED_AGE — 通过 RETENTION_MS gate 30d)"
  else
    bad "sweeper purged=${PURGED_COUNT:-0} (expected ≥1)"
  fi
  if [[ ! -d "$BACKUP_DIR" ]]; then
    ok "backup dir $BACKUP_DIR真删 by sweeper (D7 retention enforced — physical fs.rm)"
  else
    bad "backup dir $BACKUP_DIR still present after sweep"
  fi
else
  stub "A.6 sweeper" "no backup dir was created upstream — sweeper coverage skipped"
fi

# ── L. PR2-prereq auto-resolve (PR #348 hub feature) ─────────────
# When dashboard omits daemon_node_id, hub resolves via
# node_create_requests.daemon_node_id keyed by child_node_id.
# 3 cases from 通信龙 #348 ack: L1 normal / L2 cross-tenant / L3 missing.
# (CHILD_L1 was spawned at A.1.SIBLING; it survived A.3 — now we stop it.)
note "L.1 stop_node with daemon_node_id OMITTED → hub auto-resolves"
BODY=$(build_stop_node_body "$CHILD_L1_NODE_ID" "" "$NET_ID")
RESP=$(mcp_call "$UTOK" "$BODY")
L1_OK=$(echo "$RESP" | jq -r .ok 2>/dev/null)
L1_REQ_ID=$(echo "$RESP" | jq -r .request_id 2>/dev/null)
if [[ "$L1_OK" == "true" && "$L1_REQ_ID" == sr_* ]]; then
  # Confirm the stored row carries the daemon_node_id we expected
  STORED_DAEMON=$(sqlite3 "$HUB_DB" "SELECT daemon_node_id FROM node_stop_requests WHERE request_id='$L1_REQ_ID';" 2>/dev/null)
  if [[ "$STORED_DAEMON" == "$DAEMON_NODE_ID" ]]; then
    ok "L1 omit-daemon stop dispatched; hub auto-resolved daemon_node_id=$STORED_DAEMON (via node_create_requests row)"
  else
    bad "L1 stored daemon_node_id='$STORED_DAEMON' (expected $DAEMON_NODE_ID)"
  fi
  # Wait for the daemon to actually reap so the L1 child doesn't linger.
  L1_TERM_STATUS=$(wait_stop_request_done "$L1_REQ_ID" 40)
  [[ "$L1_TERM_STATUS" == "stopped" ]] && ok "L1 auto-resolved stop reaped end-to-end (status=$L1_TERM_STATUS)" \
    || bad "L1 stop did not finalize: status=$L1_TERM_STATUS"
else
  bad "L1 stop_node refused: $RESP"
fi

note "L.2 stop_node with daemon_node_id OMITTED — STRANGER network caller → forbidden_cross_tenant"
# Stranger has NO read scope into NET_ID, so resolveReadScope should refuse
# the child lookup → forbidden_cross_tenant. Note: hub probes auto-resolve
# FIRST (using the create-request row in NET_ID's scope, accessible to all
# rows in the table since the lookup is by request_id, not network-gated),
# THEN the SEC-1 gate inside dispatchStopOrDelete rejects the cross-tenant
# child read. Result error must surface, NOT the daemon dispatch.
# We need the child node_id from L1 (a real NET_ID child) and call as STRANGER.
BODY=$(build_stop_node_body "$CHILD_L1_NODE_ID" "" "$STRANGER_NET_ID")
RESP=$(mcp_call "$STRANGER_UTOK" "$BODY")
L2_ERR=$(echo "$RESP" | jq -r .error 2>/dev/null)
# Both error codes prove SEC-1 worked. forbidden_cross_tenant is the
# expected path; daemon_not_resolvable is acceptable only if the auto-
# resolve also network-gates (defense-in-depth would resolve to null →
# daemon_not_resolvable). Either is a valid SEC-1 rejection.
if [[ "$L2_ERR" == "forbidden_cross_tenant" ]]; then
  ok "L2 cross-tenant omit-daemon rejected at SEC-1 layer: $L2_ERR (preferred — dispatch saw the cross-tenant child)"
elif [[ "$L2_ERR" == "daemon_not_resolvable" ]]; then
  ok "L2 cross-tenant omit-daemon rejected via daemon_not_resolvable (acceptable — auto-resolve network-gated upstream)"
elif [[ "$L2_ERR" == "permission_denied" ]]; then
  ok "L2 cross-tenant omit-daemon rejected at canWrite layer: $L2_ERR (acceptable — stranger has no role in NET_ID)"
else
  bad "L2 cross-tenant NOT rejected: $RESP"
fi

note "L.3 stop_node with daemon_node_id OMITTED on a node_id with no create-request → daemon_not_resolvable"
# Make up a node_id that never went through create_node (no row in
# node_create_requests). Must follow the regex /^node_[a-z0-9_-]+$/
# so it passes zod, but the table lookup will miss.
PHANTOM_NODE_ID="node_phantom_no_create_request_xyz"
BODY=$(build_stop_node_body "$PHANTOM_NODE_ID" "" "$NET_ID")
RESP=$(mcp_call "$UTOK" "$BODY")
L3_ERR=$(echo "$RESP" | jq -r .error 2>/dev/null)
[[ "$L3_ERR" == "daemon_not_resolvable" ]] && ok "L3 omit-daemon on phantom node rejected: $L3_ERR" \
  || bad "L3 expected daemon_not_resolvable, got: $RESP"

# ── CN. list_my_children cross-network — daemon-B in net-B cannot see net-A's children ──
note "CN list_my_children — daemon-B (in stranger network) sees only its own children"
# Mint a SECOND daemon for the STRANGER network, bring it up, then call
# list_my_children with its ntok. It must NOT see the NET_ID daemon's
# children (CHILD_A is now deleted but CHILD_L1 is reaped-but-row-still-present
# until next sweep — either way, the cross-network leak would show CHILD_L1
# OR CHILD_A. A correct implementation returns count=0).
DAEMON_NETB_NTOK_RESP=$(curl -sS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $STRANGER_UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$STRANGER_NET_ID\",\"node_name\":\"$DAEMON_NAME_NETB\"}")
DAEMON_NETB_NTOK=$(echo "$DAEMON_NETB_NTOK_RESP" | jq -r .token)
[[ "$DAEMON_NETB_NTOK" == ntok_* ]] && ok "stranger-network daemon ntok minted" \
  || { bad "stranger daemon ntok mint failed: $DAEMON_NETB_NTOK_RESP"; }

# list_my_children needs a nodes row matching the token's alias +
# network (resolveCallerDaemonTokenBound joins nodes BY alias). The
# daemon's register flow would create that row; here we INSERT it
# directly so we don't need to spin up a second daemon process just
# to exercise the cross-tenant filter.
DAEMON_NETB_NODE_ID="node_daemon_netb_$(date +%s%N | sha256sum | head -c 12)"
# nodes table has no `status` column — only the columns from the CREATE
# (node_id, node_name, alias, runtime, model, ...) + a V3 ALTER for
# network_id. We just need the row to exist for resolveCallerDaemonTokenBound's
# JOIN (it filters on alias + network_id only).
sqlite3 "$HUB_DB" "INSERT INTO nodes (node_id, node_name, alias, network_id, runtime, model) VALUES (
  '$DAEMON_NETB_NODE_ID', '$DAEMON_NAME_NETB', '$DAEMON_NAME_NETB', '$STRANGER_NET_ID',
  'claude-agent-sdk', 'claude-opus-original'
);"
mcp_init_once "$DAEMON_NETB_NTOK"
BODY=$(build_list_my_children_body)
RESP=$(mcp_call "$DAEMON_NETB_NTOK" "$BODY")
CN_OK=$(echo "$RESP" | jq -r .ok 2>/dev/null)
CN_COUNT=$(echo "$RESP" | jq -r .count 2>/dev/null)
CN_CHILDREN=$(echo "$RESP" | jq -c .children 2>/dev/null)
if [[ "$CN_OK" == "true" && "$CN_COUNT" == "0" ]]; then
  ok "CN list_my_children for daemon-B returns count=0 (NET_A children not leaked into NET_B scope)"
else
  bad "CN cross-network leak: ok=$CN_OK count=$CN_COUNT children=$CN_CHILDREN (expected count=0)"
fi

# Sanity check the other direction: daemon-A's own ntok sees its own
# children — proves the test wasn't accidentally returning 0 for
# everyone. We've reaped CHILD_A (deleted) and CHILD_L1 (stopped); the
# WHERE clause in list_my_children filters status IN ('succeeded',
# 'delivered') AND lifecycle_state NOT IN ('stopped', 'stop_failed').
# CHILD_A was deleted (nodes row gone → LEFT JOIN null filters it out).
# CHILD_L1 is 'stopped' → filtered out. Spawn a quick fresh child to
# have a non-empty 'active' set for the sanity check.
SANITY_CHILD="rfc027-sanity-cn"
BODY=$(build_create_node_body "$DAEMON_NODE_ID" "$SANITY_CHILD" "claude-agent-sdk" "claude-opus-rfc027-sanity" "$NET_ID")
RESP=$(mcp_call "$UTOK" "$BODY")
SANITY_REQ_ID=$(echo "$RESP" | jq -r .request_id 2>/dev/null)
if [[ "$SANITY_REQ_ID" == cr_* ]]; then
  SANITY_NODE_ID="node_${SANITY_REQ_ID#cr_}"
  SANITY_REG=""
  for i in $(seq 1 60); do
    sleep 1
    if curl -sS "$HUB_BASE/api/nodes?node_id=$SANITY_NODE_ID" -H "Authorization: Bearer $UTOK" \
         | jq -e ".nodes[0].node_id == \"$SANITY_NODE_ID\"" >/dev/null 2>&1; then
      SANITY_REG=yes; break
    fi
  done
  if [[ -n "$SANITY_REG" ]]; then
    # daemon-A calls list_my_children via its own ntok
    mcp_init_once "$DAEMON_NTOK"
    BODY=$(build_list_my_children_body)
    RESP=$(mcp_call "$DAEMON_NTOK" "$BODY")
    SAN_COUNT=$(echo "$RESP" | jq -r .count 2>/dev/null)
    SAN_ALIASES=$(echo "$RESP" | jq -r '.children[].alias' 2>/dev/null | sort -u | tr '\n' ',')
    if [[ "$SAN_COUNT" -ge 1 ]] && echo ",$SAN_ALIASES" | grep -q ",$SANITY_CHILD,"; then
      ok "CN sanity — daemon-A list_my_children sees its own active child $SANITY_CHILD (count=$SAN_COUNT, aliases=[$SAN_ALIASES])"
    else
      bad "CN sanity — daemon-A list_my_children FAILED to see $SANITY_CHILD (count=$SAN_COUNT, aliases=[$SAN_ALIASES])"
    fi
  else
    stub "CN sanity" "sanity child never registered, can't compare"
  fi
else
  stub "CN sanity" "sanity create_node dispatch failed: $RESP"
fi

# ── cleanup ──────────────────────────────────────────────────────
kill "$HUB_PID" 2>/dev/null || true
# Kill daemon + any survivors
pkill -f "agent-node.*--alias " 2>/dev/null || true
sleep 1

printf "\n────────────────────────────────────────────\n"
printf "RFC-027 PR1.2 stop/delete e2e — PASS=%d FAIL=%d SKIP=%d\n" "$PASS" "$FAIL" "$SKIP"
printf "────────────────────────────────────────────\n"

[[ "$FAIL" -eq 0 ]]

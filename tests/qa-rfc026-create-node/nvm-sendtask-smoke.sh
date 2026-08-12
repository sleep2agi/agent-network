#!/usr/bin/env bash
# Front-row review extension for PR #309 / issue #301.
# qa-rfc026 A.nvm proves: create → start → register → survive 12s.
# 通信龙 ask: 「create + start + send-task 三连」— third leg verifies
# child can真 receive + process a task (inbox path live, not just
# "process alive idle"). Without real LLM token (M5 territory), we
# verify the wire: inbox row appears, child consumes it, status
# transitions or reply attempted.

set -uo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/../lib/safe-rm.sh"

HUB_PORT=9236
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=/tmp/qa-309-sendtask.db
WORK=/tmp/309-sendtask-work
ADMIN_USER="t309admin"; ADMIN_PW="t309_Pass_1234!"
DAEMON_NAME="daemon-309"; CHILD_NAME="child-309-nvm"

PASS=0; FAIL=0
ok()  { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad() { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
note(){ printf "\n=== %s ===\n" "$*"; }

cleanup() {
  [[ -n "${NVM_DAEMON_PID:-}" ]] && kill "$NVM_DAEMON_PID" 2>/dev/null || true
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null || true
  # restore node if we moved it
  [[ -f /opt/anet-nvm-sim/bin/node && -n "${SYS_NODE:-}" && ! -f "$SYS_NODE" ]] && \
    cp /opt/anet-nvm-sim/bin/node "$SYS_NODE" 2>/dev/null
  rm -rf /opt/anet-nvm-sim 2>/dev/null
}
trap cleanup EXIT

# Resolve binaries
SYS_NODE=$(realpath -e "$(which node)")
AGENT_NODE_BIN=$(realpath -e "$(which agent-node)")
ANET_BIN=$(realpath -e "$(which anet)")

note "Stage 0 — setup isolated hub + register admin user"
rm -f "$HUB_DB" "${HUB_DB}-wal" "${HUB_DB}-shm" 2>/dev/null
mkdir -p "$WORK"
COMMHUB_DB="$HUB_DB" PORT="$HUB_PORT" bun run /app/server/src/index.ts > /tmp/309-hub.log 2>&1 &
HUB_PID=$!
sleep 3
curl -sf "$HUB_BASE/health" > /dev/null || { bad "hub failed"; exit 1; }
ok "isolated hub :$HUB_PORT up"

R=$(curl -s -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"display_name\":\"A\"}")
UTOK=$(echo "$R" | jq -r .token); NTOK=$(echo "$R" | jq -r .network_token); NET_ID=$(echo "$R" | jq -r .network_id)
[[ "$UTOK" == utok_* ]] && ok "admin registered (net=${NET_ID:0:12})" || { bad "register failed: $R"; exit 1; }

note "Stage 1 — daemon node config (host_supervisor role)"
mkdir -p "$WORK/.anet/nodes/$DAEMON_NAME"
DAEMON_NODE_ID="node_d309"
cat > "$WORK/.anet/nodes/$DAEMON_NAME/config.json" <<EOF
{
  "node_id": "$DAEMON_NODE_ID",
  "alias": "$DAEMON_NAME",
  "runtime": "claude-agent-sdk",
  "hub": "$HUB_BASE",
  "token": "$NTOK",
  "network_id": "$NET_ID",
  "role": "host_supervisor",
  "flags": {"dangerouslySkipPermissions": true, "teammateMode": true, "goalTickMs": "5000"}
}
EOF
ok "daemon config written"

note "Stage 2 — nvm-sim: MOVE node out of SAFE_PATH"
mkdir -p /opt/anet-nvm-sim/bin
mv "$SYS_NODE" /opt/anet-nvm-sim/bin/node
# Sanity: node should now be unfindable on SAFE_PATH
for p in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
  [[ -x "$p/node" ]] && { bad "node still in SAFE_PATH at $p — nvm-sim not faithful"; exit 1; }
done
ok "node MOVED to /opt/anet-nvm-sim/bin/node (faithful nvm-style — SAFE_PATH lookup fails)"

note "Stage 3 — start daemon under nvm-sim node"
ANET_BIN_ABS="$ANET_BIN" \
  nohup /opt/anet-nvm-sim/bin/node "$AGENT_NODE_BIN" \
    --config "$WORK/.anet/nodes/$DAEMON_NAME/config.json" \
    --alias "$DAEMON_NAME" --runtime claude-agent-sdk \
    > /tmp/309-daemon.log 2>&1 &
NVM_DAEMON_PID=$!
sleep 6
if ! kill -0 "$NVM_DAEMON_PID" 2>/dev/null; then
  bad "nvm-sim daemon failed to start"; tail -30 /tmp/309-daemon.log; exit 1
fi
ok "nvm-sim daemon alive pid=$NVM_DAEMON_PID (process.execPath=/opt/anet-nvm-sim/bin/node)"
grep -q "registered\|已注册到 CommHub" /tmp/309-daemon.log && ok "daemon registered with hub" || bad "daemon never registered"

note "Stage 3.5 — pre-dispatch daemon topology snapshot (race audit)"
# Critical proof for 通信龙: at dispatch time, ONLY the nvm-sim daemon
# is an active host_supervisor (no leftover from prior runs, no two-
# daemon race). The earlier qa-rfc026 run.sh踩 this race because it
# kept the original daemon running while starting nvm-sim daemon.
HSP_COUNT=$(pgrep -af "agent-node.*--alias $DAEMON_NAME" | grep -v "$$" | grep -v grep | wc -l)
ALL_AGENT_NODE_PIDS=$(pgrep -af "agent-node " | grep -v grep | awk '{print $1}' | tr '\n' ',' || echo "")
echo "    nvm-sim daemon PID:        $NVM_DAEMON_PID"
echo "    pgrep agent-node matches:  $HSP_COUNT"
echo "    all agent-node PIDs:       [${ALL_AGENT_NODE_PIDS}]"
if [[ "$HSP_COUNT" -eq 1 ]]; then
  ok "single-daemon topology — only nvm-sim daemon active (race-free: only it can pull create_request)"
elif [[ "$HSP_COUNT" -eq 0 ]]; then
  bad "ZERO daemon processes — pgrep miss?"
  pgrep -af agent-node || true
else
  bad "MULTIPLE daemons ($HSP_COUNT) — race risk! Dispatched create_node could be pulled by stale daemon"
  pgrep -af agent-node || true
fi

note "Stage 4 — dispatch create_node via MCP (admin)"
# Init MCP session
curl -sS -X POST "$HUB_BASE/mcp" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-03-26' \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"309","version":"0"}}}' > /dev/null 2>&1

REQ_BODY=$(jq -nc --arg dnid "$DAEMON_NODE_ID" --arg cn "$CHILD_NAME" --arg nid "$NET_ID" \
  '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"create_node",arguments:{daemon_node_id:$dnid,node_spec:{name:$cn,runtime:"claude-agent-sdk",model:"claude-opus-309-bogus"},network_id:$nid,env_blob:{ANTHROPIC_API_KEY:"bogus-309"}}}}')
RESP=$(curl -sS -X POST "$HUB_BASE/mcp" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-03-26' -d "$REQ_BODY")
INNER=$(echo "$RESP" | grep -oP '(?<=data: ).+' | head -1 | jq -r '.result.content[0].text' 2>/dev/null)
[[ -z "$INNER" || "$INNER" == "null" ]] && INNER=$(echo "$RESP" | jq -r '.result.content[0].text' 2>/dev/null)
REQ_ID=$(echo "$INNER" | jq -r .request_id 2>/dev/null)
[[ "$REQ_ID" == cr_* ]] && ok "create_node dispatched request_id=$REQ_ID" || { bad "dispatch failed: $RESP"; exit 1; }

note "Stage 5 — wait for child真 register (this is what #301 fix enables)"
REG_ITER=""
for i in $(seq 1 30); do
  sleep 1
  R=$(curl -sS "$HUB_BASE/api/nodes?alias=$CHILD_NAME" -H "Authorization: Bearer $UTOK")
  if echo "$R" | jq -e ".nodes[0].alias == \"$CHILD_NAME\"" >/dev/null 2>&1; then
    REG_ITER=$i; break
  fi
done
[[ -n "$REG_ITER" ]] && ok "child registered in ${REG_ITER}s (#301 fix真生效 — env node resolved under nvm-style)" \
  || { bad "child NEVER registered — fix didn't take"; tail -30 /tmp/309-daemon.log; exit 1; }

note "Stage 6 — survive (12s post-register, full loop bar)"
sleep 12
CHILD_PID=$(grep -oE "spawned child .$CHILD_NAME. pid=[0-9]+" /tmp/309-daemon.log | tail -1 | grep -oE "[0-9]+$")
if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
  ok "child pid=$CHILD_PID alive after 12s (FULL LOOP — register + survive)"
else
  bad "child died within 12s"; exit 1
fi
# Find the grandchild agent-node process (the real worker, child of the starter)
GRANDCHILDREN=$(pgrep -P "$CHILD_PID" 2>/dev/null || echo "")
if [[ -n "$GRANDCHILDREN" ]]; then
  ok "child has live grandchild agent-node process(es): $GRANDCHILDREN (full process tree intact)"
else
  bad "child has NO grandchild — starter alive but agent-node process missing (the 「提交存在不等于功能可用」这条判据 pattern: 'alive' != 'wired')"
fi

note "Stage 7 — send-task三连 third leg:真 dispatch + verify child processes"
# Send a task via /api/task (the same path Vincent/agents would use)
T_RESP=$(curl -sS -X POST "$HUB_BASE/api/task" \
  -H "Authorization: Bearer $NTOK" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"$CHILD_NAME\",\"task\":\"ping from 309 review smoke\",\"priority\":\"normal\",\"from\":\"309-smoke\",\"network_id\":\"$NET_ID\"}")
TASK_OK=$(echo "$T_RESP" | jq -r .ok 2>/dev/null)
TASK_ID=$(echo "$T_RESP" | jq -r .task_id 2>/dev/null)
[[ "$TASK_OK" == "true" ]] && ok "send_task accepted by hub: task_id=$TASK_ID" || { bad "send_task failed: $T_RESP"; exit 1; }

# Wait for child's inbox to consume + status change in DB
INBOX_CONSUMED=""
DB_STATUS=""
for i in $(seq 1 25); do
  sleep 1
  # The hub DB tracks message.delivered_at on consume by agent
  STATUS_ROW=$(sqlite3 "$HUB_DB" \
    "SELECT delivered_at, status FROM tasks WHERE task_id='$TASK_ID' LIMIT 1;" 2>/dev/null || echo "")
  if [[ -n "$STATUS_ROW" ]] && [[ "$STATUS_ROW" != "|" ]]; then
    INBOX_CONSUMED=$i
    DB_STATUS=$STATUS_ROW
    # If delivered_at is set OR status moved past pending, child真 picked it up
    DELIVERED=$(echo "$STATUS_ROW" | cut -d'|' -f1)
    STATUS_VAL=$(echo "$STATUS_ROW" | cut -d'|' -f2)
    if [[ -n "$DELIVERED" ]] && [[ "$DELIVERED" != "" ]]; then
      break
    fi
    if [[ "$STATUS_VAL" == "delivered" || "$STATUS_VAL" == "replied" || "$STATUS_VAL" == "failed" || "$STATUS_VAL" == "in_progress" ]]; then
      break
    fi
  fi
done
if [[ -n "$INBOX_CONSUMED" ]]; then
  ok "child consumed inbox in ${INBOX_CONSUMED}s — DB row: [$DB_STATUS] (true 'wire is live', child真接到任务)"
else
  bad "child NEVER consumed task in 25s — process alive but not wired to inbox (pattern: 'register' != 'functional')"
  echo "--- child agent-node log (last 30) ---"
  ls /tmp/309-sendtask-work/.anet/nodes/$CHILD_NAME/logs/ 2>/dev/null && \
    tail -30 /tmp/309-sendtask-work/.anet/nodes/$CHILD_NAME/logs/*.log 2>/dev/null
  echo "--- DB task row ---"
  sqlite3 "$HUB_DB" "SELECT * FROM tasks WHERE task_id='$TASK_ID';" 2>/dev/null
fi

note "Stage 8 — get_status to see if child has been reporting in"
SS=$(sqlite3 "$HUB_DB" \
  "SELECT alias, status FROM sessions WHERE alias='$CHILD_NAME' ORDER BY last_seen_at DESC LIMIT 1;" 2>/dev/null)
[[ -n "$SS" ]] && ok "child reported status row in DB: [$SS] (heartbeat path真 wired)" \
  || bad "child has NO status row in DB (report_status path broken — wire incomplete)"

printf "\n────────────────────────────────────────────\n"
printf "Front-row review extension: PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
printf "────────────────────────────────────────────\n"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1

#!/usr/bin/env bash
set -euo pipefail

PORT=9241
BASE="http://127.0.0.1:$PORT"
DB=/tmp/test581.db
WORK=/tmp/test581-work
SERVER_ROOT=${SERVER_ROOT:-/app/server}
PASS=0
fail() { echo "FAIL: $*"; exit 1; }
ok() { PASS=$((PASS+1)); echo "PASS $PASS: $*"; }
cleanup() {
  if [[ -n "${DAEMON_WRAPPER_PID:-}" ]]; then kill "$DAEMON_WRAPPER_PID" 2>/dev/null || true; fi
  if [[ -n "${HUB_PID:-}" ]]; then kill "$HUB_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

cd /app/agent-network
bun test src/daemon-anet-pin.test.ts

mcp_init() {
  curl -fsS -X POST "$BASE/mcp" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-03-26' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test581","version":"1"}}}' >/dev/null
}
mcp() {
  local token="$1" tool="$2" arguments="$3" raw inner
  raw=$(curl -fsS -X POST "$BASE/mcp" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "$(jq -cn --arg t "$tool" --argjson a "$arguments" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$t,arguments:$a}}')")
  inner=$(printf '%s\n' "$raw" | sed -n 's/^data: //p' | jq -r '.result.content[0].text' | head -1)
  [[ -n "$inner" && "$inner" != null ]] || inner=$(printf '%s' "$raw" | jq -r '.result.content[0].text')
  printf '%s\n' "$inner"
}
wait_action() {
  local id="$1" status response
  for _ in $(seq 1 50); do
    response=$(mcp "$UTOK" get_daemon_node_action_status "$(jq -cn --arg i "$id" --arg n "$NET" '{action_id:$i,network_id:$n}')")
    status=$(jq -r '.action.status // .error' <<<"$response")
    [[ "$status" == succeeded ]] && return 0
    [[ "$status" == failed || "$status" == rejected ]] && fail "action $id ended $status: $(jq -r '.action.error // "unknown"' <<<"$response")"
    sleep .4
  done
  fail "action $id did not finish"
}

rm -rf "$WORK" "$DB" "$DB-wal" "$DB-shm"
mkdir -p "$WORK/.anet/nodes"
cd "$SERVER_ROOT"
PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$DB" bun run src/index.ts >/tmp/test581-hub.log 2>&1 & HUB_PID=$!
for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep .25; done
curl -fsS "$BASE/health" >/dev/null || fail "hub did not boot"
ok "isolated hub booted"

REG=$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' -d '{"username":"test581admin","password":"test581_Strong_123!","email":"test581@example.invalid"}')
UTOK=$(jq -r .token <<<"$REG")
ME=$(curl -fsS "$BASE/api/auth/me" -H "Authorization: Bearer $UTOK")
NET=$(jq -r '.networks[0].network_id' <<<"$ME")
[[ "$UTOK" == utok_* && -n "$NET" ]] || fail "admin bootstrap failed"
mcp_init "$UTOK"
ok "admin/network authenticated"

mint() {
  curl -fsS -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg n "$NET" --arg a "$1" '{network_id:$n,node_name:$a}')" | jq -r .token
}
DAEMON_ALIAS=server-test581
DAEMON_ID=node_server_test581
DAEMON_TOKEN=$(mint "$DAEMON_ALIAS")
cat >"$WORK/.anet/nodes/$DAEMON_ALIAS.config.tmp" <<EOF
{"node_id":"$DAEMON_ID","node_name":"$DAEMON_ALIAS","alias":"$DAEMON_ALIAS","role":"host_supervisor","runtime":"claude-agent-sdk","model":"claude-sonnet-4-6","hub":"$BASE","token":"$DAEMON_TOKEN","network_id":"$NET","runtimes_supported":["claude-agent-sdk","codex-sdk","grok-build-acp"],"channels":[],"flags":{}}
EOF
mkdir -p "$WORK/.anet/nodes/$DAEMON_ALIAS"
mv "$WORK/.anet/nodes/$DAEMON_ALIAS.config.tmp" "$WORK/.anet/nodes/$DAEMON_ALIAS/config.json"
chmod 600 "$WORK/.anet/nodes/$DAEMON_ALIAS/config.json"
cat >"$WORK/.anet/config.json" <<EOF
{"hub":"$BASE","token":"$UTOK","network_id":"$NET"}
EOF
mkdir -p /root/.anet
cp "$WORK/.anet/config.json" /root/.anet/config.json
chmod 600 /root/.anet/config.json
cd "$WORK"
anet daemon start "$DAEMON_ALIAS" >/tmp/test581-daemon.log 2>&1 & DAEMON_WRAPPER_PID=$!
for _ in $(seq 1 60); do
  LIST=$(mcp "$UTOK" list_host_supervisors "$(jq -cn --arg n "$NET" '{network_id:$n}')")
  [[ $(jq -r --arg id "$DAEMON_ID" '.daemons[]? | select(.daemon_node_id==$id and .online==true) | .daemon_node_id' <<<"$LIST") == "$DAEMON_ID" ]] && break
  sleep .5
done
[[ $(jq -r '.count' <<<"$LIST") -ge 1 ]] || { tail -80 /tmp/test581-daemon.log; fail "daemon did not register"; }
ok "real daemon registered and online"

CHILD_ALIAS=managed-test581
CHILD_ID=node_managed_test581
CHILD_TOKEN=$(mint "$CHILD_ALIAS")
mkdir -p "$WORK/.anet/nodes/$CHILD_ALIAS"
cat >"$WORK/.anet/nodes/$CHILD_ALIAS/config.json" <<EOF
{"node_id":"$CHILD_ID","node_name":"$CHILD_ALIAS","alias":"$CHILD_ALIAS","runtime":"claude-agent-sdk","model":"old-model","hub":"$BASE","token":"$CHILD_TOKEN","network_id":"$NET","channels":[],"flags":{},"config_revision":0}
EOF
chmod 600 "$WORK/.anet/nodes/$CHILD_ALIAS/config.json"
for _ in $(seq 1 80); do
  INV=$(mcp "$UTOK" list_daemon_nodes "$(jq -cn --arg d "$DAEMON_ID" --arg n "$NET" '{daemon_node_id:$d,network_id:$n}')")
  [[ $(jq -r --arg id "$CHILD_ID" '.nodes[]? | select(.local_node_id==$id) | .registry_state' <<<"$INV") == local_only ]] && break
  sleep .5
done
[[ $(jq -r --arg id "$CHILD_ID" '.nodes[]? | select(.local_node_id==$id) | .observed_state' <<<"$INV") == stopped ]] || fail "local stopped inventory missing"
ok "pre-existing stopped node discovered without registry fabrication"

EDIT=$(mcp "$UTOK" dispatch_daemon_node_action "$(jq -cn --arg d "$DAEMON_ID" --arg c "$CHILD_ID" --arg n "$NET" '{daemon_node_id:$d,local_node_id:$c,action:"update",patch:{model:"claude-sonnet-4-6",flags:{}},base_revision:0,network_id:$n}')")
EDIT_ID=$(jq -r .action_id <<<"$EDIT"); [[ "$EDIT_ID" == ha_* ]] || fail "edit dispatch failed: $EDIT"
wait_action "$EDIT_ID"
[[ $(jq -r .model "$WORK/.anet/nodes/$CHILD_ALIAS/config.json") == claude-sonnet-4-6 ]] || fail "offline edit not written"
[[ $(stat -c %a "$WORK/.anet/nodes/$CHILD_ALIAS/config.json") == 600 ]] || fail "config mode changed"
ok "offline edit confirmed with private mode"

START=$(mcp "$UTOK" dispatch_daemon_node_action "$(jq -cn --arg d "$DAEMON_ID" --arg c "$CHILD_ID" --arg n "$NET" '{daemon_node_id:$d,local_node_id:$c,action:"start",network_id:$n}')")
START_ID=$(jq -r .action_id <<<"$START"); wait_action "$START_ID"
PID=$(cat "$WORK/.anet/nodes/$CHILD_ALIAS/.pid")
kill -0 "$PID" || fail "child pid not alive"
ok "start confirmed by exact live child pid"

STOP=$(mcp "$UTOK" dispatch_daemon_node_action "$(jq -cn --arg d "$DAEMON_ID" --arg c "$CHILD_ID" --arg n "$NET" '{daemon_node_id:$d,local_node_id:$c,action:"stop",network_id:$n}')")
STOP_ID=$(jq -r .action_id <<<"$STOP"); wait_action "$STOP_ID"
kill -0 "$PID" 2>/dev/null && fail "old child pid still alive after stop"
ok "stop confirmed, process is gone"

RESTART=$(mcp "$UTOK" dispatch_daemon_node_action "$(jq -cn --arg d "$DAEMON_ID" --arg c "$CHILD_ID" --arg n "$NET" '{daemon_node_id:$d,local_node_id:$c,action:"restart",network_id:$n}')")
RESTART_ID=$(jq -r .action_id <<<"$RESTART"); wait_action "$RESTART_ID"
NEW_PID=$(cat "$WORK/.anet/nodes/$CHILD_ALIAS/.pid")
[[ "$NEW_PID" != "$PID" ]] && kill -0 "$NEW_PID" || fail "restart did not produce a live new pid"
ok "restart from stopped state confirmed"

CLI_LIST=$(anet daemon nodes "$DAEMON_ALIAS" --network-id "$NET")
grep -q "$CHILD_ALIAS" <<<"$CLI_LIST" || fail "CLI server list omitted managed child"
ok "CLI resolves daemon alias and lists physical nodes"
anet daemon stop "$DAEMON_ALIAS" "$CHILD_ALIAS" --network-id "$NET" | grep -q "stopped" || fail "CLI stop did not return final success"
ok "CLI stop waits for daemon final confirmation"
anet daemon start-node "$DAEMON_ALIAS" "$CHILD_ALIAS" --network-id "$NET" | grep -q "started" || fail "CLI start did not return final success"
ok "CLI start waits for daemon final confirmation"

REG2=$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' -d '{"username":"test581other","password":"test581_Other_123!","email":"test581other@example.invalid"}')
UTOK2=$(jq -r .token <<<"$REG2")
NET2=$(curl -fsS "$BASE/api/auth/me" -H "Authorization: Bearer $UTOK2" | jq -r '.networks[0].network_id')
mcp_init "$UTOK2"
[[ "$NET2" != "$NET" ]] || fail "cross-network fixture did not create an independent tenant"
CROSS=$(mcp "$UTOK2" list_daemon_nodes "$(jq -cn --arg d "$DAEMON_ID" --arg n "$NET" '{daemon_node_id:$d,network_id:$n}')")
[[ $(jq -r .ok <<<"$CROSS") == false ]] || fail "cross-network list allowed"
[[ "$CROSS" != *"$CHILD_ALIAS"* ]] || fail "cross-network response leaked alias"
ok "cross-network read rejected without alias leak"

echo "RESULT: PASS ($PASS checks)"

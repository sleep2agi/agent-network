#!/usr/bin/env bash
set -Eeuo pipefail

PORT=19210
BASE="http://127.0.0.1:${PORT}"
DB=/tmp/test1210.db
LOG=/tmp/test1210-hub.log
rm -f "$DB" "$LOG"

cleanup() {
  set +e
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" >/dev/null 2>&1
  [[ -n "${HUB_PID:-}" ]] && wait "$HUB_PID" >/dev/null 2>&1
}
trap cleanup EXIT

post() {
  local path="$1" token="$2" body="$3"
  curl -sS -X POST "$BASE$path" -H 'Content-Type: application/json' \
    ${token:+-H "Authorization: Bearer $token"} -d "$body"
}

mcp() {
  local token="$1" tool="$2" args="$3"
  jq -nc --arg tool "$tool" --argjson args "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$tool,arguments:$args}}' \
    | curl -sS -X POST "$BASE/mcp" -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -H 'MCP-Protocol-Version: 2025-03-26' --data-binary @- \
    | sed -n 's/^data: //p' | head -1 | jq -r '.result.content[0].text // empty'
}

register_user() {
  local username="$1"
  post /api/auth/register '' "{\"username\":\"$username\",\"password\":\"StrongPassw0rd!\"}"
}

create_network() {
  local token="$1" name="$2"
  post /api/networks "$token" "{\"name\":\"$name\"}" | jq -r '.network_id'
}

register_node() {
  local user_token="$1" network_id="$2" alias="$3" node_id="$4" status="${5:-idle}"
  local node_token args
  node_token=$(post /api/auth/node-token "$user_token" \
    "{\"network_id\":\"$network_id\",\"node_name\":\"$alias\"}" | jq -r '.token')
  args=$(jq -nc --arg net "$network_id" --arg alias "$alias" --arg node "$node_id" --arg status "$status" \
    '{resume_id:("resume-"+$node),alias:$alias,node_id:$node,node_name:$alias,status:$status,network_id:$net}')
  mcp "$node_token" report_status "$args" | jq -e '.ok == true' >/dev/null
  printf '%s' "$node_token"
}

echo '[0] environment -> authenticated Hub'
(
  cd /app/server
  HOST=127.0.0.1 PORT="$PORT" COMMHUB_DB="$DB" COMMHUB_AUTH_TOKEN=test1210 bun run src/index.ts
) >"$LOG" 2>&1 &
HUB_PID=$!
for _ in $(seq 1 60); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/health" >/dev/null

OWNER=$(register_user owner1210)
OWNER_TOKEN=$(jq -r '.token' <<<"$OWNER")
NET_A=$(jq -r '.network_id' <<<"$OWNER")
NET_B=$(create_network "$OWNER_TOKEN" net-b-1210)
OUTSIDER=$(register_user outsider1210)
OUTSIDER_TOKEN=$(jq -r '.token' <<<"$OUTSIDER")

NODE_A_TOKEN=$(register_node "$OWNER_TOKEN" "$NET_A" shared-agent node-a-1210 idle)
register_node "$OWNER_TOKEN" "$NET_B" shared-agent node-b-1210 idle >/dev/null
register_node "$OWNER_TOKEN" "$NET_A" offline-agent node-offline-1210 offline >/dev/null

echo '[1] REST success returns the scoped canonical actual target'
REST_A=$(post /api/task "$OWNER_TOKEN" "{\"alias\":\"shared-agent\",\"task\":\"rest a\",\"network_id\":\"$NET_A\"}")
jq -e --arg net "$NET_A" '.ok == true and .actual_to == {alias:"shared-agent",to_node_id:"node-a-1210",network_id:$net}' <<<"$REST_A" >/dev/null

REST_B=$(post /api/task "$OWNER_TOKEN" "{\"alias\":\"shared-agent\",\"task\":\"rest b\",\"network_id\":\"$NET_B\"}")
jq -e --arg net "$NET_B" '.ok == true and .actual_to == {alias:"shared-agent",to_node_id:"node-b-1210",network_id:$net}' <<<"$REST_B" >/dev/null

echo '[2] MCP success has exactly the same actual_to shape'
MCP_A=$(mcp "$NODE_A_TOKEN" send_task "$(jq -nc --arg net "$NET_A" '{alias:"shared-agent",task:"mcp a",network_id:$net,from_session:"shared-agent"}')")
jq -e --arg net "$NET_A" '.ok == true and .actual_to == {alias:"shared-agent",to_node_id:"node-a-1210",network_id:$net}' <<<"$MCP_A" >/dev/null

IDEM_ARGS=$(jq -nc --arg net "$NET_A" '{alias:"shared-agent",task:"idempotent mcp",network_id:$net,from_session:"shared-agent",meta:{client_request_id:"dreq_test1210_retry_0001"}}')
IDEM_FIRST=$(mcp "$NODE_A_TOKEN" send_task "$IDEM_ARGS")
IDEM_REPLAY=$(mcp "$NODE_A_TOKEN" send_task "$IDEM_ARGS")
jq -e --arg net "$NET_A" '.ok == true and .idempotent_replay == true and .actual_to == {alias:"shared-agent",to_node_id:"node-a-1210",network_id:$net}' <<<"$IDEM_REPLAY" >/dev/null
[[ "$(jq -r '.message_id' <<<"$IDEM_FIRST")" == "$(jq -r '.message_id' <<<"$IDEM_REPLAY")" ]]

echo '[3] rename resolves actual alias while preserving compatibility fields'
PREP=$(post /api/node-rename/prepare "$OWNER_TOKEN" "{\"network_id\":\"$NET_A\",\"old_alias\":\"shared-agent\",\"new_alias\":\"canonical-agent\"}")
TXN=$(jq -r '.txn_id' <<<"$PREP")
post /api/node-rename/commit "$OWNER_TOKEN" "{\"txn_id\":\"$TXN\"}" | jq -e '.ok == true' >/dev/null
RENAMED=$(post /api/task "$OWNER_TOKEN" "{\"alias\":\"shared-agent\",\"task\":\"renamed rest\",\"network_id\":\"$NET_A\"}")
jq -e --arg net "$NET_A" '.renamed_from == "shared-agent" and .renamed_to == "canonical-agent" and .actual_to == {alias:"canonical-agent",to_node_id:"node-a-1210",network_id:$net}' <<<"$RENAMED" >/dev/null

echo '[4] offline queued response still identifies the durable target'
OFF_REST=$(post /api/task "$OWNER_TOKEN" "{\"alias\":\"offline-agent\",\"task\":\"queued rest\",\"network_id\":\"$NET_A\"}")
jq -e --arg net "$NET_A" '.ok == false and .queued == true and .error == "alias_offline" and .actual_to == {alias:"offline-agent",to_node_id:"node-offline-1210",network_id:$net}' <<<"$OFF_REST" >/dev/null
OFF_MCP=$(mcp "$NODE_A_TOKEN" send_task "$(jq -nc --arg net "$NET_A" '{alias:"offline-agent",task:"queued mcp",network_id:$net,from_session:"canonical-agent"}')")
jq -e --arg net "$NET_A" '.ok == false and .queued == true and .error == "alias_offline" and .actual_to == {alias:"offline-agent",to_node_id:"node-offline-1210",network_id:$net}' <<<"$OFF_MCP" >/dev/null

echo '[5] not-found and cross-network denial disclose no target identity'
MISSING=$(post /api/task "$OWNER_TOKEN" "{\"alias\":\"ghost-1210\",\"task\":\"missing\",\"network_id\":\"$NET_A\"}")
jq -e '(.error == "alias_not_found") and (has("actual_to") | not) and (has("to_node_id") | not)' <<<"$MISSING" >/dev/null

HTTP=$(curl -sS -o /tmp/denied.json -w '%{http_code}' -X POST "$BASE/api/task" \
  -H "Authorization: Bearer $OUTSIDER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"alias\":\"canonical-agent\",\"task\":\"denied\",\"network_id\":\"$NET_A\"}")
[[ "$HTTP" == 403 ]]
jq -e '(has("actual_to") | not) and (tostring | contains("node-a-1210") | not) and (tostring | contains("canonical-agent") | not)' /tmp/denied.json >/dev/null

echo 'PASS test1210 actual target contract'

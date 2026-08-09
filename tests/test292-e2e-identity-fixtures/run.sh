#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
BASE=http://127.0.0.1:9200
WORK=/tmp/test292-identity
SERVER_LOG=$WORK/server.log

pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }

cleanup() {
  kill "${SERVER_PID:-}" 2>/dev/null || true
  wait "${SERVER_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

source /app/lib/response-json.sh
source /app/lib/e2e-agent-bootstrap.sh

mkdir -p "$WORK/home" "$WORK/project"
export HOME=$WORK/home
cd "$WORK/project"

COMMHUB_DB_PATH=$WORK/commhub.db bun run /app/server/src/index.ts >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "$BASE/health" >/dev/null
pass "environment: real Hub is healthy"

REGISTER=$(curl -fsS -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"identity-owner","password":"identity-pass-123"}')
OWNER_TOKEN=$(printf '%s' "$REGISTER" | jq -r '.token // empty')
[[ $OWNER_TOKEN == utok_* ]]
NETWORK=$(curl -fsS -X POST "$BASE/api/networks" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"identity-network"}')
NETWORK_ID=$(printf '%s' "$NETWORK" | jq -r '.network_id // empty')
[[ -n $NETWORK_ID ]]
anet login --hub "$BASE" --username identity-owner --password identity-pass-123 >/dev/null
e2e_select_network "$NETWORK_ID"
pass "auth: owner selected one explicit network"

e2e_create_agent sim-a codex-sdk gpt-5.4 "$NETWORK_ID"
CONFIG=$(e2e_agent_config_path sim-a)
NODE_ID=$(jq -r '.node_id' "$CONFIG")
if e2e_config_token_bound_to_network "$CONFIG" "$NETWORK_ID"; then
  pass "fixture: public CLI created stable node_id + Hub-bound ntok"
else
  fail "fixture: generated identity is not authoritative"
fi

REPORT=$(e2e_agent_mcp_call sim-a report_status \
  '{"resume_id":"identity-sim-a","alias":"forged-alias","status":"idle","server":"test"}')
if response_json_ok "$REPORT"; then
  pass "identity: helper reports only its config-bound alias"
else
  printf '%s\n' "$REPORT" >&2
  fail "identity: token-bound report_status failed"
fi

STATUS=$(curl -fsS "$BASE/api/status" -H "Authorization: Bearer $OWNER_TOKEN")
printf '%s' "$STATUS" | e2e_status_has_alias sim-a \
  && pass "identity: exact session alias registered" \
  || fail "identity: exact session alias missing"
if printf '%s' "$STATUS" | e2e_status_has_alias forged-alias; then
  fail "identity: caller-supplied forged alias escaped helper"
else
  pass "identity: forged alias cannot escape config binding"
fi

NODES=$(curl -fsS "$BASE/api/nodes" -H "Authorization: Bearer $OWNER_TOKEN")
if printf '%s' "$NODES" | jq -e --arg node_id "$NODE_ID" --arg alias sim-a \
  '.nodes | any(.node_id == $node_id and .alias == $alias)' >/dev/null; then
  pass "identity: inventory stores the exact stable node_id"
else
  fail "identity: inventory omitted or changed stable node_id"
fi

FORGED_USER=$(timeout 5 curl -fsS -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"report_status","arguments":{"resume_id":"forged-user","alias":"user-forged","status":"idle"}}}')
if response_json_error_is "$FORGED_USER" network_token_required; then
  pass "security: user token cannot impersonate a fixture agent"
else
  printf '%s\n' "$FORGED_USER" >&2
  fail "security: user-token report_status did not fail closed"
fi

SEND=$(timeout 5 curl -fsS -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"send_task\",\"arguments\":{\"alias\":\"sim-a\",\"task\":\"identity lifecycle\",\"network_id\":\"$NETWORK_ID\"}}}")
TASK_ID=$(printf '%s' "$SEND" | python3 -c '
import json,sys
raw=sys.stdin.read()
for line in raw.splitlines():
    if line.startswith("data: "): raw=line[6:]
outer=json.loads(raw)
inner=json.loads(outer["result"]["content"][0]["text"])
print(inner.get("message_id", ""))
')
[[ -n $TASK_ID ]]
INBOX=$(e2e_agent_mcp_call sim-a get_inbox '{"alias":"sim-a","limit":5}')
printf '%s' "$INBOX" | grep -Fq 'identity lifecycle' \
  && pass "lifecycle: ntok fixture reads its inbox" \
  || fail "lifecycle: fixture inbox is empty"
ACK=$(e2e_agent_mcp_call sim-a ack_inbox "{\"alias\":\"sim-a\",\"message_id\":\"$TASK_ID\"}")
response_json_ok "$ACK" \
  && pass "lifecycle: ntok fixture acknowledges its task" \
  || fail "lifecycle: fixture ack failed"
REPLY=$(e2e_agent_mcp_call sim-a send_reply \
  "{\"alias\":\"identity-owner\",\"text\":\"done\",\"in_reply_to\":\"$TASK_ID\",\"status\":\"replied\",\"from_session\":\"sim-a\"}")
response_json_ok "$REPLY" \
  && pass "lifecycle: ntok fixture terminates its task" \
  || fail "lifecycle: fixture reply failed"
TASK=$(curl -fsS "$BASE/api/tasks?task_id=$TASK_ID" -H "Authorization: Bearer $OWNER_TOKEN")
printf '%s' "$TASK" | jq -e '.tasks[0] | .status == "replied" and .result == "done"' >/dev/null \
  && pass "lifecycle: terminal result persisted" \
  || fail "lifecycle: terminal result mismatch"

grep -Fq 'e2e_agent_mcp_call "conc-$i" "report_status"' /app/test.sh \
  && grep -Fq 'e2e_agent_mcp_call mock-agent ack_inbox' /app/test.sh \
  && grep -Fq 'e2e_agent_mcp_call stop-verify report_status' /app/test.sh \
  && pass "aggregate: simulated identity paths use token-bound fixtures" \
  || fail "aggregate: one or more identity paths still use the owner token"

echo "RESULT: $PASS passed, $FAIL failed"
echo "source_commit=${TEST292_IDENTITY_SOURCE_COMMIT:-unknown}"
[[ $FAIL -eq 0 ]]

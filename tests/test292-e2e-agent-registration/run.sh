#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
BASE=http://127.0.0.1:9200
WORK=/tmp/test292-layer2
HELPER=/app/lib/e2e-agent-bootstrap.sh
NODE_LOG=$WORK/e2e-agent.log
SERVER_LOG=$WORK/server.log

pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }

cleanup() {
  kill "${AGENT_PID:-}" 2>/dev/null || true
  wait "${AGENT_PID:-}" 2>/dev/null || true
  kill "${SERVER_PID:-}" 2>/dev/null || true
  wait "${SERVER_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

if [[ ! -f "$HELPER" ]]; then
  fail "e2e agent bootstrap helper is missing"
  fail "docker-e2e cannot select the network and pre-create a token-bound agent"
  echo "RESULT: $PASS passed, $FAIL failed"
  echo "source_commit=$TEST292_L2_SOURCE_COMMIT"
  exit 1
fi

source "$HELPER"
source /app/lib/response-json.sh

mkdir -p "$WORK/home" "$WORK/project"
export HOME=$WORK/home
cd "$WORK/project"

COMMHUB_DB_PATH=$WORK/commhub.db bun run /app/server/src/index.ts >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.2
done
if curl -fsS "$BASE/health" >/dev/null 2>&1; then
  pass "environment: real Hub is healthy"
else
  cat "$SERVER_LOG" >&2
  fail "environment: Hub did not become healthy"
  exit 1
fi

REG=$(curl -fsS -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"layer2-owner","password":"layer2-pass-123"}')
TOKEN=$(printf '%s' "$REG" | jq -r '.token // empty')
if [[ $TOKEN == utok_* ]]; then
  pass "auth: bootstrap user token issued"
else
  fail "auth: bootstrap user token missing"
  exit 1
fi

NET=$(curl -fsS -X POST "$BASE/api/networks" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"layer2-target","description":"test292 target"}')
NETWORK_ID=$(printf '%s' "$NET" | jq -r '.network_id // empty')
WRONG=$(curl -fsS -X POST "$BASE/api/networks" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"layer2-wrong","description":"mutation control"}')
WRONG_NETWORK_ID=$(printf '%s' "$WRONG" | jq -r '.network_id // empty')
if [[ -n $NETWORK_ID && -n $WRONG_NETWORK_ID && $NETWORK_ID != "$WRONG_NETWORK_ID" ]]; then
  pass "auth: two isolated networks created"
else
  fail "auth: network setup failed"
  exit 1
fi

anet login --hub "$BASE" --username layer2-owner --password layer2-pass-123 >/dev/null
e2e_select_network "$NETWORK_ID"
e2e_create_agent e2e-agent codex-sdk gpt-5.4 "$NETWORK_ID"
CFG=$WORK/project/.anet/nodes/e2e-agent/config.json

if e2e_config_token_bound_to_network "$CFG" "$NETWORK_ID"; then
  pass "single point: generated ntok is bound by Hub to selected network"
else
  jq '{node_id,token:(.token|if type=="string" then (.[0:5]+"…") else . end)}' "$CFG" >&2 || true
  fail "single point: generated token is not Hub-bound to selected network"
  exit 1
fi

timeout 25 agent-node --config "$CFG" --alias e2e-agent --runtime codex-sdk >"$NODE_LOG" 2>&1 &
AGENT_PID=$!
REGISTERED=0
for _ in $(seq 1 40); do
  STATUS=$(curl -fsS "$BASE/api/status" -H "Authorization: Bearer $TOKEN" 2>/dev/null || true)
  if printf '%s' "$STATUS" | e2e_status_has_alias e2e-agent; then
    REGISTERED=1
    break
  fi
  sleep 0.25
done
if [[ $REGISTERED == 1 ]]; then
  pass "complete flow: agent registered under the exact alias"
else
  cat "$NODE_LOG" >&2
  fail "complete flow: agent did not register"
  exit 1
fi

MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test292","version":"1"}}}'
curl -fsS -X POST "$BASE/mcp" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "$MCP_INIT" >/dev/null
SEND=$(curl -fsS -X POST "$BASE/mcp" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"send_task\",\"arguments\":{\"alias\":\"e2e-agent\",\"task\":\"layer2 delivery\",\"network_id\":\"$NETWORK_ID\"}}}")
if response_json_ok "$SEND"; then
  pass "complete flow: alias-targeted send_task is routable"
else
  printf '%s\n' "$SEND" >&2
  fail "complete flow: send_task was rejected"
fi

# Mutation 1: deleting the explicit network selection must create the node in
# the deliberately selected wrong network, never silently pass.
MUT1=$WORK/helper-no-select.sh
cp "$HELPER" "$MUT1"
sed -i '/anet network use "\$network_id"/d' "$MUT1"
anet network use "$WRONG_NETWORK_ID" >/dev/null
set +e
(
  source "$MUT1"
  e2e_select_network "$NETWORK_ID"
  e2e_create_agent mut-no-select codex-sdk gpt-5.4 "$NETWORK_ID"
) >/dev/null 2>&1
MUT1_RC=$?
set -e
MUT1_CFG=$WORK/project/.anet/nodes/mut-no-select/config.json
if [[ $MUT1_RC -ne 0 ]] && \
   e2e_config_token_bound_to_network "$MUT1_CFG" "$WRONG_NETWORK_ID"; then
  pass "mutation: deleting network selection turns red"
else
  fail "mutation: missing network selection was not proven bound to the wrong network"
fi

# Mutation 2: deleting the official node creation must fail before agent start.
MUT2=$WORK/helper-no-create.sh
cp "$HELPER" "$MUT2"
sed -i '/anet node create "\$alias"/d' "$MUT2"
anet network use "$NETWORK_ID" >/dev/null
set +e
(
  source "$MUT2"
  e2e_create_agent mut-no-create codex-sdk gpt-5.4 "$NETWORK_ID"
) >/dev/null 2>&1
MUT2_RC=$?
set -e
if [[ $MUT2_RC -ne 0 && ! -f $WORK/project/.anet/nodes/mut-no-create/config.json ]]; then
  pass "mutation: deleting token-bound node creation turns red"
else
  fail "mutation: missing node creation did not fail closed"
fi

# Mutation 3: weakening exact alias equality must accept the wrong session and
# therefore be caught by this fixture.
MUT3=$WORK/helper-weak-alias.sh
cp "$HELPER" "$MUT3"
sed -i 's/s.get("alias") == alias/s.get("alias") is not None/' "$MUT3"
if cmp -s "$HELPER" "$MUT3"; then
  fail "mutation: alias predicate anchor did not match"
else
  set +e
  printf '%s' '{"sessions":[{"alias":"not-e2e-agent"}]}' | \
    bash -c 'source "$1"; e2e_status_has_alias e2e-agent' _ "$MUT3"
  MUT3_RC=$?
  set -e
  if [[ $MUT3_RC -eq 0 ]]; then
    pass "mutation: weakening exact alias check turns red"
  else
    fail "mutation: weakened alias checker did not exercise the fixture"
  fi
fi

if grep -Fq 'e2e_select_network "$NETWORK_ID"' /app/test.sh && \
   grep -Fq 'e2e_create_agent e2e-agent' /app/test.sh && \
   grep -Fq 'e2e_status_has_alias e2e-agent' /app/test.sh; then
  pass "aggregate wiring: docker-e2e uses all three Layer 2 gates"
else
  fail "aggregate wiring: one or more Layer 2 gates are not wired"
fi

echo "RESULT: $PASS passed, $FAIL failed"
echo "source_commit=$TEST292_L2_SOURCE_COMMIT"
[[ $FAIL -eq 0 ]]

#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
BASE=http://127.0.0.1:9200
WORK=/tmp/test292-rename

pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }

cleanup() {
  kill "${SERVER_PID:-}" 2>/dev/null || true
  wait "${SERVER_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

for script in /repo/tests/docker-e2e.sh /repo/tests/test4-base/run.sh; do
  if grep -Fq 'anet node rename "$NODE_ID" renamed-node' "$script"; then
    pass "wiring: $(basename "$script") uses the canonical rename command"
  else
    fail "wiring: $(basename "$script") still uses the legacy rename command"
  fi
done

if [[ $FAIL -ne 0 ]]; then
  echo "RESULT: $PASS passed, $FAIL failed"
  echo "source_commit=$TEST292_RENAME_SOURCE_COMMIT"
  exit 1
fi

mkdir -p "$WORK/home" "$WORK/project"
export HOME=$WORK/home
cd "$WORK/project"

COMMHUB_DB_PATH=$WORK/commhub.db bun run /repo/server/src/index.ts >$WORK/server.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "$BASE/health" >/dev/null
pass "environment: real Hub is healthy"

anet() { bun run /repo/agent-network/bin/cli.ts "$@"; }

curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"username":"rename-owner","password":"rename-pass-123"}' >/dev/null
anet login --hub "$BASE" --username rename-owner --password rename-pass-123 >/dev/null
NETWORK_ID=$(curl -fsS "$BASE/api/networks" -H "Authorization: Bearer $(jq -r .token "$HOME/.anet/config.json")" | jq -r '.networks[0].network_id')
anet network use "$NETWORK_ID" >/dev/null
pass "auth: writable network selected"

anet node create test-node --runtime codex-sdk --model gpt-5.4 >/dev/null
NODE_ID=$(jq -r .node_id .anet/nodes/test-node/config.json)
RENAME_OUTPUT=$(anet node rename "$NODE_ID" renamed-node 2>&1)
if [[ -f .anet/nodes/renamed-node/config.json ]] && \
   jq -e --arg node_id "$NODE_ID" '.node_name == "renamed-node" and .node_id == $node_id' .anet/nodes/renamed-node/config.json >/dev/null; then
  pass "complete flow: canonical rename updates path and identity"
else
  printf '%s\n' "$RENAME_OUTPUT" >&2
  fail "complete flow: canonical rename did not commit"
fi

anet channel add telegram renamed-node --bot-token fixture-token --allow 999 >/dev/null
if [[ -f .anet/nodes/renamed-node/channels/telegram/.env ]] && \
   [[ $(stat -c %a .anet/nodes/renamed-node/channels/telegram/.env) == 600 ]] && \
   jq -e '.channels | index("telegram") != null' .anet/nodes/renamed-node/config.json >/dev/null; then
  pass "complete flow: Telegram config follows the renamed node with mode 0600"
else
  fail "complete flow: Telegram config did not follow the renamed node"
fi

MUTATED=$WORK/docker-e2e-legacy.sh
cp /repo/tests/docker-e2e.sh "$MUTATED"
sed -i 's/anet node rename "\$NODE_ID" renamed-node/anet rename "\$NODE_ID" renamed-node/' "$MUTATED"
if cmp -s /repo/tests/docker-e2e.sh "$MUTATED"; then
  fail "mutation: canonical rename anchor did not match"
elif grep -Fq 'anet node rename "$NODE_ID" renamed-node' "$MUTATED"; then
  fail "mutation: legacy command still passed the canonical wiring gate"
else
  pass "mutation: restoring the legacy aggregate command turns red"
fi

echo "RESULT: $PASS passed, $FAIL failed"
echo "source_commit=$TEST292_RENAME_SOURCE_COMMIT"
[[ $FAIL -eq 0 ]]

#!/usr/bin/env bash
set -euo pipefail
source /tests/lib/safe-rm.sh

ROOT=/tmp/test1204-process
HUB=http://127.0.0.1:19204
safe_rm_rf "$ROOT"
mkdir -p "$ROOT/home" "$ROOT/codex-home" "$ROOT/uploads"
cleanup() {
  local rc=$?
  [[ -n "${AGENT_PID:-}" ]] && kill "$AGENT_PID" 2>/dev/null || true
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null || true
  if (( rc != 0 )); then
    echo "--- Hub log ---" >&2; sed -n '1,240p' "$ROOT/hub.log" >&2 || true
    echo "--- agent-node log ---" >&2; sed -n '1,240p' "$ROOT/agent.log" >&2 || true
    echo "--- injected consumer log ---" >&2; sed -n '1,240p' "$ROOT/consumer.log" >&2 || true
    echo "--- fake Codex log ---" >&2; sed -n '1,240p' /tmp/test1204-fake-codex.log >&2 || true
  fi
  safe_rm_rf "$ROOT"
  return "$rc"
}
trap cleanup EXIT

HOME="$ROOT/home" COMMHUB_DB="$ROOT/hub.db" COMMHUB_UPLOADS_DIR="$ROOT/uploads" \
  COMMHUB_ENABLE_SIDE_THREADS=1 HOST=127.0.0.1 PORT=19204 bun server/src/index.ts >"$ROOT/hub.log" 2>&1 &
HUB_PID=$!
for _ in {1..100}; do curl -fsS "$HUB/health" >/dev/null 2>&1 && break; sleep .05; done
curl -fsS "$HUB/health" >/dev/null

REG=$(curl -fsS -X POST "$HUB/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"username":"prod-owner","password":"StrongPassw0rd","email":"prod@example.test"}')
UTOK=$(jq -r '.token' <<<"$REG")
NET=$(curl -fsS -X POST "$HUB/api/networks" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' -d '{"name":"prod-net"}')
NET_ID=$(jq -r '.network.network_id // .network_id' <<<"$NET")
NODE_ID=node_test1204_prod
MINT=$(curl -fsS -X POST "$HUB/api/auth/node-token" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"prod-node\",\"node_id\":\"$NODE_ID\"}")
NTOK=$(jq -r '.token' <<<"$MINT")
[[ "$NTOK" == ntok_* ]]

jq -n --arg token "$NTOK" --arg net "$NET_ID" --arg node "$NODE_ID" --arg hub "$HUB" '{
  alias:"prod-node",node_name:"prod-node",node_id:$node,network_id:$net,token:$token,hub:$hub,
  runtime:"codex-app-server",model:"gpt-5.4",flags:{sideThreads:true,approvalPolicy:"never",sandboxMode:"danger-full-access"}
}' >"$ROOT/config.json"
chmod 600 "$ROOT/config.json"
: > /tmp/test1204-fake-codex.log
PATH="/repo/tests/test1204-btw-production-wiring:$PATH" CODEX_HOME="$ROOT/codex-home" HOME="$ROOT/home" \
  bun agent-node/src/cli.ts --config "$ROOT/config.json" --alias prod-node >"$ROOT/agent.log" 2>&1 &
AGENT_PID=$!

CAP_URL="$HUB/api/side-threads/capability?alias=prod-node&sourceThreadId=source-thread&boundaryKind=through&boundaryTurnId=source-turn"
for _ in {1..200}; do
  CAP=$(curl -sS "$CAP_URL" -H "Authorization: Bearer $UTOK" || true)
  [[ "$(jq -r '.capability.supported // false' <<<"$CAP" 2>/dev/null)" == true ]] && break
  kill -0 "$AGENT_PID" 2>/dev/null || { sed -n '1,200p' "$ROOT/agent.log"; exit 1; }
  sleep .05
done
if [[ "$(jq -r '.capability.supported' <<<"$CAP")" != true ]]; then
  echo "capability response: $CAP" >&2
  curl -fsS "$HUB/api/status" -H "Authorization: Bearer $UTOK" >&2 || true
  exit 1
fi
# Registration and the production CLI startup call above are real. Replace
# only the Codex RPC dependency for deterministic command execution; Hub auth,
# outbox, consumer, ACK, terminal and bring-back remain production code.
kill "$AGENT_PID"; wait "$AGENT_PID" 2>/dev/null || true; AGENT_PID=""
: > /tmp/test1204-fake-codex.log
TEST_HUB="$HUB" TEST_NODE_ID="$NODE_ID" TEST_NODE_TOKEN="$NTOK" CODEX_HOME="$ROOT/codex-home" \
  bun tests/test1204-btw-production-wiring/injected-consumer.ts >"$ROOT/consumer.log" 2>&1 &
AGENT_PID=$!
for _ in {1..100}; do grep -q 'dedicated consumer enabled' "$ROOT/consumer.log" && break; sleep .05; done
grep -q 'dedicated consumer enabled' "$ROOT/consumer.log"

CREATE_BODY="{
  \"requestKey\":\"prod-create-1\",\"networkId\":\"$NET_ID\",\"nodeId\":\"$NODE_ID\",
  \"sourceThreadId\":\"source-thread\",\"boundary\":{\"kind\":\"through\",\"turnId\":\"source-turn\"},
  \"question\":\"production path question\"
}"
# The HTTP coordinator intentionally returns 202 while native acceptance is
# unknown. Replaying this stable request key reconciles each durable phase;
# it must never enqueue an ordinary task or duplicate the native operation.
CREATE=$(curl -fsS -X POST "$HUB/api/side-threads" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' -d "$CREATE_BODY")
SIDE_ID=$(jq -r '.sideThread.sideThreadId // .sideThreadId // empty' <<<"$CREATE")
[[ -n "$SIDE_ID" ]]
for _ in {1..60}; do
  ROW=$(curl -fsS "$HUB/api/side-threads/$SIDE_ID" -H "Authorization: Bearer $UTOK")
  [[ "$(jq -r '.sideThread.state' <<<"$ROW")" == completed ]] && break
  sleep .5
done
if [[ "$(jq -r '.sideThread.state' <<<"$ROW")" != completed ]]; then
  echo "side-thread response: $ROW" >&2
  exit 1
fi
[[ "$(jq -r '.sideThread.attempts[0].result' <<<"$ROW")" == *PRODUCTION_SIDE_ANSWER* ]]
ATTEMPT_ID=$(jq -r '.sideThread.attempts[0].attemptId' <<<"$ROW")

BACK=$(curl -fsS -X POST "$HUB/api/side-threads/$SIDE_ID/bring-back" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' -d "{
  \"requestKey\":\"prod-bring-1\",\"attemptId\":\"$ATTEMPT_ID\",\"destinationThreadId\":\"source-thread\"
}")
[[ "$(jq -r '.ok' <<<"$BACK")" == true ]]
for _ in {1..200}; do grep -q 'anet-btw-bring-back:' /tmp/test1204-fake-codex.log && break; sleep .05; done
grep -q '"method":"thread/fork"' /tmp/test1204-fake-codex.log
grep -q '"method":"turn/start"' /tmp/test1204-fake-codex.log
grep -q 'anet-side:' /tmp/test1204-fake-codex.log
grep -q 'anet-btw-bring-back:' /tmp/test1204-fake-codex.log
grep -q 'dedicated consumer enabled' "$ROOT/consumer.log"
! grep -q 'send_task' /tmp/test1204-fake-codex.log
echo "PASS real Hub + real agent-node CLI production SideThread path"

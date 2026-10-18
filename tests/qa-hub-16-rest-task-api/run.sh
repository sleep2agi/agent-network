#!/usr/bin/env bash
set -euo pipefail

export HOME=/tmp/anethome
unset DATABASE_URL COMMHUB_TEST_PG_URL
export COMMHUB_DB=/tmp/qa16-rest-task.db
HUB_PORT=9216
HUB_BASE="http://127.0.0.1:$HUB_PORT"
REPORT="/app/docs/tests/report-qa-hub-16-rest-task-api.md"


# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
cleanup() {
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$(dirname "$REPORT")"
cat > "$REPORT" <<'REPORT'
# qa-hub-16-rest-task-api

Status: RUNNING
REPORT

echo "[0] start local hub"
safe_rm_rf "$HOME/.commhub" "$HOME/.anet/server"
cd /app/server
HOST=127.0.0.1 PORT="$HUB_PORT" bun run src/index.ts >/tmp/hub.log 2>&1 &
HUB_PID=$!
for _ in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null || { echo "FAIL: hub did not start"; cat /tmp/hub.log; exit 1; }

echo "[1] register user"
RESP=$(curl -fsS -X POST "$HUB_BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"restTaskUser","password":"StrongPassw0rd!"}')
TOKEN=$(echo "$RESP" | jq -r '.token // empty')
NET=$(echo "$RESP" | jq -r '.network_id // empty')
SENDER=$(echo "$RESP" | jq -r '.user.username // empty')
[[ "$TOKEN" == utok_* && -n "$NET" && -n "$SENDER" ]] || { echo "FAIL: registration did not return token/network/username"; exit 1; }

echo "[1b] register target-agent session"
NTOK=$(curl -fsS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET\",\"node_name\":\"target-agent\"}" | jq -r '.token // empty')
[[ "$NTOK" == ntok_* ]] || { echo "FAIL: node-token"; exit 1; }
BODY=$(jq -nc --arg net "$NET" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"report_status",arguments:{resume_id:"qa16-target-agent",alias:"target-agent",status:"idle",network_id:$net}}}')
RS=$(curl -fsS -X POST "$HUB_BASE/mcp" \
  -H "Authorization: Bearer $NTOK" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-03-26' \
  -d "$BODY" | sed -n 's/^data: //p' | head -1 | jq -r '.result.content[0].text // empty')
echo "$RS" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status target-agent: $RS"; exit 1; }

echo "[2a] reject a forged human sender"
HTTP_CODE=$(jq -nc --arg net "$NET" '{alias:"target-agent",task:"forged sender",from:"qa-probe",network_id:$net}' \
  | curl -sS -o /tmp/forged-sender.json -w '%{http_code}' -X POST "$HUB_BASE/api/task" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @-)
[[ "$HTTP_CODE" == "403" ]] || { echo "FAIL: expected sender rejection 403, got $HTTP_CODE"; exit 1; }
jq -e '.ok == false and .error == "from_session_identity_mismatch"' /tmp/forged-sender.json >/dev/null

echo "[2b] send REST task as the authenticated human with parent_task_id"
PARENT_ID="parent-probe-001"
SEND=$(jq -n --arg alias "target-agent" --arg task "rest fallback probe" --arg from "$SENDER" --arg net "$NET" --arg parent "$PARENT_ID" \
  '{alias:$alias, task:$task, priority:"normal", from:$from, network_id:$net, parent_task_id:$parent}' \
  | curl -fsS -X POST "$HUB_BASE/api/task" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      --data-binary @-)
TASK_ID=$(echo "$SEND" | jq -r '.task_id // empty')
MESSAGE_ID=$(echo "$SEND" | jq -r '.message_id // empty')
[[ -n "$TASK_ID" && "$TASK_ID" == "$MESSAGE_ID" ]] || { echo "FAIL: expected task_id/message_id"; echo "$SEND"; exit 1; }

echo "[3] query single task via /api/tasks/:id"
TASK_BY_PATH=$(curl -fsS "$HUB_BASE/api/tasks/$TASK_ID" -H "Authorization: Bearer $TOKEN")
echo "$TASK_BY_PATH" | jq -e --arg id "$TASK_ID" --arg parent "$PARENT_ID" --arg sender "$SENDER" '
  .ok == true
  and .task.task_id == $id
  and .task.parent_task_id == $parent
  and .task.status == "delivered"
  and .task.to_name == "target-agent"
  and .task.from_name == $sender
' >/dev/null

echo "[4] query single task via /api/task/:id alias"
TASK_BY_ALIAS=$(curl -fsS "$HUB_BASE/api/task/$TASK_ID" -H "Authorization: Bearer $TOKEN")
echo "$TASK_BY_ALIAS" | jq -e --arg id "$TASK_ID" '.ok == true and .task.task_id == $id' >/dev/null

echo "[5] unknown task returns 404 JSON"
HTTP_CODE=$(curl -sS -o /tmp/not-found.json -w "%{http_code}" "$HUB_BASE/api/tasks/no-such-task" -H "Authorization: Bearer $TOKEN")
[[ "$HTTP_CODE" == "404" ]] || { echo "FAIL: expected 404, got $HTTP_CODE"; cat /tmp/not-found.json; exit 1; }
jq -e '.ok == false and .error == "task_not_found"' /tmp/not-found.json >/dev/null

echo "[6] target node replies and the REST task reaches its terminal state"
BODY=$(jq -nc --arg id "$TASK_ID" --arg net "$NET" '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"send_reply",arguments:{in_reply_to:$id,text:"REST closure verified",status:"replied",network_id:$net}}}')
REPLY=$(curl -fsS -X POST "$HUB_BASE/mcp" \
  -H "Authorization: Bearer $NTOK" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-03-26' \
  -d "$BODY" | sed -n 's/^data: //p' | head -1 | jq -r '.result.content[0].text // empty')
echo "$REPLY" | jq -e '.ok == true' >/dev/null
curl -fsS "$HUB_BASE/api/tasks/$TASK_ID" -H "Authorization: Bearer $TOKEN" \
  | jq -e --arg id "$TASK_ID" --arg parent "$PARENT_ID" --arg sender "$SENDER" '
    .ok == true and .task.task_id == $id and .task.parent_task_id == $parent
    and .task.from_name == $sender and .task.status == "replied"
    and .task.result == "REST closure verified" and (.task.completed_at | length > 0)
  ' >/dev/null

cat > "$REPORT" <<REPORT
# qa-hub-16-rest-task-api

Status: PASS

Verified:

- POST /api/task accepts parent_task_id.
- Forged human sender is rejected with 403/from_session_identity_mismatch.
- Authenticated human username is retained as task.from_name.
- POST /api/task returns task_id and message_id.
- GET /api/tasks/:id returns a single task JSON object.
- GET /api/task/:id alias also returns the single task.
- Unknown task id returns 404 JSON.
- Bound target-node MCP reply completes the REST task with the expected result.

Source commit: \`${SOURCE_COMMIT:-unknown}\`

Sample task_id: \`$TASK_ID\`
REPORT

echo "PASS qa-hub-16-rest-task-api"

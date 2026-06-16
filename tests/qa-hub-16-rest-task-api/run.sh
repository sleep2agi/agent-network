#!/usr/bin/env bash
set -euo pipefail

export HOME=/tmp/anethome
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
[[ "$TOKEN" == utok_* && -n "$NET" ]] || { echo "FAIL: registration did not return token/network"; echo "$RESP"; exit 1; }

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

echo "[2] send REST task with parent_task_id"
PARENT_ID="parent-probe-001"
SEND=$(jq -n --arg alias "target-agent" --arg task "rest fallback probe" --arg from "qa-probe" --arg net "$NET" --arg parent "$PARENT_ID" \
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
echo "$TASK_BY_PATH" | jq -e --arg id "$TASK_ID" --arg parent "$PARENT_ID" '
  .ok == true
  and .task.task_id == $id
  and .task.parent_task_id == $parent
  and .task.status == "delivered"
  and .task.to_name == "target-agent"
' >/dev/null

echo "[4] query single task via /api/task/:id alias"
TASK_BY_ALIAS=$(curl -fsS "$HUB_BASE/api/task/$TASK_ID" -H "Authorization: Bearer $TOKEN")
echo "$TASK_BY_ALIAS" | jq -e --arg id "$TASK_ID" '.ok == true and .task.task_id == $id' >/dev/null

echo "[5] unknown task returns 404 JSON"
HTTP_CODE=$(curl -sS -o /tmp/not-found.json -w "%{http_code}" "$HUB_BASE/api/tasks/no-such-task" -H "Authorization: Bearer $TOKEN")
[[ "$HTTP_CODE" == "404" ]] || { echo "FAIL: expected 404, got $HTTP_CODE"; cat /tmp/not-found.json; exit 1; }
jq -e '.ok == false and .error == "task_not_found"' /tmp/not-found.json >/dev/null

cat > "$REPORT" <<REPORT
# qa-hub-16-rest-task-api

Status: PASS

Verified:

- POST /api/task accepts parent_task_id.
- POST /api/task returns task_id and message_id.
- GET /api/tasks/:id returns a single task JSON object.
- GET /api/task/:id alias also returns the single task.
- Unknown task id returns 404 JSON.

Sample task_id: \`$TASK_ID\`
REPORT

echo "PASS qa-hub-16-rest-task-api"

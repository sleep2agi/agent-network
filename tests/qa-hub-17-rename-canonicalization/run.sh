#!/usr/bin/env bash
set -Eeuo pipefail

PORT=19317
BASE="http://127.0.0.1:$PORT"
DB="/tmp/commhub-rename-canonicalization.db"
LOG="/tmp/commhub-rename-canonicalization.log"
rm -f "$DB" "$LOG"

cleanup() {
  set +e
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

json_get() {
  node -e "const fs=require('fs'); const obj=JSON.parse(fs.readFileSync(0,'utf8')); const path=process.argv[1].split('.'); let v=obj; for (const p of path) v=v?.[p]; if (v == null) process.exit(2); process.stdout.write(String(v));" "$1"
}

post_json() {
  local path="$1"
  local token="$2"
  local body="$3"
  if [ -n "$token" ]; then
    curl -fsS -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "$body" "$BASE$path"
  else
    curl -fsS -H "Content-Type: application/json" -d "$body" "$BASE$path"
  fi
}

mcp_call() {
  local token="$1"
  local name="$2"
  local args="$3"
  curl -fsS -H "Authorization: Bearer $token" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}" \
    "$BASE/mcp"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"
  if ! printf '%s' "$haystack" | grep -q "$needle"; then
    echo "ASSERT FAILED: $message"
    echo "$haystack"
    tail -120 "$LOG" || true
    exit 1
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"
  if printf '%s' "$haystack" | grep -q "$needle"; then
    echo "ASSERT FAILED: $message"
    echo "$haystack"
    tail -120 "$LOG" || true
    exit 1
  fi
}

echo "Starting local CommHub for rename canonicalization QA"
(
  cd /app/server
  PORT="$PORT" HOST=127.0.0.1 COMMHUB_AUTH_TOKEN=testtoken COMMHUB_DB="$DB" bun run src/index.ts
) >"$LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  curl -fsS "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "$BASE/health" >/dev/null

echo "Register owner and create isolated network"
post_json "/api/auth/register" "" '{"username":"owner","password":"secret123"}' >/tmp/register.json
LOGIN=$(post_json "/api/auth/login" "" '{"username":"owner","password":"secret123"}')
USER_TOKEN=$(printf '%s' "$LOGIN" | json_get token)
NET_ID=$(post_json "/api/networks" "$USER_TOKEN" '{"name":"rename-canon"}' | json_get network_id)
NTOK=$(post_json "/api/auth/node-token" "$USER_TOKEN" "{\"network_id\":\"$NET_ID\",\"node_name\":\"old-agent\"}" | json_get token)

echo "1. Old alias reports online"
mcp_call "$NTOK" "report_status" "{\"resume_id\":\"resume-old\",\"alias\":\"old-agent\",\"status\":\"idle\"}" >/tmp/report-old.json
STATUS=$(curl -fsS -H "Authorization: Bearer $USER_TOKEN" "$BASE/api/status?network_id=$NET_ID")
assert_contains "$STATUS" '"alias":"old-agent"' "old-agent should exist before rename"

echo "2. Commit old-agent -> new-agent"
PREP=$(post_json "/api/node-rename/prepare" "$USER_TOKEN" "{\"network_id\":\"$NET_ID\",\"old_alias\":\"old-agent\",\"new_alias\":\"new-agent\"}")
TXN_ID=$(printf '%s' "$PREP" | json_get txn_id)
COMMIT=$(post_json "/api/node-rename/commit" "$USER_TOKEN" "{\"txn_id\":\"$TXN_ID\"}")
assert_contains "$COMMIT" '"ok":true' "commit rename should succeed"

echo "3. New process reports under new alias"
mcp_call "$NTOK" "report_status" "{\"resume_id\":\"resume-new\",\"alias\":\"new-agent\",\"status\":\"idle\"}" >/tmp/report-new.json
STATUS=$(curl -fsS -H "Authorization: Bearer $USER_TOKEN" "$BASE/api/status?network_id=$NET_ID")
assert_contains "$STATUS" '"alias":"new-agent"' "new-agent should exist after rename"
assert_not_contains "$STATUS" '"alias":"old-agent"' "old-agent should be absent after new report"

echo "4. Stale old process heartbeat is ignored and cannot recreate old alias"
STALE=$(mcp_call "$NTOK" "report_status" "{\"resume_id\":\"resume-old\",\"alias\":\"old-agent\",\"status\":\"error\",\"task\":\"stale zombie\"}")
assert_contains "$STALE" 'ignored_stale_alias' "stale old report should be marked ignored"
STATUS=$(curl -fsS -H "Authorization: Bearer $USER_TOKEN" "$BASE/api/status?network_id=$NET_ID")
assert_contains "$STATUS" '"alias":"new-agent"' "new-agent should remain after stale heartbeat"
assert_not_contains "$STATUS" '"alias":"old-agent"' "old-agent should not be recreated by stale heartbeat"

echo "5. REST /api/task to old alias redirects to new alias"
REST_TASK=$(post_json "/api/task" "$USER_TOKEN" "{\"alias\":\"old-agent\",\"task\":\"rest redirect\",\"network_id\":\"$NET_ID\"}")
assert_contains "$REST_TASK" '"renamed_from":"old-agent"' "REST task response should include renamed_from"
assert_contains "$REST_TASK" '"renamed_to":"new-agent"' "REST task response should include renamed_to"

echo "6. MCP send_task to old alias redirects to new alias"
MCP_TASK=$(mcp_call "$USER_TOKEN" "send_task" "{\"alias\":\"old-agent\",\"task\":\"mcp redirect\",\"network_id\":\"$NET_ID\"}")
assert_contains "$MCP_TASK" 'renamed_from' "MCP send_task response should include renamed_from"
assert_contains "$MCP_TASK" 'renamed_to' "MCP send_task response should include renamed_to"

echo "7. Task/inbox rows only target canonical alias"
TASKS=$(curl -fsS -H "Authorization: Bearer $USER_TOKEN" "$BASE/api/tasks?network_id=$NET_ID")
assert_contains "$TASKS" '"to_name":"new-agent"' "tasks should target new-agent"
assert_not_contains "$TASKS" '"to_name":"old-agent"' "tasks should not target old-agent"

STATUS=$(curl -fsS -H "Authorization: Bearer $USER_TOKEN" "$BASE/api/status?network_id=$NET_ID")
assert_contains "$STATUS" '"total":1' "status summary should only include one canonical session"
assert_not_contains "$STATUS" '"alias":"old-agent"' "final status should not show old-agent"

echo "PASS: rename canonicalization blocks stale report_status and redirects send_task/REST task"

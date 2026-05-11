#!/usr/bin/env bash
set -Eeuo pipefail

PORT=19291
BASE="http://127.0.0.1:$PORT"
DB="/tmp/commhub-network-alias.db"
LOG="/tmp/commhub-network-alias.log"
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

mcp_report_status() {
  local token="$1"
  local resume="$2"
  local alias="$3"
  curl -fsS -H "Authorization: Bearer $token" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report_status\",\"arguments\":{\"resume_id\":\"$resume\",\"alias\":\"$alias\",\"status\":\"idle\"}}}" \
    "$BASE/mcp"
}

echo "Starting local CommHub for network alias E2E"
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

echo "Register/login"
post_json "/api/auth/register" "" '{"username":"owner","password":"secret123"}' >/tmp/register.json
LOGIN=$(post_json "/api/auth/login" "" '{"username":"owner","password":"secret123"}')
USER_TOKEN=$(printf '%s' "$LOGIN" | json_get token)

echo "Create two networks"
NET_A=$(post_json "/api/networks" "$USER_TOKEN" '{"name":"same-alias-a"}' | json_get network_id)
NET_B=$(post_json "/api/networks" "$USER_TOKEN" '{"name":"same-alias-b"}' | json_get network_id)

echo "Create node tokens"
TOK_A=$(post_json "/api/auth/node-token" "$USER_TOKEN" "{\"network_id\":\"$NET_A\",\"node_name\":\"same-agent\"}" | json_get token)
TOK_B=$(post_json "/api/auth/node-token" "$USER_TOKEN" "{\"network_id\":\"$NET_B\",\"node_name\":\"same-agent\"}" | json_get token)

echo "Report same alias into both networks"
mcp_report_status "$TOK_A" "resume-a" "same-agent" >/tmp/report-a.txt
mcp_report_status "$TOK_B" "resume-b" "same-agent" >/tmp/report-b.txt

echo "Verify both sessions exist and are isolated"
STATUS_A=$(curl -fsS -H "Authorization: Bearer $USER_TOKEN" "$BASE/api/status?network_id=$NET_A")
STATUS_B=$(curl -fsS -H "Authorization: Bearer $USER_TOKEN" "$BASE/api/status?network_id=$NET_B")

printf '%s' "$STATUS_A" | grep -q '"alias":"same-agent"' || { echo "network A missing same-agent"; tail -80 "$LOG"; exit 1; }
printf '%s' "$STATUS_B" | grep -q '"alias":"same-agent"' || { echo "network B missing same-agent"; tail -80 "$LOG"; exit 1; }
printf '%s' "$STATUS_A" | grep -q "\"network_id\":\"$NET_A\"" || { echo "network A wrong network_id"; echo "$STATUS_A"; exit 1; }
printf '%s' "$STATUS_B" | grep -q "\"network_id\":\"$NET_B\"" || { echo "network B wrong network_id"; echo "$STATUS_B"; exit 1; }

echo "PASS: same alias can register in two networks"

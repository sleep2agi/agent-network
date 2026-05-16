#!/usr/bin/env bash
set -euo pipefail

export HOME=/tmp/anethome
HUB_PORT=9213
HUB_BASE="http://127.0.0.1:$HUB_PORT"

cleanup() {
  for p in "${HUB_PID:-}" "${SSE_A_PID:-}" "${SSE_B_PID:-}"; do
    [[ -n "$p" && "$p" != "0" ]] && kill "$p" 2>/dev/null || true
  done
}
trap cleanup EXIT

mcp_call() {
  local tok="$1" name="$2" args="$3"
  local body
  body=$(jq -nc --arg n "$name" --argjson a "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  curl -sS -X POST "$HUB_BASE/mcp" \
    -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "$body" \
    | sed -n 's/^data: //p' | head -1 \
    | jq -r '.result.content[0].text // empty'
}

register_user() {
  local username="$1" password="$2"
  curl -fsS -X POST "$HUB_BASE/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$username\",\"password\":\"$password\"}"
}

wait_for_log() {
  local pattern="$1" file="$2" label="$3"
  for _ in {1..30}; do
    grep -q "$pattern" "$file" 2>/dev/null && return 0
    sleep 0.2
  done
  echo "FAIL: timed out waiting for $label in $file"
  cat "$file" || true
  exit 1
}

assert_no_log() {
  local pattern="$1" file="$2" label="$3"
  sleep 0.8
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo "FAIL: unexpected $label in $file"
    cat "$file"
    exit 1
  fi
}

echo "[0] start local hub from repository source"
rm -rf "$HOME/.commhub" "$HOME/.anet/server"
cd /app/server
HOST=127.0.0.1 PORT="$HUB_PORT" bun run src/index.ts >/tmp/hub.log 2>&1 &
HUB_PID=$!
for _ in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null || { echo "FAIL: hub did not start"; cat /tmp/hub.log; exit 1; }

echo "[1] register two users with separate networks"
A_RESP=$(register_user heroA StrongPassw0rdA)
B_RESP=$(register_user heroB StrongPassw0rdB)
UTOK_A=$(echo "$A_RESP" | jq -r '.token // empty')
NTOK_A=$(echo "$A_RESP" | jq -r '.network_token // empty')
NET_A=$(echo "$A_RESP" | jq -r '.network_id // empty')
UTOK_B=$(echo "$B_RESP" | jq -r '.token // empty')
NTOK_B=$(echo "$B_RESP" | jq -r '.network_token // empty')
NET_B=$(echo "$B_RESP" | jq -r '.network_id // empty')
[[ "$UTOK_A" == utok_* && "$NTOK_A" == ntok_* && -n "$NET_A" ]] || { echo "FAIL: user A registration"; echo "$A_RESP"; exit 1; }
[[ "$UTOK_B" == utok_* && "$NTOK_B" == ntok_* && -n "$NET_B" ]] || { echo "FAIL: user B registration"; echo "$B_RESP"; exit 1; }
[[ "$NET_A" != "$NET_B" ]] || { echo "FAIL: networks should differ"; exit 1; }

echo "[2] report host/process telemetry for two agents on one server in network A"
ARG_A1=$(jq -nc --arg net "$NET_A" \
  '{resume_id:"140-a-1",alias:"hero-a1",status:"idle",task:"standby",progress:10,agent:"agent-node:claude",model:"intern-s1-pro",network_id:$net,host:{hostname:"hero-box",ip:"10.10.0.5",cpu_load_1min:1.0,cpu_cores:4,mem_total_gb:16,mem_used_gb:15.2,mem_avail_gb:0.8,disk_total_gb:100,disk_used_gb:92,disk_avail_gb:8},process_telemetry:{rss_bytes:123456789,rss_mb:117.7,cpu_pct:12.5,uptime_seconds:100,in_flight_count:0}}')
ARG_A2=$(jq -nc --arg net "$NET_A" \
  '{resume_id:"140-a-2",alias:"hero-a2",status:"working",task:"compute",progress:66,agent:"agent-node:codex",model:"gpt-5.4",network_id:$net,host:{hostname:"hero-box",ip:"10.10.0.5",cpu_load_1min:3.6,cpu_cores:4,mem_total_gb:16,mem_used_gb:15.6,mem_avail_gb:0.4,disk_total_gb:100,disk_used_gb:99.2,disk_avail_gb:0.8},process_telemetry:{rss_bytes:223456789,rss_mb:213.1,cpu_pct:80.1,uptime_seconds:200,in_flight_count:2}}')
out=$(mcp_call "$NTOK_A" report_status "$ARG_A1")
echo "$out" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status A1: $out"; exit 1; }
sleep 1.1
out=$(mcp_call "$NTOK_A" report_status "$ARG_A2")
echo "$out" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status A2: $out"; exit 1; }

echo "[3] report same host in network B to guard cross-network scope"
ARG_B1=$(jq -nc --arg net "$NET_B" \
  '{resume_id:"140-b-1",alias:"hero-b1",status:"idle",network_id:$net,host:{hostname:"hero-box",ip:"10.10.0.5",cpu_load_1min:0.1,cpu_cores:64,mem_total_gb:128,mem_used_gb:8,mem_avail_gb:120,disk_total_gb:1000,disk_used_gb:100,disk_avail_gb:900},process_telemetry:{rss:999,cpu_pct:1,uptime_seconds:9,in_flight_count:0}}')
out=$(mcp_call "$NTOK_B" report_status "$ARG_B1")
echo "$out" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status B1: $out"; exit 1; }

echo "[4] /api/server/:host/health exposes latest alert + history for network A only"
HEALTH_A=$(curl -fsS "$HUB_BASE/api/server/hero-box/health?network_id=$NET_A" -H "Authorization: Bearer $UTOK_A")
echo "$HEALTH_A" | jq -e '.ok == true and .host=="hero-box" and .agent_count==2 and .alert_level=="red" and .latest.cpu_pct==90 and .latest.mem_avail_gb==0.4 and .latest.disk_avail_gb==0.8 and (.history["5m"]|length>=1) and (.history["1h"]|length>=1) and (.history["24h"]|length>=1)' >/dev/null || {
  echo "FAIL: health endpoint wrong"
  echo "$HEALTH_A"
  exit 1
}
if echo "$HEALTH_A" | jq -e '.latest.cpu_cores == 64 or .latest.mem_avail_gb == 120' >/dev/null; then
  echo "FAIL: network B host metrics leaked into A health"
  echo "$HEALTH_A"
  exit 1
fi

echo "[5] /api/server/:host/agents exposes per-agent details and process telemetry"
AGENTS_A=$(curl -fsS "$HUB_BASE/api/server/hero-box/agents?network_id=$NET_A" -H "Authorization: Bearer $UTOK_A")
echo "$AGENTS_A" | jq -e '.ok == true and .agent_count==2 and (.agents|length==2)' >/dev/null || { echo "FAIL: agents shape"; echo "$AGENTS_A"; exit 1; }
echo "$AGENTS_A" | jq -e '.agents[] | select(.alias=="hero-a2" and .runtime=="codex-sdk" and .health=="online" and .progress==66 and .telemetry.process_in_flight_count==2 and .telemetry.process_cpu_pct==80.1)' >/dev/null || {
  echo "FAIL: hero-a2 detail missing"
  echo "$AGENTS_A"
  exit 1
}
echo "$AGENTS_A" | jq -e '.agents[] | select(.alias=="hero-a2" and .process_telemetry.rss_bytes==223456789 and .process_telemetry.rss_mb==213.1 and .process_telemetry.cpu_pct==80.1 and .process_telemetry.uptime_seconds==200 and .process_telemetry.in_flight_count==2)' >/dev/null || {
  echo "FAIL: hero-a2 process_telemetry missing"
  echo "$AGENTS_A"
  exit 1
}
if echo "$AGENTS_A" | jq -e '.agents[] | select(.alias=="hero-b1")' >/dev/null; then
  echo "FAIL: network B agent leaked into A agents"
  echo "$AGENTS_A"
  exit 1
fi

STATUS_A=$(curl -fsS "$HUB_BASE/api/status?network_id=$NET_A" -H "Authorization: Bearer $UTOK_A")
echo "$STATUS_A" | jq -e '.ok == true and (.sessions[] | select(.alias=="hero-a2" and .host.hostname=="hero-box" and .process_telemetry.rss_bytes==223456789 and .process_telemetry.in_flight_count==2))' >/dev/null || {
  echo "FAIL: /api/status should surface host + process_telemetry"
  echo "$STATUS_A"
  exit 1
}

echo "[5b] old clients without process_telemetry surface nulls"
LEGACY_ARG=$(jq -nc --arg net "$NET_A" \
  '{resume_id:"140-legacy",alias:"legacy-agent",status:"idle",network_id:$net,host:{hostname:"legacy-box",ip:"10.10.0.6",cpu_load_1min:0.1,cpu_cores:2,mem_total_gb:4,mem_used_gb:1,mem_avail_gb:3}}')
out=$(mcp_call "$NTOK_A" report_status "$LEGACY_ARG")
echo "$out" | jq -e '.ok == true' >/dev/null || { echo "FAIL: legacy report_status: $out"; exit 1; }
LEGACY_AGENTS=$(curl -fsS "$HUB_BASE/api/server/legacy-box/agents?network_id=$NET_A" -H "Authorization: Bearer $UTOK_A")
echo "$LEGACY_AGENTS" | jq -e '.ok == true and .agents[0].process_telemetry.rss_bytes == null and .agents[0].process_telemetry.cpu_pct == null and .agents[0].process_telemetry.in_flight_count == null' >/dev/null || {
  echo "FAIL: legacy process_telemetry should be null"
  echo "$LEGACY_AGENTS"
  exit 1
}

echo "[6] existing /api/servers aggregate still works"
SERVERS_A=$(curl -fsS "$HUB_BASE/api/servers?network_id=$NET_A" -H "Authorization: Bearer $UTOK_A")
echo "$SERVERS_A" | jq -e 'type=="array" and length==2 and (.[] | select(.hostname=="hero-box" and .agent_count==2 and .cpu_load_1min==3.6 and .mem_avail_gb==0.4)) and (.[] | select(.hostname=="legacy-box" and .agent_count==1))' >/dev/null || {
  echo "FAIL: /api/servers regression"
  echo "$SERVERS_A"
  exit 1
}

echo "[7] /api/messages returns promptly after task write"
TASK_A=$(jq -nc '{alias:"hero-a1",task:"message-smoke",from_session:"dashboard-smoke"}')
SEND_A=$(mcp_call "$NTOK_A" send_task "$TASK_A")
echo "$SEND_A" | jq -e '.ok == true' >/dev/null || { echo "FAIL: send_task for messages: $SEND_A"; exit 1; }
MESSAGES_A=$(curl -fsS --max-time 2 "$HUB_BASE/api/messages?network_id=$NET_A&limit=10" -H "Authorization: Bearer $UTOK_A")
echo "$MESSAGES_A" | jq -e '.ok == true and (.messages[] | select(.from_alias=="dashboard-smoke" and .to_alias=="hero-a1"))' >/dev/null || {
  echo "FAIL: /api/messages did not return expected task"
  echo "$MESSAGES_A"
  exit 1
}

echo "[8] SSE/broadcast loop remains network-isolated"
: >/tmp/sse-a.log
: >/tmp/sse-b.log
( curl -fsSN -H "Authorization: Bearer $NTOK_A" "$HUB_BASE/events/hero-a1?network_id=$NET_A" >>/tmp/sse-a.log 2>&1 ) &
SSE_A_PID=$!
( curl -fsSN -H "Authorization: Bearer $NTOK_B" "$HUB_BASE/events/hero-b1?network_id=$NET_B" >>/tmp/sse-b.log 2>&1 ) &
SSE_B_PID=$!
wait_for_log '"type":"connected"' /tmp/sse-a.log "SSE A connected"
wait_for_log '"type":"connected"' /tmp/sse-b.log "SSE B connected"
STATUS_UPDATE_ARG=$(jq -nc --arg net "$NET_A" \
  '{resume_id:"140-a-1",alias:"hero-a1",status:"idle",progress:11,agent:"agent-node:claude",network_id:$net,host:{hostname:"hero-box",ip:"10.10.0.5",cpu_load_1min:1.1,cpu_cores:4,mem_total_gb:16,mem_used_gb:15.1,mem_avail_gb:0.9,disk_total_gb:100,disk_used_gb:92,disk_avail_gb:8},process_telemetry:{rss_bytes:133456789,rss_mb:127.3,cpu_pct:13.5,uptime_seconds:110,in_flight_count:1}}')
out=$(mcp_call "$NTOK_A" report_status "$STATUS_UPDATE_ARG")
echo "$out" | jq -e '.ok == true' >/dev/null || { echo "FAIL: status update report_status: $out"; exit 1; }
wait_for_log '"type":"status_update"' /tmp/sse-a.log "status update SSE"
wait_for_log '"process_telemetry"' /tmp/sse-a.log "process telemetry SSE"
: >/tmp/sse-a.log
: >/tmp/sse-b.log
BROADCAST_A=$(jq -nc '{message:"hero-broadcast"}')
BC_A=$(mcp_call "$NTOK_A" broadcast "$BROADCAST_A")
echo "$BC_A" | jq -e '.ok == true and .recipients >= 1' >/dev/null || { echo "FAIL: broadcast A: $BC_A"; exit 1; }
wait_for_log '"type":"broadcast"' /tmp/sse-a.log "network A broadcast"
assert_no_log '"type":"broadcast"' /tmp/sse-b.log "network A broadcast leaked to B"

echo "[9] p99 smoke for health endpoint"
times_file=/tmp/health-times.txt
: >"$times_file"
for _ in {1..20}; do
  curl -fsS -o /dev/null -w '%{time_total}\n' "$HUB_BASE/api/server/hero-box/health?network_id=$NET_A" -H "Authorization: Bearer $UTOK_A" >>"$times_file"
done
P99=$(sort -n "$times_file" | tail -1)
echo "health_endpoint_p99_seconds=$P99"
awk -v p="$P99" 'BEGIN { exit (p < 0.5 ? 0 : 1) }' || { echo "FAIL: health endpoint p99 too high: $P99"; exit 1; }

echo "PASS qa-hub-13 server health/agents endpoints (#140 Hero 1+2 ✓ / regression gates ✓)"

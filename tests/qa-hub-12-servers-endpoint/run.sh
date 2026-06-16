#!/usr/bin/env bash
set -euo pipefail

export HOME=/tmp/anethome
HUB_PORT=9212
HUB_BASE="http://127.0.0.1:$HUB_PORT"


# P0 guardrail (2026-06-16 incident) — refuse rm -rf outside /tmp/*.
# safe_rm_rf checks every path prefix against $SAFE_RM_ALLOW_PREFIXES
# (default "/tmp/"); refuses + exit 99 on anything else. See
# tests/lib/safe-rm.sh for the helper definition.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
cleanup() {
  [[ -n "${HUB_PID:-}" && "$HUB_PID" != "0" ]] && kill "$HUB_PID" 2>/dev/null || true
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

echo "[0] start local hub from repository source"
safe_rm_rf "$HOME/.commhub" "$HOME/.anet/server"
cd /app/server
HOST=127.0.0.1 PORT="$HUB_PORT" bun run src/index.ts >/tmp/hub.log 2>&1 &
HUB_PID=$!
for _ in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null || { echo "FAIL: hub did not start"; cat /tmp/hub.log; exit 1; }

echo "[1] register two users with separate networks"
A_RESP=$(register_user srvA StrongPassw0rdA)
B_RESP=$(register_user srvB StrongPassw0rdB)
UTOK_A=$(echo "$A_RESP" | jq -r '.token // empty')
NTOK_A=$(echo "$A_RESP" | jq -r '.network_token // empty')
NET_A=$(echo "$A_RESP" | jq -r '.network_id // empty')
UTOK_B=$(echo "$B_RESP" | jq -r '.token // empty')
NTOK_B=$(echo "$B_RESP" | jq -r '.network_token // empty')
NET_B=$(echo "$B_RESP" | jq -r '.network_id // empty')
[[ "$UTOK_A" == utok_* && "$NTOK_A" == ntok_* && -n "$NET_A" ]] || { echo "FAIL: user A registration"; echo "$A_RESP"; exit 1; }
[[ "$UTOK_B" == utok_* && "$NTOK_B" == ntok_* && -n "$NET_B" ]] || { echo "FAIL: user B registration"; echo "$B_RESP"; exit 1; }
[[ "$NET_A" != "$NET_B" ]] || { echo "FAIL: networks should differ"; exit 1; }

echo "[2] report four agents, three sharing one physical host in network A"
ARG_A1=$(jq -nc --arg net "$NET_A" '{resume_id:"119-a-1",alias:"agent-a1",status:"idle",network_id:$net,host:{hostname:"box-a",ip:"10.0.0.10",cpu_load_1min:0.4,cpu_cores:8,mem_total_gb:32.0,mem_used_gb:8.0,mem_avail_gb:24.0}}')
ARG_A2=$(jq -nc --arg net "$NET_A" '{resume_id:"119-a-2",alias:"agent-a2",status:"working",network_id:$net,host:{hostname:"box-a",ip:"10.0.0.10",cpu_load_1min:1.2,cpu_cores:8,mem_total_gb:32.0,mem_used_gb:10.5,mem_avail_gb:21.5}}')
ARG_A3=$(jq -nc --arg net "$NET_A" '{resume_id:"119-a-3",alias:"agent-a3",status:"idle",network_id:$net,host:{hostname:"box-b",ip:"10.0.0.11",cpu_load_1min:null,cpu_cores:4,mem_total_gb:16.0,mem_used_gb:2.0,mem_avail_gb:14.0}}')
ARG_A4=$(jq -nc --arg net "$NET_A" '{resume_id:"119-a-4",alias:"agent-a4",status:"idle",network_id:$net,host:{hostname:"box-a",ip:"127.0.0.1",cpu_load_1min:null,cpu_cores:null,mem_total_gb:null,mem_used_gb:null,mem_avail_gb:null}}')
for args in "$ARG_A1"; do
  out=$(mcp_call "$NTOK_A" report_status "$args")
  echo "$out" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status A: $out"; exit 1; }
done
# Ensure "latest host metrics" has a deterministic timestamp newer than A1.
sleep 1.1
for args in "$ARG_A2" "$ARG_A3" "$ARG_A4"; do
  out=$(mcp_call "$NTOK_A" report_status "$args")
  echo "$out" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status A: $out"; exit 1; }
done

echo "[3] report same hostname/ip in network B to verify REST network isolation"
ARG_B1=$(jq -nc --arg net "$NET_B" '{resume_id:"119-b-1",alias:"agent-b1",status:"idle",network_id:$net,host:{hostname:"box-a",ip:"10.0.0.10",cpu_load_1min:9.9,cpu_cores:64,mem_total_gb:128.0,mem_used_gb:64.0,mem_avail_gb:64.0}}')
out=$(mcp_call "$NTOK_B" report_status "$ARG_B1")
echo "$out" | jq -e '.ok == true' >/dev/null || { echo "FAIL: report_status B: $out"; exit 1; }

echo "[4] /api/servers aggregates network A only"
SERVERS_A=$(curl -fsS "$HUB_BASE/api/servers?network_id=$NET_A" -H "Authorization: Bearer $UTOK_A")
echo "$SERVERS_A" | jq -e 'type == "array" and length == 2' >/dev/null || { echo "FAIL: expected two server groups for A"; echo "$SERVERS_A"; exit 1; }
echo "$SERVERS_A" | jq -e '.[] | select(.hostname=="box-a" and .ip=="10.0.0.10" and .agent_count==3 and .cpu_load_1min==1.2 and .cpu_cores==8 and .mem_used_gb==10.5 and .mem_avail_gb==21.5)' >/dev/null || {
  echo "FAIL: box-a aggregate/latest telemetry wrong"
  echo "$SERVERS_A"
  exit 1
}
echo "$SERVERS_A" | jq -e '.[] | select(.hostname=="box-b" and .ip=="10.0.0.11" and .agent_count==1 and .cpu_load_1min==null and .cpu_cores==4)' >/dev/null || {
  echo "FAIL: box-b aggregate/null telemetry wrong"
  echo "$SERVERS_A"
  exit 1
}
if echo "$SERVERS_A" | jq -e '.[] | select(.cpu_cores==64)' >/dev/null; then
  echo "FAIL: network B host telemetry leaked into user A /api/servers"
  echo "$SERVERS_A"
  exit 1
fi

echo "[5] explicit network_id query remains scoped and B sees its own host"
SERVERS_B=$(curl -fsS "$HUB_BASE/api/servers?network_id=$NET_B" -H "Authorization: Bearer $UTOK_B")
echo "$SERVERS_B" | jq -e 'type == "array" and length == 1 and .[0].hostname=="box-a" and .[0].agent_count==1 and .[0].cpu_cores==64' >/dev/null || {
  echo "FAIL: expected one server group for B"
  echo "$SERVERS_B"
  exit 1
}

echo "PASS qa-hub-12 servers endpoint (#119 host telemetry aggregation ✓ / network scope ✓)"

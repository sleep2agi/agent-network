#!/usr/bin/env bash
# Daemon-side probe. Runs INSIDE the daemon container, talks to `hub`
# service via docker bridge (functional equivalent of 通信龙's
# gateway-172.18.0.1 topology).
#
# Emits report to /repo/docs/tests/p380-gateway-topology-probe/report.txt
# (bind-mounted from host).

set -euo pipefail

BASE="${HUB_URL:-http://hub:9310}"
REPORT="${REPORT_HOST_PATH:-/repo/docs/tests/p380-gateway-topology-probe/report.txt}"
DAEMON_LOG="/tmp/daemon.log"
export HOME=/tmp/anethome
mkdir -p "$HOME/.anet" "$(dirname "$REPORT")"

rec() { printf '  %s = %s\n' "$1" "$2" >> "$REPORT"; }
sec() { printf '\n## %s\n\n' "$1" >> "$REPORT"; }
raw() { printf '%s\n' "$*" >> "$REPORT"; }

json_post() {
  local path="$1" token="$2" body="$3"
  curl -sS -X POST "$BASE$path" \
    ${token:+-H "Authorization: Bearer $token"} \
    -H "Content-Type: application/json" \
    -d "$body"
}

mcp_call() {
  local token="$1" tool="$2" args="$3"
  local body raw_resp json text
  body=$(jq -nc --arg n "$tool" --argjson a "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  raw_resp=$(curl -sS -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "MCP-Protocol-Version: 2025-03-26" \
    -d "$body")
  json=$(echo "$raw_resp" | sed -n 's/^data: //p' | head -1)
  [[ -z "$json" ]] && json="$raw_resp"
  text=$(echo "$json" | jq -r '.result.content[0].text // empty')
  [[ -n "$text" ]] || { echo "empty MCP response for $tool: $raw_resp" >&2; return 1; }
  echo "$text"
}

: > "$REPORT"
cat >> "$REPORT" <<HDR
# test380-gateway-topology-probe

Mirror of 通信龙's #380 exact repro topology:
- hub  container: /repo/server (bun) on 0.0.0.0:9310
- daemon container: node:22-bookworm-slim + npm-installed
    @sleep2agi/agent-network@preview + @sleep2agi/agent-node@preview
- shared docker bridge net "p380net"; daemon reaches hub via DNS "hub"
    (functional equivalent of gateway 172.18.0.1 — cross-container HTTP
    over shared bridge network, daemon's outbound IP is a bridge-assigned
    address that the hub records verbatim)
- neither container touches host or fleet :9200.

HDR

# ── S0 environment ──────────────────────────────────────────────────────
sec "S0 daemon-container environment"
rec "kernel"                     "$(uname -a)"
rec "node"                       "$(node --version)"
rec "installed agent-network"    "$(anet --version 2>/dev/null | grep -oE 'anet v[0-9\.a-z-]+' | head -1)"
rec "installed agent-node"       "$(agent-node --version 2>/dev/null || echo '(missing)')"
rec "which agent-node"           "$(command -v agent-node)"
rec "hub reachable"              "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/health" || echo 'FAIL')"
DAEMON_IP=$(hostname -i 2>/dev/null || echo '(unknown)')
rec "daemon container IP"        "$DAEMON_IP"
rec "hub URL"                    "$BASE"

# ── S1 bootstrap admin + network + mint ntok ────────────────────────────
sec "S1 setup — admin / network / demo-host ntok"

ADMIN=$(json_post "/api/auth/register" "" '{"username":"admin","password":"anethub"}')
UTOK=$(echo "$ADMIN" | jq -r '.token // empty')
[[ "$UTOK" == utok_* ]] || { rec "register" "FAILED: $ADMIN"; exit 1; }

NET=$(json_post "/api/networks" "$UTOK" '{"name":"n-380-gw"}')
NET_ID=$(echo "$NET" | jq -r '.network.network_id // .network_id // empty')
[[ -n "$NET_ID" ]] || { rec "network" "FAILED: $NET"; exit 1; }

DEMO_HOST_TOK=$(json_post "/api/auth/node-token" "$UTOK" \
  "{\"network_id\":\"$NET_ID\",\"node_name\":\"demo-host\"}" | jq -r '.token // empty')
[[ "$DEMO_HOST_TOK" == ntok_* ]] || { rec "mint" "FAILED"; exit 1; }

rec "utok prefix"  "${UTOK:0:12}..."
rec "network_id"   "$NET_ID"
rec "demo-host ntok prefix" "${DEMO_HOST_TOK:0:12}..."

# ── S1b — first, probe empty state (count=0 side-quest for 通信龙) ────
sec "S1b empty-state probe — /api/host-supervisors BEFORE any daemon starts (count=0 side-quest)"

# With network_id
EMPTY_WITH_NET=$(curl -sS -o /tmp/rest-empty.json -w '%{http_code}' \
  "$BASE/api/host-supervisors?network_id=$NET_ID" -H "Authorization: Bearer $UTOK")
rec "REST /api/host-supervisors?network_id=... (empty) status" "$EMPTY_WITH_NET"
raw ""
raw "REST body when count=0:"; cat /tmp/rest-empty.json | jq '.' >> "$REPORT"

# Without network_id (dashboard-forgot-param case)
EMPTY_NO_NET=$(curl -sS -o /tmp/rest-empty-nonet.json -w '%{http_code}' \
  "$BASE/api/host-supervisors" -H "Authorization: Bearer $UTOK")
rec "REST /api/host-supervisors (no network_id!) status" "$EMPTY_NO_NET"
raw ""
raw "REST body when network_id missing:"; cat /tmp/rest-empty-nonet.json | jq '.' >> "$REPORT"

# MCP tool empty
EMPTY_MCP=$(mcp_call "$DEMO_HOST_TOK" "list_host_supervisors" "{}")
raw ""
raw "MCP list_host_supervisors (empty state):"
echo "$EMPTY_MCP" | jq '.' >> "$REPORT"

# ── S2 write config + spawn daemon ─────────────────────────────────────
sec "S2 spawn daemon (agent-node preview.17 via PATH)"

DAEMON_DIR="$HOME/.anet/nodes/demo-host"
mkdir -p "$DAEMON_DIR"
NODE_ID="n_$(head -c 8 /dev/urandom | od -An -txC | tr -d ' \n')"
cat > "$DAEMON_DIR/config.json" <<CFG
{
  "anet_version": "gateway-topology-probe",
  "node_id": "$NODE_ID",
  "node_name": "demo-host",
  "alias": "demo-host",
  "runtime": "claude-agent-sdk",
  "role": "host_supervisor",
  "runtimes_supported": ["claude-agent-sdk", "codex-sdk", "grok-build-acp"],
  "allowed_secret_keys": [],
  "max_concurrent_children": 20,
  "network_id": "$NET_ID",
  "hub": "$BASE",
  "token": "$DEMO_HOST_TOK",
  "model": "claude-sonnet-4-5",
  "channels": [],
  "env": {},
  "flags": { "dangerouslySkipPermissions": true, "teammateMode": true },
  "session": null
}
CFG
rec "config path" "$DAEMON_DIR/config.json"
rec "config role" "$(jq -r .role "$DAEMON_DIR/config.json")"

env_common=(
  "COMMHUB_ALIAS=demo-host"
  "COMMHUB_NODE_ID=$NODE_ID"
  "COMMHUB_TOKEN=$DEMO_HOST_TOK"
  "COMMHUB_URL=$BASE"
  "ANET_CONFIG_UPDATE_CAPABLE=1"
  "PATH=$PATH"
  "HOME=$HOME"
)
( env "${env_common[@]}" agent-node \
    --config "$DAEMON_DIR/config.json" \
    --alias demo-host \
    --runtime claude-agent-sdk >"$DAEMON_LOG" 2>&1 ) &
DAEMON_PID=$!
rec "daemon spawn pid" "$DAEMON_PID"

# Wait for register + immediate reportStatus to land, then some slack.
sleep 12

# ── S3 daemon log — did register succeed cross-container? ─────────────
sec "S3 daemon log (last 30 lines) — cross-container register/report"
tail -30 "$DAEMON_LOG" >> "$REPORT" 2>&1

# ── S4 REST from daemon container to hub ───────────────────────────────
sec "S4 REST /api/host-supervisors (post-daemon-up, from daemon container)"

RESP_STATUS=$(curl -sS -o /tmp/hs-resp.json -w '%{http_code}' \
  "$BASE/api/host-supervisors?network_id=$NET_ID" -H "Authorization: Bearer $UTOK")
rec "HTTP status" "$RESP_STATUS"
raw ""
raw "response body:"
cat /tmp/hs-resp.json | jq '.' >> "$REPORT"

sec "S4b REST /api/servers (post-daemon-up)"
curl -sS "$BASE/api/servers" -H "Authorization: Bearer $UTOK" | jq '.' >> "$REPORT"

# ── S5 MCP list_host_supervisors (populated) ────────────────────────────
sec "S5 MCP list_host_supervisors (populated) — the tool the dashboard's wizard actually calls"
MCP_LIST=$(mcp_call "$DEMO_HOST_TOK" "list_host_supervisors" "{}")
echo "$MCP_LIST" | jq '.' >> "$REPORT"

# extract daemon_node_id for the create_node round-trip
DAEMON_NODE_ID=$(echo "$MCP_LIST" | jq -r '.daemons[0].daemon_node_id // empty')
rec "extracted daemon_node_id" "${DAEMON_NODE_ID:-<none>}"

# ── S6 wizard end-to-end — can it really create a node? ────────────────
sec "S6 create_node MCP — full wizard action end-to-end"

if [[ -n "$DAEMON_NODE_ID" ]]; then
  # Payload matches what the wizard would send — create_node MCP tool
  # takes nested node_spec (tools.ts:2059-2067). Corrected after first-run
  # observed "Invalid arguments: node_spec expected object, received undefined".
  CREATE_ARGS=$(jq -nc \
    --arg d "$DAEMON_NODE_ID" \
    --arg net "$NET_ID" \
    '{
       daemon_node_id: $d,
       network_id: $net,
       node_spec: {
         name: "child-a",
         runtime: "claude-agent-sdk",
         model: "claude-sonnet-4-5",
         flags: { dangerouslySkipPermissions: true }
       }
     }')
  CREATE_RESP=$(mcp_call "$UTOK" "create_node" "$CREATE_ARGS" 2>&1 || true)
  raw "create_node response:"
  echo "$CREATE_RESP" | jq '.' >> "$REPORT" 2>>"$REPORT" || echo "$CREATE_RESP" >> "$REPORT"

  # Query the created row (if any)
  raw ""
  raw "hub nodes table after create_node:"
  # We can't sqlite3 from here — nodes DB is on hub side. Query via /api/nodes.
  curl -sS "$BASE/api/nodes?network_id=$NET_ID" -H "Authorization: Bearer $UTOK" \
    | jq '.nodes // .' >> "$REPORT" 2>&1
else
  raw "  daemon_node_id was empty — cannot call create_node"
fi

# ── S7 verdict ──────────────────────────────────────────────────────────
sec "S7 verdict — did gateway topology change anything?"

ONLINE=$(cat /tmp/hs-resp.json | jq -r '.daemons[0].online // false')
CPU_CORES=$(cat /tmp/hs-resp.json | jq -r '.daemons[0].host_telemetry.cpu_cores // "null"')
MEM_GB=$(cat /tmp/hs-resp.json | jq -r '.daemons[0].host_telemetry.mem_gb // "null"')
COUNT=$(cat /tmp/hs-resp.json | jq -r '.count // 0')

rec "daemon online (post-fix)" "$ONLINE"
rec "daemon cpu_cores"         "$CPU_CORES"
rec "daemon mem_gb"            "$MEM_GB"
rec "list count"               "$COUNT"

raw ""
if [[ "$ONLINE" == "true" && "$COUNT" != "0" && "$CPU_CORES" != "null" ]]; then
  raw "  ▶ VERDICT: Gateway topology fully works. #380 root observation was a"
  raw "    timing artefact of an earlier dashboard poll before reportStatus"
  raw "    landed. No telemetry bug. Fix is dashboard-side polling / cache."
else
  raw "  ▶ VERDICT: Gateway topology DOES break something. See S3 for the"
  raw "    daemon-side log (any register errors?) and S4 for the hub view."
fi

raw ""
raw "count=0 side-quest — 'hub 400' truth table:"
raw "  - REST /api/host-supervisors WITH  network_id, empty list  → HTTP $EMPTY_WITH_NET, body has count:0 + daemons:[]"
raw "  - REST /api/host-supervisors WITHOUT network_id            → HTTP $EMPTY_NO_NET, body: {ok:false, error:'missing_network_id'} or 200 (if fix landed + single-network)"

# ── S8 fix-A e2e: fallback path over gateway topology ────────────────
sec "S8 修 A e2e — utok fallback via singleNetworkId (single-network NON-admin user)"

# Register a SECOND user in this hub — subsequent users aren't
# auto-admin, so their utok exercises the fallback branch (admin gets
# scope.networkIds=null and correctly requires an explicit network_id
# because they can span all networks).
NORMAL_USER="normal_$(date +%s)_$$"
NORMAL_PW="StrongUserPw123Aa!"
NORMAL_RESP=$(json_post "/api/auth/register" "" \
  "{\"username\":\"$NORMAL_USER\",\"password\":\"$NORMAL_PW\"}")
NORMAL_UTOK=$(echo "$NORMAL_RESP" | jq -r '.token // empty')
NORMAL_NET=$(echo "$NORMAL_RESP" | jq -r '.network_id // empty')
rec "normal user utok prefix" "${NORMAL_UTOK:0:12}..."
rec "normal user default network" "$NORMAL_NET"

# Mint a demo-host2 ntok in the normal user's default network + register
# a daemon there so /api/host-supervisors has something to return.
NORMAL_HOST_TOK=$(json_post "/api/auth/node-token" "$NORMAL_UTOK" \
  "{\"network_id\":\"$NORMAL_NET\",\"node_name\":\"demo-host2\"}" | jq -r '.token // empty')

NORMAL_DAEMON_DIR="$HOME/.anet/nodes/demo-host2"
mkdir -p "$NORMAL_DAEMON_DIR"
NORMAL_NODE_ID="n_$(head -c 8 /dev/urandom | od -An -txC | tr -d ' \n')"
cat > "$NORMAL_DAEMON_DIR/config.json" <<CFG2
{
  "node_id": "$NORMAL_NODE_ID",
  "node_name": "demo-host2",
  "alias": "demo-host2",
  "runtime": "claude-agent-sdk",
  "role": "host_supervisor",
  "runtimes_supported": ["claude-agent-sdk"],
  "allowed_secret_keys": [],
  "max_concurrent_children": 20,
  "network_id": "$NORMAL_NET",
  "hub": "$BASE",
  "token": "$NORMAL_HOST_TOK",
  "model": "claude-sonnet-4-5",
  "channels": [],
  "env": {},
  "flags": { "dangerouslySkipPermissions": true, "teammateMode": true },
  "session": null
}
CFG2

( env "COMMHUB_ALIAS=demo-host2" "COMMHUB_NODE_ID=$NORMAL_NODE_ID" \
      "COMMHUB_TOKEN=$NORMAL_HOST_TOK" "COMMHUB_URL=$BASE" \
      "ANET_CONFIG_UPDATE_CAPABLE=1" "PATH=$PATH" "HOME=$HOME" \
    agent-node --config "$NORMAL_DAEMON_DIR/config.json" \
               --alias demo-host2 \
               --runtime claude-agent-sdk >/tmp/daemon2.log 2>&1 ) &
NORMAL_DAEMON_PID=$!
sleep 10

# Now the fallback test: NORMAL_UTOK belongs to a single-network user,
# calling /api/host-supervisors WITHOUT ?network_id should succeed and
# list demo-host2.
FALLBACK_STATUS=$(curl -sS -o /tmp/fallback.json -w '%{http_code}' \
  "$BASE/api/host-supervisors" -H "Authorization: Bearer $NORMAL_UTOK")
rec "REST /api/host-supervisors (no query, non-admin single-net) status" "$FALLBACK_STATUS"
raw ""
raw "fallback body (non-admin single-net):"
cat /tmp/fallback.json | jq '.' >> "$REPORT"

FALLBACK_COUNT=$(cat /tmp/fallback.json | jq -r '.count // 0')
if [[ "$FALLBACK_STATUS" == "200" && "$FALLBACK_COUNT" -ge 1 ]]; then
  raw ""
  raw "  ▶ FIX-A VERIFIED: single-network non-admin utok fallback works"
  raw "    (HTTP 200, count=$FALLBACK_COUNT includes demo-host2)"
else
  raw ""
  raw "  ▶ FIX-A REGRESSION: expected 200 + count>=1, got HTTP=$FALLBACK_STATUS count=$FALLBACK_COUNT"
fi

# Compare: admin utok WITHOUT ?network_id — this still 400s (admin can
# span every network, no safe pick). This locks the authz boundary.
sec "S8b authz boundary — admin utok WITHOUT ?network_id still 400s (admin can't be fallen back)"
ADMIN_NO_NET=$(curl -sS -o /tmp/admin-no-net.json -w '%{http_code}' \
  "$BASE/api/host-supervisors" -H "Authorization: Bearer $UTOK")
rec "REST /api/host-supervisors (admin, no query) status" "$ADMIN_NO_NET"
raw ""
raw "admin-no-query body:"
cat /tmp/admin-no-net.json | jq '.' >> "$REPORT"

if [[ "$ADMIN_NO_NET" == "400" ]]; then
  raw ""
  raw "  ▶ AUTHZ BOUNDARY VERIFIED: admin without ?network_id still 400 (no cross-network guessing)"
else
  raw ""
  raw "  ▶ AUTHZ REGRESSION: admin should stay 400, got $ADMIN_NO_NET"
fi

# clean up demo-host2 daemon before compose down
kill "$NORMAL_DAEMON_PID" 2>/dev/null || true
raw ""
raw "  So 'hub 400' means the client omitted network_id — NOT that no daemons"
raw "  exist. If prod dashboard reports hub 400 in the create-node wizard,"
raw "  the fix is: send network_id in the request, or fall back client-side"
raw "  to the user's active network."

echo
echo "===== REPORT ====="
cat "$REPORT"

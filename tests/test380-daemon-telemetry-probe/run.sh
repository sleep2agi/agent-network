#!/usr/bin/env bash
# P0/P1 #380 daemon telemetry probe — mirror 通信龙's environment, capture
# the ACTUAL heartbeat payload + DB state so we can tell A (version drift) /
# B (host: field null) / C (config_snapshot slow) apart with real numbers.
#
# Not testing dashboard directly here; probing the raw wire so a fix can be
# scoped without guessing.

set -euo pipefail

export HOME=/tmp/anethome
export COMMHUB_DB=/tmp/qa-380-hub.db
export PORT=9310
BASE="http://127.0.0.1:${PORT}"
REPORT="/repo/docs/tests/p380-daemon-telemetry-probe/report.txt"
LOGFILE="/tmp/hub.log"
DAEMON_LOG="/tmp/daemon.log"
mkdir -p "$(dirname "$REPORT")" "$HOME/.anet"

cleanup() {
  { kill "${DAEMON_PID:-0}" 2>/dev/null || true; } &
  { kill "${HUB_PID:-0}" 2>/dev/null || true; } &
  wait 2>/dev/null || true
}
trap cleanup EXIT

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

: > "$REPORT"
cat >> "$REPORT" <<HDR
# test380-daemon-telemetry-probe

Environment mirror of 通信龙's #380 repro (with local-container topology).
- OS: node:22-bookworm-slim (Linux)
- agent-network + agent-node: installed via npm from @preview tag
- Hub: /repo/server bun-run on port $PORT, isolated DB $COMMHUB_DB
- No connection to production or fleet :9200.

HDR

# ── Step 0: baseline environment probe ──────────────────────────────────
sec "S0 environment"
rec "linux kernel" "$(uname -a)"
rec "node" "$(node --version)"
rec "bun" "$(bun --version)"
rec "installed agent-network" "$(anet --version 2>/dev/null || echo '(missing)')"
rec "installed agent-node" "$(agent-node --version 2>/dev/null || echo '(missing)')"
rec "which agent-node" "$(command -v agent-node || echo '(none)')"
rec "PATH" "$PATH"

# The critical A-hypothesis probe: is the binary that DAEMON will spawn
# actually preview.17 (or later)?
NPM_PREVIEW_VER=$(npm view @sleep2agi/agent-node@preview version 2>&1 | tail -1)
NPM_PREVIEW_LATEST=$(npm view @sleep2agi/agent-node@latest version 2>&1 | tail -1)
rec "@sleep2agi/agent-node@preview (npm)" "$NPM_PREVIEW_VER"
rec "@sleep2agi/agent-node@latest (npm)" "$NPM_PREVIEW_LATEST"

# The B-hypothesis pre-check: are /proc/loadavg and /proc/meminfo readable,
# does df -k / return sane values? host-telemetry.ts:61-138 depends on these.
sec "S0b B-hypothesis pre-check — /proc + df access from slim image"
if [[ -r /proc/loadavg ]]; then
  raw "/proc/loadavg:"; cat /proc/loadavg | head -1 >> "$REPORT"
else
  raw "/proc/loadavg: NOT READABLE"
fi
if [[ -r /proc/meminfo ]]; then
  raw ""; raw "/proc/meminfo head:"; grep -E "^(MemTotal|MemAvailable|MemFree):" /proc/meminfo >> "$REPORT"
else
  raw "/proc/meminfo: NOT READABLE"
fi
raw ""; raw "df -k / output:"
df -k / >> "$REPORT" 2>&1 || raw "  df failed"

# ── Step 1: start isolated hub ───────────────────────────────────────────
sec "S1 start isolated hub on :$PORT"
rm -f "$COMMHUB_DB"
bun run server/src/index.ts >"$LOGFILE" 2>&1 &
HUB_PID=$!
for _ in {1..80}; do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/health" >/dev/null || { rec "hub health" "TIMEOUT"; tail -80 "$LOGFILE" >> "$REPORT"; exit 1; }
rec "hub pid" "$HUB_PID"
rec "hub health" "OK"

# ── Step 2: bootstrap admin + network + mint ntok for demo-host ─────────
ADMIN=$(json_post "/api/auth/register" "" '{"username":"admin","password":"anethub"}')
UTOK=$(echo "$ADMIN" | jq -r '.token // empty')
[[ "$UTOK" == utok_* ]] || { echo "register failed: $ADMIN" | tee -a "$REPORT"; exit 1; }

NET=$(json_post "/api/networks" "$UTOK" '{"name":"n-380"}')
NET_ID=$(echo "$NET" | jq -r '.network.network_id // .network_id // empty')
[[ -n "$NET_ID" ]] || { echo "network failed: $NET" | tee -a "$REPORT"; exit 1; }

DEMO_HOST_TOK=$(json_post "/api/auth/node-token" "$UTOK" \
  "{\"network_id\":\"$NET_ID\",\"node_name\":\"demo-host\"}" | jq -r '.token // empty')
[[ "$DEMO_HOST_TOK" == ntok_* ]] || { echo "mint failed"; exit 1; }

sec "S2 setup"
rec "network_id" "$NET_ID"
rec "demo-host ntok prefix" "${DEMO_HOST_TOK:0:12}..."

# ── Step 3: write a daemon config that mirrors `anet daemon init` output ─
sec "S3 write config.json for daemon (matches anet daemon init at bin/cli.ts:4098-4117)"

DAEMON_DIR="$HOME/.anet/nodes/demo-host"
mkdir -p "$DAEMON_DIR"
NODE_ID="n_$(head -c 8 /dev/urandom | od -An -txC | tr -d ' \n')"
cat > "$DAEMON_DIR/config.json" <<CFG
{
  "anet_version": "test-probe",
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

# ── Step 4: spawn the daemon exactly as anet daemon start would ─────────
# From bin/cli.ts:2701-2785 (spawn args for claude-agent-sdk runtime).
# We call agent-node directly with the same argv the launcher would use.
sec "S4 spawn daemon (mirror agent-network launcher: --config --alias --runtime)"

if ! command -v agent-node >/dev/null; then
  rec "spawn" "agent-node not on PATH — cannot proceed"
  exit 1
fi

DAEMON_ARGS=(
  --config "$DAEMON_DIR/config.json"
  --alias  demo-host
  --runtime claude-agent-sdk
)

env_common=(
  "COMMHUB_ALIAS=demo-host"
  "COMMHUB_NODE_ID=$NODE_ID"
  "COMMHUB_TOKEN=$DEMO_HOST_TOK"
  "COMMHUB_URL=$BASE"
  "ANET_CONFIG_UPDATE_CAPABLE=1"
  "PATH=$PATH"
  "HOME=$HOME"
)

# Fire in background; daemon may exit if runtime init fails (no anthropic
# key), but register() and immediate reportStatus() run BEFORE runtime
# engagement. So the payload should land regardless.
( env "${env_common[@]}" agent-node "${DAEMON_ARGS[@]}" >"$DAEMON_LOG" 2>&1 ) &
DAEMON_PID=$!
rec "daemon spawn pid" "$DAEMON_PID"

# Wait for register + immediate reportStatus to land. From cli.ts:4085-4096
# these fire on boot within a few seconds — 8s is a generous ceiling.
sleep 8

# ── Step 5: capture evidence ─────────────────────────────────────────────
sec "S5 hub log — report_status accepted lines (tools.ts:391 print format)"

# Line format is: "[hh:mm:ss] <alias> (<resume8>) → report_status: <status>"
grep -E "→ report_status:" "$LOGFILE" | head -20 >> "$REPORT" || raw "  (no report_status lines yet)"

sec "S5b daemon log head (last 60 lines)"
tail -60 "$DAEMON_LOG" >> "$REPORT" 2>&1

sec "S6 SQL dump — sessions row for demo-host (register()'s target)"
sqlite3 -header -column "$COMMHUB_DB" \
  "SELECT alias, node_id, hostname, ip, status,
          cpu_load_1min, cpu_cores,
          mem_total_gb, mem_used_gb, mem_avail_gb,
          disk_total_gb, disk_used_gb, disk_avail_gb,
          last_seen_at, updated_at
     FROM sessions WHERE alias='demo-host'" >> "$REPORT" 2>&1

sec "S6b SQL dump — nodes row for demo-host (config_snapshot's target)"
sqlite3 -header -column "$COMMHUB_DB" \
  "SELECT alias, node_id, runtime, model, hostname,
          CASE WHEN config_snapshot IS NULL THEN 'NULL'
               WHEN config_snapshot='' THEN 'EMPTY'
               ELSE 'HAS_VALUE ('||length(config_snapshot)||' bytes)' END AS snapshot_status,
          runtimes_supported, allowed_secret_keys,
          updated_at
     FROM nodes WHERE alias='demo-host'" >> "$REPORT" 2>&1
# Note: max_concurrent_children is NOT a column in nodes; it lives inside
# the config_snapshot JSON blob only (PR3 nit didn't promote it, see
# tools.ts:320 comment). We probe the JSON body separately at S6c.

# If snapshot has value, extract the interesting bits
sec "S6c nodes.config_snapshot content (if any)"
SNAPSHOT=$(sqlite3 "$COMMHUB_DB" "SELECT config_snapshot FROM nodes WHERE alias='demo-host'")
if [[ -n "$SNAPSHOT" && "$SNAPSHOT" != "NULL" ]]; then
  echo "$SNAPSHOT" | jq '.' >> "$REPORT" 2>>"$REPORT" || echo "$SNAPSHOT" >> "$REPORT"
else
  raw "  (empty / NULL — config_snapshot never landed)"
fi

sec "S6d agent_telemetry insert count for demo-host"
sqlite3 -header -column "$COMMHUB_DB" \
  "SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last
     FROM agent_telemetry WHERE alias='demo-host'" >> "$REPORT" 2>&1

# ── Step 7: the /api/servers view (dashboard sees this) ──────────────────
sec "S7 /api/servers response (what Servers page reads)"
curl -sS "$BASE/api/servers" -H "Authorization: Bearer $UTOK" | jq '.' >> "$REPORT" 2>&1

sec "S7b /api/host-supervisors response (create-node wizard reads this)"
curl -sS "$BASE/api/host-supervisors?network_id=$NET_ID" -H "Authorization: Bearer $UTOK" | jq '.' >> "$REPORT" 2>&1

# ── Step 8: verdict — which of A/B/C fired? ─────────────────────────────
sec "S8 verdict — A/B/C classification"

CPU_LOAD=$(sqlite3 "$COMMHUB_DB" "SELECT cpu_load_1min FROM sessions WHERE alias='demo-host'" 2>/dev/null || echo "")
MEM_TOTAL=$(sqlite3 "$COMMHUB_DB" "SELECT mem_total_gb FROM sessions WHERE alias='demo-host'" 2>/dev/null || echo "")
SESSION_LAST_SEEN=$(sqlite3 "$COMMHUB_DB" "SELECT last_seen_at FROM sessions WHERE alias='demo-host'" 2>/dev/null || echo "")
SNAPSHOT_SET=$(sqlite3 "$COMMHUB_DB" "SELECT CASE WHEN config_snapshot IS NULL OR config_snapshot='' THEN 'NO' ELSE 'YES' END FROM nodes WHERE alias='demo-host'" 2>/dev/null || echo "NO_ROW")
HB_LINES=$(grep -c "→ report_status" "$LOGFILE" 2>/dev/null || echo 0)

rec "cpu_load_1min in sessions" "${CPU_LOAD:-<null>}"
rec "mem_total_gb in sessions"  "${MEM_TOTAL:-<null>}"
rec "sessions.last_seen_at"     "${SESSION_LAST_SEEN:-<empty>}"
rec "nodes.config_snapshot"     "$SNAPSHOT_SET"
rec "report_status accepted lines in hub log" "$HB_LINES"

raw ""
raw "Hypothesis classification:"
if [[ "$HB_LINES" -eq 0 ]]; then
  raw "  ▶ heartbeat never reached hub — check auth / URL / network"
elif [[ -z "$CPU_LOAD" || "$CPU_LOAD" == "" ]]; then
  raw "  ▶ heartbeat reached hub, but host telemetry columns are null → B (or A: agent-node was older)."
  raw "    Combined with agent-node --version above, determines A vs B."
  raw "    B: /proc access above shows whether host-telemetry.ts would have gotten values."
else
  raw "  ▶ heartbeat reached hub and cpu/mem are present → register()'s host: payload lands."
  raw "    If config_snapshot=NO the wizard fails while Servers page shows online — that's C."
fi

if [[ "$SNAPSHOT_SET" == "NO" ]]; then
  raw ""
  raw "  ▶ nodes.config_snapshot is unset even after 8s wait."
  raw "    Immediate reportStatus() at cli.ts:4095 either failed silently or hasn't fired yet."
  raw "    This directly explains list_host_supervisors returning 0 → create-node wizard 'hub 400'."
fi

raw ""
raw "Boot log first 5 hub log lines for context:"
head -5 "$LOGFILE" | sed 's/^/  /' >> "$REPORT"

echo
echo "===== REPORT ====="
cat "$REPORT"
echo
echo "REPORT saved to $REPORT"

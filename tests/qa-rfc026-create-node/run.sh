#!/usr/bin/env bash
# RFC-026 P1 create-node + host-daemon e2e.
# M2 milestone: scenario A is now LIVE (no longer stub).
# B-K remain Phase 0 stubs pending impl in subsequent commits.

set -uo pipefail

HUB_PORT=9235
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=/tmp/qa-rfc026-hub.db
ADMIN_USER="rfc026admin"
ADMIN_PW="rfc026_TestPass_1234!"
DAEMON_NAME="daemon-rfc026"
CHILD_NAME="demo-child"
WORK=/tmp/rfc026-work

PASS=0; FAIL=0; SKIP=0

note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
stub() { printf "  ⊘ %s — stub (Phase 0 scaffold): %s\n" "$1" "$2"; SKIP=$((SKIP+1)); }

# ── shared helpers ────────────────────────────────────────────────
mcp_init_once() {
  curl -sS -X POST "$HUB_BASE/mcp" \
    -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"qa-rfc026","version":"0"}}}' \
    >/dev/null 2>&1 || true
}
mcp_call() {
  # args: utok, jsonrpc-body
  local tok="$1" body="$2"
  local resp=$(curl -sS -X POST "$HUB_BASE/mcp" \
    -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "$body")
  local inner=$(echo "$resp" | grep -oP '(?<=data: ).+' | head -1 | jq -r '.result.content[0].text' 2>/dev/null)
  if [[ -z "$inner" || "$inner" == "null" ]]; then
    inner=$(echo "$resp" | jq -r '.result.content[0].text' 2>/dev/null)
  fi
  [[ -z "$inner" || "$inner" == "null" ]] && echo "$resp" || echo "$inner"
}

# ── 0. Boot hub + register admin + mint utok ──────────────────────
note "0. boot hub + admin user + utok"
rm -f "$HUB_DB" "${HUB_DB}-shm" "${HUB_DB}-wal" 2>/dev/null
mkdir -p "$WORK"
cd /app/server
PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" bun run src/index.ts \
  >/tmp/hub.log 2>&1 &
HUB_PID=$!
for i in {1..60}; do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null && ok "hub /health 200 :$HUB_PORT" || { bad "hub did not start"; tail -50 /tmp/hub.log; exit 1; }

REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"email\":\"r026@test.local\"}")
UTOK=$(echo "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint failed: $REG"; exit 1; }
mcp_init_once "$UTOK"

NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r .networks[0].network_id)
[[ -n "$NET_ID" && "$NET_ID" != "null" ]] && ok "default network = $NET_ID" || { bad "no network"; exit 1; }

# ── Scenario A — LIVE ─────────────────────────────────────────────
note "A. admin create succeeds end-to-end (real fork + real register)"

# 0.A.1 — mint ntok for daemon + register daemon node row
DAEMON_NTOK_RESP=$(curl -sS -X POST "$HUB_BASE/api/auth/node-token" \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"$DAEMON_NAME\"}")
DAEMON_NTOK=$(echo "$DAEMON_NTOK_RESP" | jq -r .token)
[[ "$DAEMON_NTOK" == ntok_* ]] && ok "daemon ntok minted" || { bad "daemon ntok mint: $DAEMON_NTOK_RESP"; exit 1; }
DAEMON_NODE_ID="node_daemon_rfc026_$(date +%s%N | sha256sum | head -c 12)"

# 0.A.2 — stage daemon config with role=host_supervisor
mkdir -p "$WORK/.anet/nodes/$DAEMON_NAME"
cat > "$WORK/.anet/nodes/$DAEMON_NAME/config.json" <<EOF
{
  "node_id": "$DAEMON_NODE_ID",
  "node_name": "$DAEMON_NAME",
  "alias": "$DAEMON_NAME",
  "role": "host_supervisor",
  "runtime": "claude-agent-sdk",
  "model": "claude-opus-original",
  "hub": "http://127.0.0.1:$HUB_PORT",
  "token": "$DAEMON_NTOK"
}
EOF

# 0.A.3 — start daemon node (install-time ANET_BIN_ABS via env)
cd "$WORK"
ANET_BIN_ABS=$(realpath -e "$(which anet)")
ANET_BIN_ABS=$ANET_BIN_ABS nohup anet node start "$DAEMON_NAME" > /tmp/daemon.log 2>&1 &
DAEMON_PID=$!

# 0.A.4 — wait for daemon to register
REGISTERED=""
for i in $(seq 1 30); do
  sleep 1
  R=$(curl -sS "$HUB_BASE/api/nodes?node_id=$DAEMON_NODE_ID" -H "Authorization: Bearer $UTOK")
  if echo "$R" | jq -e ".nodes[0].node_id == \"$DAEMON_NODE_ID\"" >/dev/null 2>&1; then
    REGISTERED=yes; break
  fi
done
[[ -n "$REGISTERED" ]] && ok "daemon registered ($DAEMON_NAME / $DAEMON_NODE_ID)" || { bad "daemon never registered"; tail -50 /tmp/daemon.log; tail -30 /tmp/hub.log; exit 1; }

# A.1 — dashboard creates a node via MCP create_node
BODY=$(cat <<JSON
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_node","arguments":{
  "daemon_node_id":"$DAEMON_NODE_ID",
  "node_spec":{
    "name":"$CHILD_NAME",
    "runtime":"claude-agent-sdk",
    "model":"claude-opus-rfc026-child"
  },
  "network_id":"$NET_ID"
}}}
JSON
)
RESP=$(mcp_call "$UTOK" "$BODY")
REQUEST_ID=$(echo "$RESP" | jq -r .request_id 2>/dev/null)
if [[ "$REQUEST_ID" != cr_* ]]; then
  bad "create_node dispatch failed: $RESP"
  tail -30 /tmp/hub.log
  exit 1
fi
ok "create_node dispatched (request_id=$REQUEST_ID)"

# A.2 — poll node_create_requests via direct REST (no endpoint yet — use api/nodes for child)
SUCCEEDED=""
T0=$(date +%s.%N)
for i in $(seq 1 90); do
  sleep 1
  CHILD_ROW=$(curl -sS "$HUB_BASE/api/nodes" -H "Authorization: Bearer $UTOK" \
    | jq -r ".nodes[] | select(.alias == \"$CHILD_NAME\") | .node_id" 2>/dev/null | head -1)
  if [[ -n "$CHILD_ROW" && "$CHILD_ROW" != "null" ]]; then
    T1=$(date +%s.%N); EL=$(echo "$T1-$T0" | bc 2>/dev/null || echo "?")
    ok "child node registered: $CHILD_NAME / $CHILD_ROW in ${EL}s (iter $i)"
    SUCCEEDED=yes
    break
  fi
done
if [[ -z "$SUCCEEDED" ]]; then
  bad "child never registered within 90s"
  echo "=== daemon log (last 60 lines) ==="
  tail -60 /tmp/daemon.log
  echo "=== hub log (last 30) ==="
  tail -30 /tmp/hub.log
else
  # status should be 'succeeded' (via content-match finalize)
  STATUS=$(sqlite3 "$HUB_DB" "SELECT status FROM node_create_requests WHERE request_id='$REQUEST_ID';" 2>/dev/null)
  [[ "$STATUS" == "succeeded" ]] && ok "node_create_requests.status = succeeded" || bad "status = '$STATUS' (expected 'succeeded')"
  # env_blob field MUST be absent from schema (F1 lock)
  HAS_ENV=$(sqlite3 "$HUB_DB" "PRAGMA table_info(node_create_requests);" | grep -c env_blob || true)
  [[ "$HAS_ENV" == "0" ]] && ok "node_create_requests has NO env_blob column (F1 lock)" || bad "env_blob column present (F1 violated)"
fi

# B-K stubs — still pending impl ──────────────────────────────────
note "B. member/viewer role gate"
stub "B" "non-admin utok → 403 insufficient_role_for_create_node"
note "C. cross-tenant SEC-1"
stub "C" "netA admin → netB daemon rejected"
note "D. secret 不落库 (F1 mint-stream-evict)"
stub "D" "env_blob 不在 DB; hub Map evict after daemon get"
note "E. name/runtime/flag 注入 (F2)"
stub "E" "name=\";rm -rf /\" / runtime=bash / flags='DROP TABLE' all rejected hub+daemon"
note "F. daemon_max_children backpressure"
stub "F" "N+1 hub-side rejected"
note "G. env_refs 严格 (6 sub-case)"
stub "G" "G1-G9 incl. G7 PATH / G8 LD_PRELOAD / G9 drift guard"
note "H. daemon node_id 强绑 (C2)"
stub "H" "daemonB cannot get/ack daemonA request"
note "I. ANET_BIN install-time pin + PATH 投毒 (C3)"
stub "I" "I1 path.conf + 4-check / I2 PATH 投毒不影响 / I3 mock inject reserved → minimalEnv throw"
note "J. mint-evict 失败 → orphan revoke (C4)"
stub "J" "J1 hub crash F-1 / J2 daemon crash F-2"
note "K. channels fail-closed (C5)"
stub "K" "non-empty channels rejected hub+daemon"

# ── cleanup ───────────────────────────────────────────────────────
kill "$DAEMON_PID" 2>/dev/null || true
kill "$HUB_PID" 2>/dev/null || true

printf "\n────────────────────────────────────────────\n"
printf "RFC-026 P1 e2e — PASS=%d FAIL=%d SKIP=%d\n" "$PASS" "$FAIL" "$SKIP"
printf "M2 milestone: scenario A live (real fork → child register → finalize)\n"
printf "B-K stubs pending Phase 2-3 impl per 通信龙 milestone plan\n"
printf "────────────────────────────────────────────\n"
[[ "$FAIL" -eq 0 ]]

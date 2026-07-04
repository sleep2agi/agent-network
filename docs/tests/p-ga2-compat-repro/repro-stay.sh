#!/usr/bin/env bash
# Same as repro.sh but keeps hub + daemon alive so the host can point
# a dashboard prod build at them for Playwright drive.
#
# Persists the admin utok + network_id to /shared/admin.env so the
# host can source it for cookie-inject + hubFetch fallback.

set -uo pipefail

HUB_PORT=9234
HUB_BASE="http://0.0.0.0:${HUB_PORT}"
HUB_DB=/tmp/ga2-hub.db
export COMMHUB_DB="${HUB_DB}"
export HOME=/root
mkdir -p /root/.anet /shared

echo "=== 0. hub boot (bound to 0.0.0.0 for host access) ==="
PORT="${HUB_PORT}" HOST=0.0.0.0 NODE_ENV=production commhub-server >/tmp/hub.log 2>&1 &
HUB_PID=$!
for _ in {1..60}; do curl -fsS "http://127.0.0.1:${HUB_PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:${HUB_PORT}/health" >/dev/null && echo "  ✓ hub /health 200" || { tail /tmp/hub.log; exit 1; }

echo "=== 1. register admin ==="
REG=$(curl -sS -X POST "http://127.0.0.1:${HUB_PORT}/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"username":"ga2admin","password":"GA2!TestP@ss","email":"ga2@test.local"}')
UTOK=$(echo "$REG" | jq -r '.token')
NET_ID=$(curl -sS "http://127.0.0.1:${HUB_PORT}/api/auth/me" -H "Authorization: Bearer ${UTOK}" | jq -r '.networks[0].network_id')
echo "  ✓ admin utok minted; network_id=${NET_ID}"

# Persist for the host to grab.
cat > /shared/admin.env <<EOF
UTOK=${UTOK}
NET_ID=${NET_ID}
HUB_BASE=http://127.0.0.1:${HUB_PORT}
EOF

echo "=== 2. global anet config ==="
cat > /root/.anet/config.json <<EOF
{
  "hub": "http://127.0.0.1:${HUB_PORT}",
  "token": "${UTOK}",
  "network_id": "${NET_ID}"
}
EOF

echo "=== 3. anet daemon up ga-daemon ==="
# ANET_BIN_ABS pins the anet binary path so the daemon can safely fork
# child agent-nodes without a PATH-shadow attack surface. Without this
# (or /etc/anet-daemon/path.conf), create_node dispatches fail with
# `anet_bin_unsafe_path`.
export ANET_BIN_ABS="$(realpath -e "$(which anet)")"
echo "  ANET_BIN_ABS=${ANET_BIN_ABS}"
nohup anet daemon up ga-daemon > /tmp/daemon.log 2>&1 &
DAEMON_PID=$!

# Wait for the daemon row + snapshot to appear.
for i in $(seq 1 30); do
  sleep 1
  ROW=$(curl -sS "http://127.0.0.1:${HUB_PORT}/api/nodes" -H "Authorization: Bearer ${UTOK}" 2>/dev/null \
    | jq -r '.nodes[] | select(.alias == "ga-daemon") | select(.role == "host_supervisor")')
  if [[ -n "$ROW" ]]; then
    echo "  ✓ daemon fully upsert'd after ${i}s (role=host_supervisor)"
    echo "$ROW" | jq -c '{node_id, alias, role, config_revision}'
    break
  fi
done

echo "=== 4. list_host_supervisors sanity ==="
curl -sS "http://127.0.0.1:${HUB_PORT}/api/host-supervisors?network_id=${NET_ID}" -H "Authorization: Bearer ${UTOK}" \
  | jq '{ok, count, aliases: [.daemons[].alias]}'

echo
echo "=== READY ==="
echo "  hub  → http://<container-ip>:${HUB_PORT}"
echo "  admin utok + net_id at /shared/admin.env"
echo "  keeping alive; SIGTERM to stop"

# Hold alive until someone kills us.
trap 'kill "$DAEMON_PID" "$HUB_PID" 2>/dev/null || true; exit 0' TERM INT
wait

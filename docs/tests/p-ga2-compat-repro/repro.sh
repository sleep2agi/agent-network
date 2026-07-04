#!/usr/bin/env bash
# GA-blocker #2 reproduction. No workaround, no bounce — just start
# the aligned versions the way an operator would and observe what the
# hub's node row looks like a few seconds after `anet daemon up`.

set -uo pipefail

HUB_PORT=9234
HUB_BASE="http://127.0.0.1:${HUB_PORT}"
HUB_DB=/tmp/ga2-hub.db
export COMMHUB_DB="${HUB_DB}"
export HOME=/root
mkdir -p /root/.anet

echo "=== 0. hub boot (commhub-server 0.9.0-preview.21) ==="
PORT="${HUB_PORT}" HOST=127.0.0.1 NODE_ENV=production commhub-server >/tmp/hub.log 2>&1 &
HUB_PID=$!
for _ in {1..60}; do curl -fsS "${HUB_BASE}/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "${HUB_BASE}/health" >/dev/null && echo "  ✓ hub /health 200 :${HUB_PORT}" || { tail /tmp/hub.log; exit 1; }

echo "=== 1. register admin ==="
REG=$(curl -sS -X POST "${HUB_BASE}/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"username":"ga2admin","password":"GA2!TestP@ss","email":"ga2@test.local"}')
UTOK=$(echo "$REG" | jq -r '.token')
NET_ID=$(curl -sS "${HUB_BASE}/api/auth/me" -H "Authorization: Bearer ${UTOK}" | jq -r '.networks[0].network_id')
echo "  ✓ admin utok minted; network_id=${NET_ID}"

echo "=== 2. persist hub + token to global anet config (mirrors post-login state) ==="
mkdir -p /root/.anet
cat > /root/.anet/config.json <<EOF
{
  "hub": "${HUB_BASE}",
  "token": "${UTOK}",
  "network_id": "${NET_ID}"
}
EOF

echo "=== 3. anet daemon up ga-daemon  (init + start in one go) ==="
# Detached so we can keep querying the hub while the agent-node is up.
nohup anet daemon up ga-daemon > /tmp/daemon.log 2>&1 &
DAEMON_PID=$!

# Poll /api/nodes until the daemon row appears at all.
DAEMON_ROW=""
for i in $(seq 1 30); do
  sleep 1
  ROW=$(curl -sS "${HUB_BASE}/api/nodes" -H "Authorization: Bearer ${UTOK}" 2>/dev/null \
    | jq -r '.nodes[] | select(.alias == "ga-daemon")' 2>/dev/null)
  if [[ -n "$ROW" ]]; then
    DAEMON_ROW="$ROW"
    echo "  ✓ daemon row appeared after ${i}s"
    break
  fi
done

if [[ -z "$DAEMON_ROW" ]]; then
  echo "  ✗ daemon never registered — this is a different bug"
  tail /tmp/daemon.log
  exit 1
fi

echo
echo "=== 4. inspect for 40 seconds ==="
for pass in 1 5 10 15 20 25 30 35 40; do
  sleep 5 2>/dev/null || true
  ROW=$(curl -sS "${HUB_BASE}/api/nodes" -H "Authorization: Bearer ${UTOK}" \
    | jq -r '.nodes[] | select(.alias == "ga-daemon")')
  echo "--- ${pass}s ---"
  echo "$ROW" | jq -r '{node_id, alias, role, snapshot_len: (.config_snapshot | tostring | length)}'
done

echo
echo "=== 5. SQL-level truth (the column state as stored) ==="
sqlite3 "${HUB_DB}" \
  "SELECT node_id, alias, LENGTH(COALESCE(config_snapshot,'')) AS snap_len,
          SUBSTR(COALESCE(config_snapshot,''), 1, 400) AS snap
   FROM nodes WHERE alias = 'ga-daemon';"

echo
echo "=== 6. list_host_supervisors REST (what the picker actually reads) ==="
curl -sS "${HUB_BASE}/api/host-supervisors?network_id=${NET_ID}" -H "Authorization: Bearer ${UTOK}" | jq

echo
echo "=== 7. daemon side — recent stdout ==="
tail -40 /tmp/daemon.log

echo
echo "=== 8. hub side — recent stdout (looking for zod-parse / SEC refusals) ==="
tail -40 /tmp/hub.log

kill "$DAEMON_PID" 2>/dev/null || true
kill "$HUB_PID" 2>/dev/null || true

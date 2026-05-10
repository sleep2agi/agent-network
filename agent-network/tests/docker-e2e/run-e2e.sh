#!/usr/bin/env bash
# Hermetic Agent Network E2E. Spins up hub (local source), dashboard
# (preview tag), agent-node (preview tag) and runs Playwright in a
# container. Cleans up on exit. PASS / FAIL with a single command.
#
# Usage: ./run-e2e.sh [--keep] [--debug]
#   --keep   leave containers running after exit (handy for triage)
#   --debug  set bash -x

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --debug) set -x ;;
    -h|--help)
      grep -E "^# " "$0" | sed 's/^# \?//'
      exit 0 ;;
  esac
done

mkdir -p .tmp results
# Empty state file is a placeholder — the docker-compose mount needs the
# file to exist before the playwright container starts, even though we
# rewrite it before invoking the runner.
echo '{}' > .tmp/test-state.json

# Previous-run artifacts under results/ may have been written as root
# from inside the playwright container — nuke them via a same-uid
# container so the host doesn't need sudo.
if [ -n "$(ls -A results 2>/dev/null)" ]; then
  docker run --rm -v "$HERE/results":/r alpine sh -c 'rm -rf /r/* /r/.[!.]* 2>/dev/null || true' >/dev/null 2>&1 || true
fi

cleanup() {
  local rc=$?
  if [ $KEEP -eq 1 ]; then
    echo "[run-e2e] --keep: leaving containers up. State at .tmp/test-state.json"
  else
    echo "[run-e2e] cleanup: docker compose down -v"
    docker compose --project-name anet_e2e down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  # Wipe any /tmp scratch we may have used.
  rm -f /tmp/anet-e2e-*.tmp 2>/dev/null || true
  exit $rc
}
trap cleanup EXIT INT TERM

PROJECT="anet_e2e"
COMPOSE="docker compose --project-name $PROJECT --file $HERE/docker-compose.yml"

echo "================================================================"
echo "  Agent Network E2E"
echo "  hub source: $(realpath ../../../server)"
echo "  dashboard:  @sleep2agi/agent-network-dashboard@0.1.0-preview.7"
echo "  agent-node: @sleep2agi/agent-node@2.1.0-preview.13"
echo "================================================================"

# 0. Build images that bake their npm install. First run: ~3min.
#    Subsequent runs: cached, ~5s.
echo "[0/7] building images (cached after first run)..."
$COMPOSE build --quiet dashboard agent-node playwright

# 1. Start hub. We need the REST API up before we can register a user
#    + mint an ntok_ for the agent-node.
echo "[1/7] starting hub..."
$COMPOSE up -d hub

HUB_HOST_URL="http://localhost:9201"
DASH_HOST_URL="http://localhost:3001"

echo "[2/7] waiting for hub /health..."
for i in $(seq 1 60); do
  if curl -sf $HUB_HOST_URL/health >/dev/null 2>&1; then
    echo "       hub healthy"
    break
  fi
  sleep 1
  if [ "$i" = "60" ]; then
    echo "ERROR: hub never came up"
    $COMPOSE logs hub | tail -50
    exit 1
  fi
done

# 2. Register admin/anethub via REST. This gives us:
#    - utok_ (user token)
#    - ntok_ (default-network token, but for "default-network" not vbot)
#    - network_id
USERNAME="admin"
PASSWORD="anethub"

echo "[3/7] registering $USERNAME via /api/auth/register..."
REG=$(curl -s -X POST $HUB_HOST_URL/api/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")

# Hub returns {ok:false, error:"username already taken"} if an old run
# polluted the DB; we wiped the volume in cleanup so this should be
# fresh, but accept either path.
OK=$(echo "$REG" | python3 -c "import json,sys;print(json.load(sys.stdin).get('ok'))" 2>/dev/null || echo "false")

if [ "$OK" != "True" ]; then
  echo "       registration didn't succeed cleanly (probably already exists), trying login..."
  REG=$(curl -s -X POST $HUB_HOST_URL/api/auth/login \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")
fi

UTOK=$(echo "$REG" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('token') or '')")
NETWORK_ID=$(echo "$REG" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('network_id') or '')")
USER_ID=$(echo "$REG" | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('user') or {}).get('user_id') or '')")

if [ -z "$UTOK" ] || [ -z "$NETWORK_ID" ]; then
  echo "ERROR: failed to extract utok/network_id from auth response"
  echo "$REG"
  exit 1
fi
echo "       utok: ${UTOK:0:14}..."
echo "       network_id: $NETWORK_ID"

# 3. Mint a node token for vbot.
echo "[4/7] minting ntok_ for alias=vbot..."
NTOK_RESP=$(curl -s -X POST $HUB_HOST_URL/api/auth/node-token \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $UTOK" \
  -d "{\"network_id\":\"$NETWORK_ID\",\"node_name\":\"vbot\"}")
NTOK=$(echo "$NTOK_RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('token') or '')")
if [ -z "$NTOK" ]; then
  echo "ERROR: failed to mint ntok"
  echo "$NTOK_RESP"
  exit 1
fi
echo "       ntok: ${NTOK:0:14}..."

# 4. Persist test state for the playwright container to read.
cat > .tmp/test-state.json <<EOF
{
  "username": "$USERNAME",
  "password": "$PASSWORD",
  "utok": "$UTOK",
  "ntok": "$NTOK",
  "network_id": "$NETWORK_ID",
  "user_id": "$USER_ID",
  "alias": "vbot"
}
EOF

# 5. Drop a config.json into the agent-node mounted volume so the
#    container's wait-loop unblocks.
mkdir -p .tmp/agent-node/nodes/vbot
cat > .tmp/agent-node/nodes/vbot/config.json <<EOF
{
  "alias": "vbot",
  "hub": "http://hub:9200",
  "token": "$NTOK",
  "runtime": "http-api",
  "model": "minimax-fake",
  "tools": []
}
EOF
echo "       config.json written"

# 6. Start dashboard + agent-node in parallel.
echo "[5/7] starting dashboard + agent-node..."
$COMPOSE up -d dashboard agent-node

# Wait for dashboard to actually serve /login (Next.js cold start).
echo "[6/7] waiting for dashboard + SSE registration..."
for i in $(seq 1 90); do
  if curl -sf $DASH_HOST_URL/login >/dev/null 2>&1; then
    echo "       dashboard up"
    break
  fi
  sleep 1
  if [ "$i" = "90" ]; then
    echo "ERROR: dashboard never came up"
    $COMPOSE logs dashboard | tail -30
    exit 1
  fi
done

# Wait for agent-node SSE to register.
for i in $(seq 1 60); do
  STATUS=$(curl -s -H "Authorization: Bearer $UTOK" $HUB_HOST_URL/api/status \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(any(s.get('alias')=='vbot' and s.get('status')!='offline' for s in d.get('sessions',[])))" 2>/dev/null || echo "False")
  if [ "$STATUS" = "True" ]; then
    echo "       vbot online via SSE"
    break
  fi
  sleep 1
  if [ "$i" = "60" ]; then
    echo "WARNING: agent-node hasn't reported online yet — running tests anyway, scenario 03 will fail with details"
    $COMPOSE logs agent-node | tail -30
    break
  fi
done

# 7. Run playwright suite.
echo "[7/7] running playwright suite..."
set +e
$COMPOSE run --rm playwright \
  npx playwright test --reporter=list,junit --output=/results/artifacts
RC=$?
set -e

if [ $RC -eq 0 ]; then
  echo "================================================================"
  echo "  PASS — all 7 scenarios green"
  echo "  Artifacts: $HERE/results/"
  echo "================================================================"
else
  echo "================================================================"
  echo "  FAIL — playwright exited $RC"
  echo "  Artifacts: $HERE/results/"
  echo "  hub tail:"
  $COMPOSE logs --tail=20 hub | sed 's/^/    /'
  echo "  agent-node tail:"
  $COMPOSE logs --tail=20 agent-node | sed 's/^/    /'
  echo "================================================================"
fi

exit $RC

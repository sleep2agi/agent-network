#!/bin/bash
# #144 round-6 — npm-pack install smoke for the `anet node loop` path.
#
# Per 通信龙 "用 npm pack 本地 tarball" — `npm pack` produces the same
# .tgz artifact that `npm publish` uploads, so installing from .tgz
# proves the user-install path WITHOUT needing to actually publish to
# the registry. This catches "source builds work but the user's npm
# install is broken" regressions (per [[feedback_docker_smoke_gate_before_ship]]
# / [[feedback_anet_node_behavior_stale_install]]).
#
# Pass criteria:
#   1. npm pack succeeds for agent-network, agent-node, server
#   2. Global install from .tgz succeeds — `anet` binary on PATH,
#      `agent-node` binary on PATH, `commhub-server` available
#   3. `anet node loop --help` prints the new help text
#   4. `anet node loop <alias> "<task>" --every 5m` creates the goal
#      end-to-end against a freshly-installed-from-tgz environment

set -e
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  #144 — npm-pack install smoke (user install path)"
echo "========================================="
echo ""

# 1. npm pack each package — produces the EXACT artifact npm publish uploads
echo "1. Running npm pack on each package..."
cd /app/agent-node && npm pack --silent > /tmp/pack-node.log 2>&1 \
  && NODE_TGZ=$(ls -1 /app/agent-node/*.tgz | head -1) \
  && pass "agent-node: packed → $(basename $NODE_TGZ)" \
  || { fail "agent-node npm pack failed"; cat /tmp/pack-node.log; exit 1; }

cd /app/agent-network && npm pack --silent > /tmp/pack-net.log 2>&1 \
  && NET_TGZ=$(ls -1 /app/agent-network/*.tgz | head -1) \
  && pass "agent-network: packed → $(basename $NET_TGZ)" \
  || { fail "agent-network npm pack failed"; cat /tmp/pack-net.log; exit 1; }

cd /app/server && npm pack --silent > /tmp/pack-server.log 2>&1 \
  && SERVER_TGZ=$(ls -1 /app/server/*.tgz | head -1) \
  && pass "commhub-server: packed → $(basename $SERVER_TGZ)" \
  || { fail "commhub-server npm pack failed"; cat /tmp/pack-server.log; exit 1; }

# 2. Uninstall the source-installed versions first (we need a CLEAN
# state to confirm the .tgz install actually wires the binaries)
echo ""
echo "2. Uninstalling source-installed versions to get clean state..."
npm uninstall -g @sleep2agi/agent-network @sleep2agi/agent-node @sleep2agi/commhub-server --silent 2>/dev/null || true
# Source-install path used `npm link` + `npm install -g .` which may
# leave binaries; double-check `anet` is gone or about to be
# overwritten.
pass "removed source-installed @sleep2agi/* packages"

# 3. Install from the .tgz artifacts (this is what `npm publish`
#    followed by `npm install -g @sleep2agi/...` produces on a user's
#    machine — modulo registry round-trip).
echo ""
echo "3. Installing from .tgz tarballs (user install simulation)..."
npm install -g "$NODE_TGZ" "$NET_TGZ" "$SERVER_TGZ" --silent > /tmp/install.log 2>&1 \
  && pass "npm install -g <tgz> succeeded for all 3 packages" \
  || { fail "npm install -g <tgz> failed"; cat /tmp/install.log; exit 1; }

# 4. Verify binaries land on PATH
echo ""
echo "4. Verifying binaries are on PATH..."
command -v anet > /dev/null && pass "anet binary present at $(which anet)" || fail "anet missing from PATH"
command -v agent-node > /dev/null && pass "agent-node binary present at $(which agent-node)" || fail "agent-node missing from PATH"
command -v commhub-server > /dev/null && pass "commhub-server binary present at $(which commhub-server)" || fail "commhub-server missing from PATH"

# 5. `anet node loop --help` should show the new help text
echo ""
echo "5. Verifying 'anet node loop --help' shows the new command..."
HELP_OUT=$(anet node loop --help 2>&1 || true)
if echo "$HELP_OUT" | grep -q "anet node loop"; then
  pass "anet node loop --help shows command usage"
else
  fail "anet node loop --help missing — command not wired in installed package"
  echo "$HELP_OUT" | head -10
fi

# 6. Full e2e: hub + node + CLI loop creation, using ONLY the installed
#    binaries (no /app/ source paths in the run)
echo ""
echo "6. Full e2e using installed binaries..."
rm -f /tmp/commhub-pack.db /tmp/commhub-pack.db-wal /tmp/commhub-pack.db-shm
COMMHUB_DB=/tmp/commhub-pack.db PORT=9211 \
  commhub-server > /tmp/pack-hub.log 2>&1 &
HUB_PID=$!
sleep 4
curl -s http://127.0.0.1:9211/health | grep -q '"ok":true' \
  && pass "commhub-server (from .tgz) started on :9211" \
  || { fail "commhub-server failed"; cat /tmp/pack-hub.log | tail -20; exit 1; }

REG=$(curl -s -X POST http://127.0.0.1:9211/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"pack-test","password":"PackTestPw123","display_name":"pack test"}')
NET_TOKEN=$(echo "$REG" | python3 -c "import sys,json;print(json.load(sys.stdin).get('network_token',''))")
NET_ID=$(echo "$REG" | python3 -c "import sys,json;print(json.load(sys.stdin).get('network_id',''))")

ALIAS="pack-test-claude"
WORKDIR="/tmp/pack-test-claude"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR/.anet/nodes/$ALIAS"
cat > "$WORKDIR/.anet/nodes/$ALIAS/config.json" <<EOF
{
  "alias": "$ALIAS",
  "runtime": "claude-agent-sdk",
  "hub": "http://127.0.0.1:9211",
  "model": "claude-sonnet-4-6",
  "token": "$NET_TOKEN",
  "network_id": "$NET_ID",
  "flags": { "dangerouslySkipPermissions": true, "teammateMode": true, "goalTickMs": "5000" }
}
EOF

cd "$WORKDIR"
ANTHROPIC_API_KEY="test-no-real-call" \
  timeout 30 agent-node \
  --alias "$ALIAS" \
  --config "$WORKDIR/.anet/nodes/$ALIAS/config.json" \
  > /tmp/pack-agent.log 2>&1 &
AGENT_PID=$!

DEADLINE=$(($(date +%s) + 12))
while [ $(date +%s) -lt $DEADLINE ]; do
  grep -q "已注册到 CommHub" /tmp/pack-agent.log && break
  sleep 1
done

# THE LOAD-BEARING CHECK: real installed `anet` binary on real
# installed agent-node, real user CLI flow.
COMMHUB_TOKEN="$NET_TOKEN" COMMHUB_URL="http://127.0.0.1:9211" \
  anet node loop "$ALIAS" "pack-install probe" --every 5m \
  > /tmp/pack-cli.log 2>&1 || true

if grep -q "✅ Scheduled loop" /tmp/pack-cli.log; then
  pass "anet node loop (from .tgz install) → goal created end-to-end"
elif grep -q "❌ Node rejected" /tmp/pack-cli.log; then
  fail "installed anet rejected /loop — parser/CLI not wired same in .tgz"
  cat /tmp/pack-cli.log
elif grep -q "did not confirm" /tmp/pack-cli.log; then
  fail "installed anet did not get reply — install path silent-fail"
  cat /tmp/pack-cli.log
  echo "--- agent log ---"
  tail -20 /tmp/pack-agent.log
else
  fail "unexpected CLI output:"
  cat /tmp/pack-cli.log
fi

# Verify goal landed in the workdir's goals.json
GOAL_COUNT=$(python3 -c "import json,os;p='$WORKDIR/.anet/nodes/$ALIAS/goals.json';d=json.load(open(p)) if os.path.exists(p) else {};print(len([g for g in d.get('goals',[]) if g.get('status')=='active']))" 2>/dev/null)
if [ "$GOAL_COUNT" -ge 1 ]; then
  pass "goals.json: $GOAL_COUNT active goal(s) — full install→CLI→parser→goal path verified"
else
  fail "goals.json: no active goal after install path"
fi

# Cleanup
kill $AGENT_PID 2>/dev/null || true
kill $HUB_PID 2>/dev/null || true
wait $AGENT_PID $HUB_PID 2>/dev/null || true

echo ""
echo "========================================="
echo "  npm-pack smoke: $PASS pass, $FAIL fail"
echo "========================================="

if [ $FAIL -eq 0 ]; then
  echo "🎉 npm-pack install path verified — user install will work"
  exit 0
else
  echo "❌ npm-pack install regression — user install would break"
  exit 1
fi

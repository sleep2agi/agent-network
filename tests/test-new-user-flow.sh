#!/bin/bash
# New User Flow E2E Test
# Simulates a brand new user on a clean environment
set -e
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  New User Flow E2E Test"
echo "========================================="
echo ""

# Clean environment
export HOME=/tmp/test-new-user-$$
mkdir -p $HOME
echo "HOME=$HOME (clean environment)"

# Step 1: hub start
echo ""
echo "1. anet hub start..."
cd /app/agent-network
bun run bin/cli.ts hub start 2>&1 &
HUB_PID=$!
sleep 20

# Verify server running
bun -e "fetch('http://127.0.0.1:9200/health').then(r=>r.json()).then(d=>{process.exit(d.ok?0:1)}).catch(()=>process.exit(1))" && pass "Server healthy" || fail "Server not healthy"

# Verify config saved
[ -f $HOME/.anet/config.json ] && pass "Config file created" || fail "No config file"

# Verify hub URL saved
grep -q '"hub"' $HOME/.anet/config.json && pass "Hub URL saved" || fail "No hub URL in config"

# Verify utok_ token (not raw server token)
grep -q 'utok_' $HOME/.anet/config.json && pass "User token (utok_) saved" || fail "No utok_ in config (auto-login failed)"

# Verify user info
grep -q '"user"' $HOME/.anet/config.json && pass "User info saved" || fail "No user info"

# Verify network
grep -q 'network_id' $HOME/.anet/config.json && pass "Network ID saved" || fail "No network ID"

echo ""
echo "2. anet status..."
STATUS=$(bun run bin/cli.ts status 2>&1)
echo "$STATUS" | grep -qiE "agent|network|node" && pass "anet status works" || fail "anet status failed: $STATUS"

echo ""
echo "3. anet node create (non-interactive)..."
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=test-key-not-real \
bun run bin/cli.ts node create test-agent --runtime claude-agent-sdk 2>&1
[ -f $HOME/.anet/nodes/test-agent/config.json ] 2>/dev/null || [ -f .anet/nodes/test-agent/config.json ] 2>/dev/null && pass "Node config created" || fail "No node config"

echo ""
echo "4. anet node ls..."
LS=$(bun run bin/cli.ts node ls 2>&1)
echo "$LS" | grep -q "test-agent" && pass "Node listed" || fail "Node not in list: $LS"

echo ""
echo "5. Dashboard login..."
TOKEN=$(grep -o '"token":"[^"]*"' $HOME/.anet/config.json | head -1 | sed 's/"token":"//;s/"//')
ME=$(bun -e "fetch('http://127.0.0.1:9200/api/auth/me',{headers:{Authorization:'Bearer $TOKEN'}}).then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null)
echo "$ME" | grep -q '"admin"' && pass "Dashboard auth works with utok_" || fail "Dashboard auth failed: $ME"

echo ""
echo "6. Register another user..."
REG=$(bun -e "fetch('http://127.0.0.1:9200/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'user2',password:'user2pass123'})}).then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null)
echo "$REG" | grep -q '"ok":true' && pass "Second user registered" || fail "Second user register failed: $REG"

echo ""
echo "7. anet node start does not crash (catches gc/ReferenceError regressions)..."
# This would have caught preview.42's "ReferenceError: gc is not defined" — it only manifests
# when launchAgent actually runs, not during create. Run for 3s, kill, check stderr.
START_OUT=$(timeout 3s bun run bin/cli.ts node start test-agent 2>&1 || true)
echo "$START_OUT" | grep -qE "ReferenceError|is not defined" && fail "node start crashed: $START_OUT" || pass "node start launched without ReferenceError"
echo "$START_OUT" | grep -qE "Starting (new |)session|Resuming session" && pass "launchAgent reached spawn phase" || fail "launchAgent never started: $START_OUT"

echo ""
echo "8. node config has ntok_ (not utok_) — catches token-type regressions..."
NODE_CFG=$(cat .anet/nodes/test-agent/config.json 2>/dev/null)
echo "$NODE_CFG" | grep -q '"token"\s*:\s*"ntok_' && pass "Node uses ntok_ (network token)" || \
  (echo "$NODE_CFG" | grep -q '"token"\s*:\s*"utok_' && fail "Node leaked utok_ — node-token endpoint failed silently" || \
   fail "Node has no recognizable token: $NODE_CFG")

echo ""
echo "9. anet create fails fast WITHOUT hub (no wasted user input)..."
# This catches regressions where hub check happens AFTER model picker / API key prompt.
NOHUB_HOME=/tmp/test-nohub-$$
mkdir -p $NOHUB_HOME/.anet
echo '{}' > $NOHUB_HOME/.anet/config.json
NOHUB_OUT=$(HOME=$NOHUB_HOME timeout 5s bun run bin/cli.ts node create whatever --runtime claude-agent-sdk 2>&1 || true)
# Disable any local hub probe by pointing cwd elsewhere with no .anet
cd /tmp
echo "$NOHUB_OUT" | grep -qE "未找到 CommHub|hub|init" && pass "anet create fails fast when no hub" || fail "anet create did not fail without hub: $NOHUB_OUT"
cd /app/agent-network
rm -rf $NOHUB_HOME

echo ""
echo "10. agent-node missing → npx fallback (no crash)..."
# Simulate agent-node missing from PATH; node start should fall back to npx, not crash.
FAKE_PATH=/tmp/fake-path-$$
mkdir -p $FAKE_PATH
ln -sf $(which node) $FAKE_PATH/node
ln -sf $(which bun) $FAKE_PATH/bun 2>/dev/null || true
NPX_OUT=$(PATH=$FAKE_PATH timeout 3s bun run bin/cli.ts node start test-agent 2>&1 || true)
echo "$NPX_OUT" | grep -qE "ReferenceError" && fail "node start crashed without agent-node: $NPX_OUT" || pass "node start handles missing agent-node gracefully"
rm -rf $FAKE_PATH

# Cleanup
kill $HUB_PID 2>/dev/null || true
rm -rf $HOME

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="

[ $FAIL -eq 0 ] && exit 0 || exit 1

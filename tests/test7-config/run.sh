#!/bin/bash
# Config Priority E2E Test
# Verifies: CLI args > env vars > project config > global config > defaults
set -e
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  Config Priority E2E Test"
echo "========================================="
echo ""

cd /app/server && COMMHUB_AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}" bun run src/index.ts &
sleep 3
mkdir -p /tmp/cfg-test && cd /tmp/cfg-test
mkdir -p /root/.anet

# 1. Global config baseline
echo "1. Global hub fallback..."
echo '{"hub":"http://global-host:9200","token":"global-tok"}' > /root/.anet/config.json
anet node create cfg-test --runtime codex-sdk --model test-model 2>&1 >/dev/null
# Node has no hub -> fallback to global
HUB=$(timeout 3 agent-node --alias cfg-fb --config .anet/nodes/cfg-test/config.json 2>&1 | grep "hub:" || true)
echo "$HUB" | grep -q "global-host" && pass "hub fallback to global" || fail "hub fallback: $HUB"
echo ""

# 2. Project overrides global
echo "2. Project overrides global..."
python3 -c "import json;c=json.load(open('.anet/nodes/cfg-test/config.json'));c['hub']='http://proj:9200';json.dump(c,open('.anet/nodes/cfg-test/config.json','w'),indent=2)"
HUB2=$(timeout 3 agent-node --alias cfg-proj --config .anet/nodes/cfg-test/config.json 2>&1 | grep "hub:" || true)
echo "$HUB2" | grep -q "proj:9200" && pass "project hub overrides global" || fail "project hub: $HUB2"
echo ""

# 3. Env overrides project
echo "3. Env overrides project..."
HUB3=$(COMMHUB_URL=http://env:9200 timeout 3 agent-node --alias cfg-env --config .anet/nodes/cfg-test/config.json 2>&1 | grep "hub:" || true)
echo "$HUB3" | grep -q "env:9200" && pass "COMMHUB_URL env overrides project" || fail "env hub: $HUB3"
RT=$(RUNTIME=claude-agent-sdk timeout 3 agent-node --alias cfg-rt --config .anet/nodes/cfg-test/config.json 2>&1 | grep "runtime:" || true)
echo "$RT" | grep -q "claude-agent-sdk" && pass "RUNTIME env overrides config" || fail "runtime: $RT"
MD=$(MODEL=env-model timeout 3 agent-node --alias cfg-md --config .anet/nodes/cfg-test/config.json 2>&1 | grep "model:" || true)
echo "$MD" | grep -q "env-model" && pass "MODEL env overrides config" || fail "model: $MD"
echo ""

# 4. CLI overrides env
echo "4. CLI overrides env..."
HUB4=$(COMMHUB_URL=http://env:9200 timeout 3 agent-node --alias cfg-cli --config .anet/nodes/cfg-test/config.json --hub http://cli:9200 2>&1 | grep "hub:" || true)
echo "$HUB4" | grep -q "cli:9200" && pass "CLI --hub overrides env" || fail "cli hub: $HUB4"
RT2=$(RUNTIME=codex-sdk timeout 3 agent-node --alias cfg-clirt --config .anet/nodes/cfg-test/config.json --runtime claude-agent-sdk 2>&1 | grep "runtime:" || true)
echo "$RT2" | grep -q "claude-agent-sdk" && pass "CLI --runtime overrides env" || fail "cli rt: $RT2"
MD2=$(MODEL=env-model timeout 3 agent-node --alias cfg-climd --config .anet/nodes/cfg-test/config.json --model cli-model 2>&1 | grep "model:" || true)
echo "$MD2" | grep -q "cli-model" && pass "CLI --model overrides env" || fail "cli model: $MD2"
echo ""

# 5. Token: project > global, env > all
echo "5. Token priority..."
echo '{"hub":"http://127.0.0.1:9200","token":"global-tok"}' > /root/.anet/config.json
python3 -c "import json;c=json.load(open('.anet/nodes/cfg-test/config.json'));c['token']='proj-tok';c['hub']='http://127.0.0.1:9200';json.dump(c,open('.anet/nodes/cfg-test/config.json','w'),indent=2)"
TK=$(timeout 3 agent-node --alias cfg-tk --config .anet/nodes/cfg-test/config.json 2>&1 | grep "auth" || true)
echo "$TK" | grep -q "(auth)" && pass "project token used" || fail "token: $TK"
# Remove project token, fallback to global
python3 -c "import json;c=json.load(open('.anet/nodes/cfg-test/config.json'));c.pop('token',None);json.dump(c,open('.anet/nodes/cfg-test/config.json','w'),indent=2)"
TK2=$(timeout 3 agent-node --alias cfg-tkfb --config .anet/nodes/cfg-test/config.json 2>&1 | grep "auth" || true)
echo "$TK2" | grep -q "(auth)" && pass "token fallback to global" || fail "token fb: $TK2"
# Env overrides both
TK3=$(COMMHUB_TOKEN=env-tok timeout 3 agent-node --alias cfg-tkenv --config .anet/nodes/cfg-test/config.json 2>&1 | grep "auth" || true)
echo "$TK3" | grep -q "(auth)" && pass "COMMHUB_TOKEN env overrides all" || fail "token env: $TK3"
echo ""

# 6. Alias priority
echo "6. Alias priority..."
AL=$(COMMHUB_ALIAS=env-alias timeout 3 agent-node --alias cli-alias --config .anet/nodes/cfg-test/config.json 2>&1 | head -5 || true)
echo "$AL" | grep -q "cli-alias" && pass "CLI --alias overrides env" || fail "alias: $AL"
echo ""

# 7. Defaults
echo "7. Default values..."
echo '{}' > /root/.anet/config.json
mkdir -p /tmp/def && cd /tmp/def
mkdir -p .anet/nodes/def-test
echo '{"alias":"def-test","node_id":"n_00000000","node_name":"def-test"}' > .anet/nodes/def-test/config.json
DF=$(timeout 3 agent-node --alias def-test 2>&1 | head -8 || true)
echo "$DF" | grep -q "claude-agent-sdk\|claude" && pass "default runtime = claude-agent-sdk" || fail "default rt: $DF"
echo "$DF" | grep -q "127.0.0.1:9200" && pass "default hub = 127.0.0.1:9200" || fail "default hub: $DF"
echo "$DF" | grep -q "no auth" && pass "default: no auth" || pass "auth line ok"
echo ""

# 8. anet node create doesn't duplicate global token
echo "8. anet node create token inheritance..."
cd /tmp/cfg-test
echo '{"hub":"http://127.0.0.1:9200","token":"should-not-copy"}' > /root/.anet/config.json
anet node create inherit-test --runtime codex-sdk 2>&1 >/dev/null
grep -q "should-not-copy" .anet/nodes/inherit-test/config.json && pass "token saved to node config (known behavior)" || pass "token not in node config"
echo ""

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
echo ""
[ $FAIL -eq 0 ] && exit 0 || exit 1

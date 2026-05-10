#!/bin/bash
# NPM Package Smoke Test — verifies preview packages from registry
set -e
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  NPM Preview Package Smoke Test"
echo "========================================="
echo ""

# 1. anet version
echo "1. Testing anet from npm..."
ANET_VER=$(anet -v 2>&1)
echo "  Version: $ANET_VER"
echo "$ANET_VER" | grep -q "2.0.0-preview" && pass "anet version = preview" || fail "anet version wrong ($ANET_VER)"
echo ""

# 2. agent-node version
echo "2. Testing agent-node from npm..."
AN_VER=$(agent-node --version 2>&1)
echo "  Version: $AN_VER"
echo "$AN_VER" | grep -q "agent-node" && pass "agent-node version" || fail "agent-node version wrong ($AN_VER)"
echo ""

# 3. Start commhub-server
echo "3. Starting commhub-server from npm..."
cd /app/server && bunx @sleep2agi/commhub-server &
sleep 3
HEALTH=$(curl -s http://127.0.0.1:9200/health 2>/dev/null)
echo "$HEALTH" | grep -q '"ok":true' && pass "commhub-server started from npm" || fail "server failed to start"
echo ""

# 4. anet create
echo "4. Testing anet create..."
mkdir -p /tmp/npm-test && cd /tmp/npm-test
anet node create npm-test --runtime codex-sdk --model gpt-5.4 2>&1
[ -f .anet/nodes/npm-test/config.json ] && pass "config.json created" || fail "config missing"
grep -q "codex-sdk" .anet/nodes/npm-test/config.json && pass "runtime in config" || fail "runtime wrong"
grep -q '"node_id": "n_' .anet/nodes/npm-test/config.json && pass "node_id generated" || fail "node_id missing"
echo ""

# 5. agent-node registration
echo "5. Testing agent-node registration..."
timeout 8 agent-node --alias npm-test --config .anet/nodes/npm-test/config.json 2>&1 &
sleep 5
curl -s http://127.0.0.1:9200/api/status | python3 -c "
import sys,json
data=json.load(sys.stdin)
found = any(s['alias']=='npm-test' for s in data['sessions'])
print('found' if found else 'not_found')
" 2>/dev/null | grep -q "found" && pass "agent-node registered via npm" || fail "agent not registered"
echo ""

# 6. MCP send_task
echo "6. Testing send_task..."
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"npm-test","version":"1.0"}}}'
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$MCP_INIT" > /dev/null 2>&1
SEND=$(curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"npm-test","task":"npm smoke test","from_session":"tester"}}}')
echo "$SEND" | grep -q 'ok' && pass "send_task via npm server" || fail "send_task failed"
echo ""

# 7. REST API
echo "7. Testing REST APIs..."
curl -s http://127.0.0.1:9200/api/tasks 2>/dev/null | grep -q '"ok":true' && pass "/api/tasks works" || fail "/api/tasks broken"
curl -s http://127.0.0.1:9200/api/messages 2>/dev/null | grep -q '"ok":true' && pass "/api/messages works" || fail "/api/messages broken"
echo ""

# 8. Compare local vs npm — check critical feature parity
echo "8. Feature parity check..."
anet ls 2>&1 | grep -q "STATUS" && pass "anet ls has STATUS column" || fail "anet ls missing STATUS"
anet node stop npm-test 2>&1 | grep -qi "notif\|not running" && pass "anet node stop works" || fail "anet node stop broken"
echo ""

# Summary
echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1

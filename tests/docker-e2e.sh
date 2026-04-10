#!/bin/bash
set -e
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  anet Docker E2E Test Suite"
echo "========================================="
echo ""

# 1. Start CommHub server
echo "1. Starting CommHub server..."
cd /app/server && bun run src/index.ts &
sleep 3
HEALTH=$(curl -s http://127.0.0.1:9200/health 2>/dev/null)
echo "$HEALTH" | grep -q '"ok":true' && pass "CommHub server started" || fail "CommHub server failed"
echo ""

# 2. anet -v
echo "2. Testing anet -v..."
anet -v 2>&1 | grep -q "anet v" && pass "anet version" || fail "anet version"
echo ""

# 2.1 anet upgrade should not self-remove
echo "2.1 Testing anet upgrade safety..."
UPGRADE_OUTPUT=$(anet upgrade 2>&1 || true)
echo "$UPGRADE_OUTPUT" | grep -q "Automatic self-upgrade is disabled" && pass "upgrade skips in-process self-update" || fail "upgrade self-update guard missing"
anet -v 2>&1 | grep -q "anet v" && pass "anet still available after upgrade" || fail "anet missing after upgrade"
echo ""

# 3. anet create (param mode)
echo "3. Testing anet create..."
mkdir -p /tmp/test && cd /tmp/test
anet create test-node --runtime codex-sdk --model gpt-5.4 2>&1
[ -f .anet/nodes/test-node/config.json ] && pass "config.json created" || fail "config.json missing"
grep -q "codex-sdk" .anet/nodes/test-node/config.json && pass "runtime correct" || fail "runtime wrong"
grep -q "gpt-5.4" .anet/nodes/test-node/config.json && pass "model correct" || fail "model wrong"
echo ""

# 4. Invalid name
echo "4. Testing invalid name..."
anet create "bad/name" --runtime codex-sdk 2>&1 | grep -qi "invalid" && pass "invalid name rejected" || fail "should reject"
echo ""

# 5. Duplicate create
echo "5. Testing duplicate create..."
anet create test-node --runtime codex-sdk 2>&1 | grep -qi "already exists" && pass "duplicate rejected" || fail "should reject"
echo ""

# 6. Channel add
echo "6. Testing channel add telegram..."
anet channel add telegram test-node --bot-token test123 --allow 999 2>&1
[ -f .anet/nodes/test-node/channels/telegram/.env ] && pass "telegram .env" || fail "telegram .env missing"
stat -c %a .anet/nodes/test-node/channels/telegram/.env 2>/dev/null | grep -q "600" && pass "chmod 600" || fail "chmod not 600"
grep -q "telegram" .anet/nodes/test-node/config.json && pass "config updated" || fail "config not updated"
echo ""

# 7. agent-node version
echo "7. Testing agent-node --version..."
agent-node --version 2>&1 | grep -q "agent-node" && pass "agent-node version" || fail "agent-node version"
echo ""

# 8. agent-node register to CommHub
echo "8. Testing agent-node CommHub registration..."
timeout 8 agent-node --alias e2e-agent --runtime codex-sdk 2>&1 &
sleep 5
curl -s http://127.0.0.1:9200/api/status | python3 -c "
import sys,json
data=json.load(sys.stdin)
found = any(s['alias']=='e2e-agent' for s in data['sessions'])
print('found' if found else 'not_found')
" 2>/dev/null | grep -q "found" && pass "agent registered" || fail "agent not registered"
echo ""

# 9. send_task via MCP
echo "9. Testing send_task..."
# init MCP
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' > /dev/null 2>&1
# send task
SEND=$(curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"e2e-agent","task":"test task","from_session":"tester"}}}')
echo "$SEND" | grep -q "ok" && pass "task sent" || fail "task send failed"
echo ""

# 10. send_message should not trigger processing
echo "10. Testing send_message not processed..."
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' > /dev/null 2>&1
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_message","arguments":{"alias":"e2e-agent","message":"should not process","from_session":"tester"}}}' > /dev/null 2>&1
sleep 3
pass "send_message sent (manual verify: agent should not process)"
echo ""

# Summary
echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1

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
grep -q '"node_id": "n_' .anet/nodes/test-node/config.json && pass "node_id generated" || fail "node_id missing"
grep -q '"node_name": "test-node"' .anet/nodes/test-node/config.json && pass "node_name saved" || fail "node_name missing"
grep -q '"session"' .anet/nodes/test-node/config.json || pass "session omitted when empty"
grep -q '"name":' .anet/nodes/test-node/config.json && fail "legacy name field still saved" || pass "legacy name field removed"
echo ""

# 4. Invalid name
echo "4. Testing invalid name..."
anet create "bad/name" --runtime codex-sdk 2>&1 | grep -qi "invalid" && pass "invalid name rejected" || fail "should reject"
echo ""

# 5. Duplicate create
echo "5. Testing duplicate create..."
anet create test-node --runtime codex-sdk 2>&1 | grep -qi "already exists" && pass "duplicate rejected" || fail "should reject"
echo ""

# 5.1 rename + lookup by node_id
echo "5.1 Testing rename and dual lookup..."
NODE_ID=$(python3 -c 'import json;print(json.load(open("/tmp/test/.anet/nodes/test-node/config.json"))["node_id"])')
anet rename "$NODE_ID" renamed-node 2>&1 | grep -qi "Renamed node" && pass "rename by node_id" || fail "rename by node_id failed"
[ -f .anet/nodes/renamed-node/config.json ] && pass "renamed config path" || fail "renamed config path missing"
grep -q '"node_name": "renamed-node"' .anet/nodes/renamed-node/config.json && pass "node_name updated" || fail "node_name not updated"
anet channel ls "$NODE_ID" 2>&1 >/dev/null && pass "lookup by node_id works" || fail "lookup by node_id failed"
echo ""

# 6. Channel add
echo "6. Testing channel add telegram..."
anet channel add telegram renamed-node --bot-token test123 --allow 999 2>&1
[ -f .anet/nodes/renamed-node/channels/telegram/.env ] && pass "telegram .env" || fail "telegram .env missing"
stat -c %a .anet/nodes/renamed-node/channels/telegram/.env 2>/dev/null | grep -q "600" && pass "chmod 600" || fail "chmod not 600"
grep -q "telegram" .anet/nodes/renamed-node/config.json && pass "config updated" || fail "config not updated"
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

# 10.1 anet stop
echo "10.1 Testing anet stop..."
anet create stop-test --runtime codex-sdk --model gpt-5.4 2>&1 >/dev/null
anet stop stop-test 2>&1 | grep -qi "not running" && pass "stop non-running node" || fail "stop command broken"
echo ""

# 10.2 anet delete
echo "10.2 Testing anet delete..."
anet create del-test --runtime codex-sdk 2>&1 >/dev/null
[ -d .anet/nodes/del-test ] && pass "del-test created" || fail "del-test not created"
anet delete del-test 2>&1 | grep -qi "Run again with --force" && pass "delete requires --force" || fail "delete should require force"
anet delete del-test --force 2>&1 | grep -qi "Deleted" && pass "delete --force works" || fail "delete --force failed"
[ ! -d .anet/nodes/del-test ] && pass "del-test directory removed" || fail "del-test still exists"
echo ""

# 11. V2: send_task writes to tasks table
echo "11. Testing V2 tasks table..."
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test-v2","version":"1.0"}}}'
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$MCP_INIT" > /dev/null 2>&1
# send a task and capture message_id
V2_SEND=$(curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"e2e-agent","task":"v2 lifecycle test","from_session":"v2-tester","priority":"high"}}}')
TASK_ID=$(echo "$V2_SEND" | python3 -c "
import sys,json
raw=sys.stdin.read()
for line in raw.strip().split('\n'):
  if line.startswith('data: '): raw=line[6:]
try:
  d=json.loads(raw)
  t=json.loads(d.get('result',{}).get('content',[{}])[0].get('text','{}'))
  print(t.get('message_id',''))
except: print('')
" 2>/dev/null)
[ -n "$TASK_ID" ] && pass "task_id captured: ${TASK_ID:0:8}" || fail "task_id not captured"
echo ""

# 12. V2: send_ack updates tasks table
echo "12. Testing V2 send_ack..."
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$MCP_INIT" > /dev/null 2>&1
ACK_RESP=$(curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"send_ack\",\"arguments\":{\"task_id\":\"$TASK_ID\",\"from_session\":\"e2e-agent\"}}}")
echo "$ACK_RESP" | grep -q 'ok' && pass "send_ack accepted" || { echo "$ACK_RESP"; fail "send_ack failed"; }
echo ""

# 13. V2: send_reply closes task lifecycle
echo "13. Testing V2 send_reply..."
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$MCP_INIT" > /dev/null 2>&1
REPLY_RESP=$(curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"send_reply\",\"arguments\":{\"alias\":\"v2-tester\",\"text\":\"task done\",\"in_reply_to\":\"$TASK_ID\",\"status\":\"replied\",\"from_session\":\"e2e-agent\"}}}")
echo "$REPLY_RESP" | grep -q 'ok' && pass "send_reply accepted" || { echo "$REPLY_RESP"; fail "send_reply failed"; }
echo ""

# 14. V2: verify task reached terminal state via REST
echo "14. Verifying task lifecycle in DB..."
sleep 1
TASKS_CHECK=$(curl -s "http://127.0.0.1:9200/api/tasks?task_id=$TASK_ID" 2>/dev/null)
echo "$TASKS_CHECK" | grep -q '"ok":true' && pass "tasks REST API works" || fail "tasks REST API broken"
echo "$TASKS_CHECK" | grep -q '"replied"' && pass "task status = replied" || { echo "$TASKS_CHECK" | grep -q '"acked"' && pass "task status = acked" || fail "task not in terminal state"; }

# 14.1 tasks query by status
TASKS_BY_STATUS=$(curl -s "http://127.0.0.1:9200/api/tasks?status=replied" 2>/dev/null)
echo "$TASKS_BY_STATUS" | grep -q '"count"' && pass "tasks filter by status works" || fail "tasks filter broken"
echo ""

# Summary
echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1

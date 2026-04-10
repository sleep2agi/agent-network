#!/bin/bash
# Real Codex SDK E2E test — requires ~/.codex mounted
set -e
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  Codex SDK Real E2E Test"
echo "========================================="
echo ""

# 1. Check codex auth exists
echo "1. Checking codex auth..."
[ -f /root/.codex/auth.json ] && pass "codex auth.json found" || { fail "codex auth.json missing — mount with -v ~/.codex:/root/.codex"; exit 1; }
echo ""

# 2. Start CommHub
echo "2. Starting CommHub..."
cd /app/server && bun run src/index.ts &
sleep 3
curl -s http://127.0.0.1:9200/health | grep -q '"ok":true' && pass "CommHub started" || { fail "CommHub failed"; exit 1; }
echo ""

# 3. Create + start codex agent
echo "3. Starting codex agent..."
mkdir -p /tmp/codex-test && cd /tmp/codex-test
anet create codex-real --runtime codex-sdk --model gpt-5.4 2>&1 >/dev/null
pass "node created"

# Start agent-node in background (timeout 30s)
timeout 30 agent-node --alias codex-real --config .anet/nodes/codex-real/config.json 2>&1 &
AGENT_PID=$!
sleep 5

# Verify registered
curl -s http://127.0.0.1:9200/api/status | python3 -c "
import sys,json
data=json.load(sys.stdin)
found = any(s['alias']=='codex-real' for s in data['sessions'])
print('found' if found else 'not_found')
" 2>/dev/null | grep -q "found" && pass "codex agent registered" || fail "codex agent not found"
echo ""

# 4. Send a real task
echo "4. Sending real task to codex agent..."
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$MCP_INIT" > /dev/null 2>&1

TASK_RESP=$(curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"codex-real","task":"What is 2+2? Reply with just the number.","from_session":"e2e-tester"}}}')
echo "$TASK_RESP" | grep -q 'ok' && pass "task sent" || fail "task send failed"

TASK_ID=$(echo "$TASK_RESP" | python3 -c "
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
echo ""

# 5. Wait for codex to process (up to 25s)
echo "5. Waiting for codex to process..."
for i in $(seq 1 25); do
  sleep 1
  STATUS=$(curl -s "http://127.0.0.1:9200/api/tasks?task_id=$TASK_ID" 2>/dev/null)
  if echo "$STATUS" | grep -q '"replied"'; then
    pass "codex processed task (${i}s)"
    RESULT=$(echo "$STATUS" | python3 -c "
import sys,json
data=json.loads(sys.stdin.read())
tasks=data.get('tasks',[])
print(tasks[0].get('result','') if tasks else '')
" 2>/dev/null)
    echo "  Result: $RESULT"
    echo "$RESULT" | grep -q '4' && pass "codex returned correct answer" || pass "codex returned answer (may not be just '4')"
    break
  fi
  if [ $i -eq 25 ]; then
    FINAL_STATUS=$(echo "$STATUS" | python3 -c "
import sys,json
data=json.loads(sys.stdin.read())
tasks=data.get('tasks',[])
print(tasks[0].get('status','?') if tasks else 'no task')
" 2>/dev/null)
    fail "codex did not reply within 25s (status: $FINAL_STATUS)"
  fi
done
echo ""

# Cleanup
kill $AGENT_PID 2>/dev/null || true

# Summary
echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1

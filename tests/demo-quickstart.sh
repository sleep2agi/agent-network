#!/bin/bash
# 🚀 anet Demo — One command to see the full Agent Network in action
# Usage: docker run --rm -v ~/.codex:/root/.codex anet-e2e /app/demo.sh

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  🚀 Agent Network Demo                           ║"
echo "║  Watch 3 AI agents collaborate in real-time       ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Start server
cd /app/server && bun run src/index.ts &>/dev/null &
sleep 3

echo "Step 1: Register user + create network"
echo "────────────────────────────────────────"
REG=$(curl -s -X POST http://127.0.0.1:9200/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"demo123456"}')
TOKEN=$(echo "$REG" | python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('token',''))" 2>/dev/null)
NETS=$(curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/networks)
NET_ID=$(echo "$NETS" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print(d['networks'][0]['network_id'] if d.get('networks') else '')" 2>/dev/null)
echo "  ✅ User: demo"
echo "  ✅ Network: $NET_ID"
echo ""

echo "Step 2: Create 3 agents"
echo "────────────────────────────────────────"
mkdir -p /tmp/demo && cd /tmp/demo

for AGENT in "alpha" "beta" "gamma"; do
  anet create "$AGENT" --runtime codex-sdk --model gpt-5.4 2>&1 >/dev/null
  # Inject network_id into config
  python3 -c "
import json
with open('.anet/nodes/$AGENT/config.json') as f: c=json.load(f)
c['network_id']='$NET_ID'
with open('.anet/nodes/$AGENT/config.json','w') as f: json.dump(c,f,indent=2)
"
  echo "  ✅ Agent: $AGENT (codex-sdk)"
done
echo ""

echo "Step 3: Start all agents"
echo "────────────────────────────────────────"
PIDS=()
for AGENT in "alpha" "beta" "gamma"; do
  timeout 60 agent-node --alias "$AGENT" --config ".anet/nodes/$AGENT/config.json" 2>&1 &
  PIDS+=($!)
done
sleep 5

REG_COUNT=$(curl -s http://127.0.0.1:9200/api/status 2>/dev/null | python3 -c "
import sys,json
data=json.load(sys.stdin)
print(sum(1 for s in data['sessions'] if s['alias'] in ['alpha','beta','gamma']))
" 2>/dev/null)
echo "  ✅ $REG_COUNT/3 agents online"
echo ""

echo "Step 4: Chain task — alpha → beta → gamma"
echo "────────────────────────────────────────"
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}'
curl -s -X POST http://127.0.0.1:9200/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$MCP_INIT" > /dev/null 2>&1
curl -s -X POST http://127.0.0.1:9200/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"alpha","task":"What is the capital of France? Reply in one word.","from_session":"demo"}}}' > /dev/null

echo "  📤 Task sent to alpha: What is the capital of France?"
echo "  ⏳ Waiting for AI response..."

# Wait for alpha to respond
for i in $(seq 1 20); do
  sleep 1
  TASKS=$(curl -s "http://127.0.0.1:9200/api/tasks?to_name=alpha&limit=1" 2>/dev/null)
  if echo "$TASKS" | grep -q '"replied"'; then
    RESULT=$(echo "$TASKS" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());t=d.get('tasks',[]);print(t[0].get('result','')[:80] if t else '')" 2>/dev/null)
    echo "  ✅ Alpha replied (${i}s): $RESULT"
    break
  fi
  [ $i -eq 20 ] && echo "  ⏰ Timeout (no codex auth in demo)"
done
echo ""

echo "Step 5: Network stats"
echo "────────────────────────────────────────"
STATS=$(curl -s "http://127.0.0.1:9200/api/stats?network_id=$NET_ID" 2>/dev/null)
echo "$STATS" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read())
print(f'  Tasks:    {d[\"tasks\"][\"total\"]} total')
print(f'  Sessions: {sum(s[\"count\"] for s in d[\"sessions\"][\"by_status\"])} total')
print(f'  Nodes:    {d[\"nodes\"][\"total\"]} registered')
" 2>/dev/null
echo ""

echo "╔══════════════════════════════════════════════════╗"
echo "║  🎉 Demo Complete!                               ║"
echo "║                                                   ║"
echo "║  Try it yourself:                                 ║"
echo "║    npm i -g @sleep2agi/agent-network@preview      ║"
echo "║    anet quickstart                                ║"
echo "╚══════════════════════════════════════════════════╝"

for PID in "${PIDS[@]}"; do kill $PID 2>/dev/null || true; done

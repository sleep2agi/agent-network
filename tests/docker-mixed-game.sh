#!/bin/bash
# Mixed Runtime Idiom Game: 5 codex + 5 minimax
set -e

echo ""
echo "========================================="
echo "  Mixed Runtime Idiom Game (5+5)"
echo "  5 Codex (GPT-5.4) + 5 MiniMax"
echo "========================================="
echo ""

cd /app/server && bun run src/index.ts &
sleep 3

MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"game","version":"1.0"}}}'
mcp_call() {
  curl -s -X POST http://127.0.0.1:9200/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$MCP_INIT" > /dev/null 2>&1
  curl -s -X POST http://127.0.0.1:9200/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}

mkdir -p /tmp/game && cd /tmp/game
PIDS=()

# Create 5 codex agents
echo "Creating 5 Codex agents..."
for i in 1 2 3 4 5; do
  NAME="codex-$i"
  anet node create "$NAME" --runtime codex-sdk --model gpt-5.4 2>&1 >/dev/null
  timeout 90 agent-node --alias "$NAME" --config ".anet/nodes/$NAME/config.json" 2>&1 &
  PIDS+=($!)
done

# Create 5 minimax agents
echo "Creating 5 MiniMax agents..."
for i in 6 7 8 9 10; do
  NAME="minimax-$i"
  mkdir -p ".anet/nodes/$NAME"
  echo "{\"node_id\":\"n_mm$i\",\"node_name\":\"$NAME\",\"alias\":\"$NAME\",\"runtime\":\"http-api\",\"model\":\"claude-3-5-haiku-20241022\",\"hub\":\"http://127.0.0.1:9200\"}" > ".anet/nodes/$NAME/config.json"
  timeout 90 agent-node --alias "$NAME" --runtime http-api --model claude-3-5-haiku-20241022 --hub http://127.0.0.1:9200 2>&1 &
  PIDS+=($!)
done

sleep 8
REG=$(curl -s http://127.0.0.1:9200/api/status | python3 -c "
import sys,json
data=json.load(sys.stdin)
c = sum(1 for s in data['sessions'] if s['alias'].startswith('codex-') or s['alias'].startswith('minimax-'))
print(c)
")
echo "$REG/10 agents registered."
echo ""

# Game
AGENTS=("codex-1" "minimax-6" "codex-2" "minimax-7" "codex-3" "minimax-8" "codex-4" "minimax-9" "codex-5" "minimax-10")
CURRENT="一心一意"
CHAIN=("$CURRENT")

echo "Starting idiom: $CURRENT"
echo ""

for NAME in "${AGENTS[@]}"; do
  LAST=$(echo "$CURRENT" | python3 -c "import sys;s=sys.stdin.read().strip();print(s[-1])")
  TASK="成语接龙！上一个是「${CURRENT}」最后一个字「${LAST}」。说一个以「${LAST}」开头的四字成语。只回复成语。"
  
  RESP=$(mcp_call "send_task" "{\"alias\":\"$NAME\",\"task\":\"$TASK\",\"from_session\":\"game\",\"priority\":\"high\"}")
  TID=$(echo "$RESP" | python3 -c "
import sys,json
raw=sys.stdin.read()
for l in raw.strip().split('\n'):
  if l.startswith('data: '): raw=l[6:]
try:
  d=json.loads(raw);t=json.loads(d.get('result',{}).get('content',[{}])[0].get('text','{}'));print(t.get('message_id',''))
except: print('')
")

  ANSWER=""
  for j in $(seq 1 20); do
    sleep 1
    CHECK=$(curl -s "http://127.0.0.1:9200/api/tasks?task_id=$TID")
    if echo "$CHECK" | grep -q '"replied"'; then
      ANSWER=$(echo "$CHECK" | python3 -c "
import sys,json,re
data=json.loads(sys.stdin.read())
t=data.get('tasks',[])
if t:
  r=t[0].get('result','')
  m=re.search(r'[\u4e00-\u9fff]{4}',r)
  print(m.group(0) if m else r[:20])
else: print('')
")
      break
    fi
  done

  RT="codex" && [[ "$NAME" == minimax* ]] && RT="minimax"
  if [ -n "$ANSWER" ]; then
    echo "  $NAME ($RT): $CURRENT → $ANSWER (${j}s)"
    CURRENT="$ANSWER"
    CHAIN+=("$ANSWER")
  else
    echo "  $NAME ($RT): [timeout]"
    CURRENT="意气风发"
    CHAIN+=("(skip)")
  fi
done

echo ""
echo "========================================="
echo "  Chain: ${CHAIN[*]}"
echo "  Length: ${#CHAIN[@]}"
echo "========================================="

for PID in "${PIDS[@]}"; do kill $PID 2>/dev/null || true; done
echo "Done!"

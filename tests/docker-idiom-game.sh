#!/bin/bash
# 10-Agent Idiom Chain Game (成语接龙)
# 5 codex-sdk (GPT-5.4) + 5 mock agents (simulating minimax until Claude Code available)
set -e

echo ""
echo "========================================="
echo "  10-Agent Idiom Chain Game (成语接龙)"
echo "========================================="
echo ""

# Start CommHub
echo "Starting CommHub..."
cd /app/server && bun run src/index.ts &
sleep 3
curl -s http://127.0.0.1:9200/health | grep -q '"ok":true' || { echo "CommHub failed"; exit 1; }
echo "CommHub ready."
echo ""

# MCP helper
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"game","version":"1.0"}}}'
mcp_call() {
  local TOOL="$1"
  local ARGS="$2"
  curl -s -X POST http://127.0.0.1:9200/mcp \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$MCP_INIT" > /dev/null 2>&1
  curl -s -X POST http://127.0.0.1:9200/mcp \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":$ARGS}}"
}

extract_text() {
  python3 -c "
import sys,json
raw=sys.stdin.read()
for line in raw.strip().split('\n'):
  if line.startswith('data: '): raw=line[6:]
try:
  d=json.loads(raw)
  t=json.loads(d.get('result',{}).get('content',[{}])[0].get('text','{}'))
  print(t.get('message_id',''))
except: print('')
"
}

# Create 10 agents
echo "Creating 10 agent nodes..."
mkdir -p /tmp/game && cd /tmp/game

AGENTS=()
for i in $(seq 1 10); do
  NAME="player-$i"
  RUNTIME="codex-sdk"
  anet node create "$NAME" --runtime "$RUNTIME" --model gpt-5.4 2>&1 >/dev/null
  AGENTS+=("$NAME")
done
echo "Created: ${AGENTS[*]}"
echo ""

# Start all 10 agents
echo "Starting all agents..."
PIDS=()
for NAME in "${AGENTS[@]}"; do
  timeout 120 agent-node --alias "$NAME" --config ".anet/nodes/$NAME/config.json" 2>&1 &
  PIDS+=($!)
done
sleep 8

# Verify all registered
echo "Verifying registrations..."
REGISTERED=0
for NAME in "${AGENTS[@]}"; do
  STATUS=$(curl -s http://127.0.0.1:9200/api/status 2>/dev/null | python3 -c "
import sys,json
data=json.load(sys.stdin)
found = any(s['alias']=='$NAME' for s in data['sessions'])
print('yes' if found else 'no')
" 2>/dev/null)
  if [ "$STATUS" = "yes" ]; then
    REGISTERED=$((REGISTERED+1))
  else
    echo "  Warning: $NAME not registered"
  fi
done
echo "$REGISTERED/10 agents registered."
echo ""

# Game: 2 rounds of idiom chain
echo "========================================="
echo "  Round 1: Idiom Chain"
echo "========================================="
echo ""

# Start with a seed idiom
CURRENT_IDIOM="一心一意"
echo "Starting idiom: $CURRENT_IDIOM"
echo ""

CHAIN=("$CURRENT_IDIOM")
GAME_LOG=""

for ROUND in 1 2; do
  echo "--- Round $ROUND ---"
  for i in $(seq 1 10); do
    NAME="player-$i"
    LAST_CHAR=$(echo "$CURRENT_IDIOM" | python3 -c "import sys; s=sys.stdin.read().strip(); print(s[-1] if s else '意')")

    # Send task: continue the idiom chain
    TASK="成语接龙游戏！上一个成语是「${CURRENT_IDIOM}」，最后一个字是「${LAST_CHAR}」。请说一个以「${LAST_CHAR}」开头的四字成语。只回复成语本身，不要解释。"

    RESP=$(mcp_call "send_task" "{\"alias\":\"$NAME\",\"task\":\"$TASK\",\"from_session\":\"game-master\",\"priority\":\"high\"}")
    TASK_ID=$(echo "$RESP" | extract_text)

    if [ -z "$TASK_ID" ]; then
      echo "  $NAME: [send failed]"
      continue
    fi

    # Wait for reply (max 20s)
    ANSWER=""
    for j in $(seq 1 20); do
      sleep 1
      CHECK=$(curl -s "http://127.0.0.1:9200/api/tasks?task_id=$TASK_ID" 2>/dev/null)
      if echo "$CHECK" | grep -q '"replied"'; then
        ANSWER=$(echo "$CHECK" | python3 -c "
import sys,json,re
data=json.loads(sys.stdin.read())
tasks=data.get('tasks',[])
if tasks:
  r = tasks[0].get('result','')
  # Extract 4-char idiom from response
  m = re.search(r'[\u4e00-\u9fff]{4}', r)
  print(m.group(0) if m else r[:20])
else: print('')
" 2>/dev/null)
        break
      fi
    done

    if [ -n "$ANSWER" ]; then
      echo "  $NAME: $CURRENT_IDIOM → $ANSWER (${j}s)"
      CURRENT_IDIOM="$ANSWER"
      CHAIN+=("$ANSWER")
    else
      echo "  $NAME: [timeout — no reply in 20s]"
      # Use a fallback to keep the game going
      CURRENT_IDIOM="意气风发"
      CHAIN+=("(fallback)")
    fi
  done
  echo ""
done

# Print final chain
echo "========================================="
echo "  Idiom Chain Result"
echo "========================================="
echo ""
echo "Chain: ${CHAIN[*]}"
echo "Length: ${#CHAIN[@]} idioms"
echo ""

# Cleanup
for PID in "${PIDS[@]}"; do
  kill $PID 2>/dev/null || true
done

echo "Game complete!"

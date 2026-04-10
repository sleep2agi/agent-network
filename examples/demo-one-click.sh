#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║  Agent Network — One-Click Demo                      ║
# ║  Shows the full lifecycle in 60 seconds               ║
# ╚══════════════════════════════════════════════════════╝
set -e

C_GREEN='\033[0;32m'
C_BLUE='\033[0;34m'
C_YELLOW='\033[1;33m'
C_CYAN='\033[0;36m'
C_BOLD='\033[1m'
C_DIM='\033[2m'
C_RESET='\033[0m'

banner() { echo -e "\n${C_BOLD}${C_BLUE}═══ $1 ═══${C_RESET}\n"; }
ok()     { echo -e "  ${C_GREEN}✓${C_RESET} $1"; }
info()   { echo -e "  ${C_CYAN}→${C_RESET} $1"; }
step()   { echo -e "\n${C_YELLOW}[$1/8]${C_RESET} ${C_BOLD}$2${C_RESET}"; }

HUB="http://127.0.0.1:9200"
MCP_ACCEPT="Accept: application/json, text/event-stream"

echo -e "${C_BOLD}"
echo "  ╔═══════════════════════════════════════╗"
echo "  ║   🌐 Agent Network Demo               ║"
echo "  ║   Multi-Agent Communication Hub        ║"
echo "  ╚═══════════════════════════════════════╝"
echo -e "${C_RESET}"

# ── Step 1: Check server ──
step 1 "Checking CommHub Server"
HEALTH=$(curl -sf "$HUB/health" 2>/dev/null || echo "{}")
if echo "$HEALTH" | grep -q '"ok":true'; then
  VER=$(echo "$HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null)
  ok "Server running (v$VER)"
else
  echo -e "  ${C_YELLOW}Starting local server...${C_RESET}"
  echo "  Run: bunx @sleep2agi/commhub-server"
  echo "  Then re-run this demo."
  exit 1
fi

# ── Step 2: Register user ──
step 2 "Creating Demo User"
# Try with COMMHUB_AUTH_TOKEN if set, or from ~/.anet/config.json
GLOBAL_TOKEN="${COMMHUB_AUTH_TOKEN:-}"
if [ -z "$GLOBAL_TOKEN" ] && [ -f "$HOME/.anet/config.json" ]; then
  GLOBAL_TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.anet/config.json')).get('token',''))" 2>/dev/null || echo "")
fi
GLOBAL_AUTH=""
[ -n "$GLOBAL_TOKEN" ] && GLOBAL_AUTH="Authorization: Bearer $GLOBAL_TOKEN"

REG=$(curl -sf -X POST "$HUB/api/auth/register" \
  -H "Content-Type: application/json" \
  ${GLOBAL_AUTH:+-H "$GLOBAL_AUTH"} \
  -d '{"username":"demo","password":"demo123456"}' 2>/dev/null || echo '{"ok":false}')
if echo "$REG" | grep -q '"ok":true'; then
  TOKEN=$(echo "$REG" | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])" 2>/dev/null)
  ok "User 'demo' registered"
else
  # Try login instead
  LOGIN=$(curl -sf -X POST "$HUB/api/auth/login" \
    -H "Content-Type: application/json" \
    ${GLOBAL_AUTH:+-H "$GLOBAL_AUTH"} \
    -d '{"username":"demo","password":"demo123456"}' 2>/dev/null || echo '{"ok":false}')
  if echo "$LOGIN" | grep -q '"ok":true'; then
    TOKEN=$(echo "$LOGIN" | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])" 2>/dev/null)
    ok "User 'demo' logged in"
  elif [ -n "$GLOBAL_TOKEN" ]; then
    TOKEN="$GLOBAL_TOKEN"
    ok "Using global auth token"
  else
    echo -e "  ${C_YELLOW}No auth token found. Set COMMHUB_AUTH_TOKEN or run: anet login${C_RESET}"
    exit 1
  fi
fi
AUTH="Authorization: Bearer $TOKEN"
info "Token: ${TOKEN:0:15}..."

# ── Step 3: Network info ──
step 3 "Checking Network"
NETS=$(curl -sf "$HUB/api/networks" -H "$AUTH" 2>/dev/null || echo "[]")
NET_COUNT=$(echo "$NETS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo "0")
if [ "$NET_COUNT" -gt 0 ]; then
  ok "$NET_COUNT network(s) available"
else
  ok "Default network (no V3 user)"
fi

# ── Step 4: Register virtual agents ──
step 4 "Registering 3 Demo Agents"
GLOBAL_TOKEN=$(grep -o '"COMMHUB_AUTH_TOKEN":[^,}]*' /dev/null 2>/dev/null || echo "")
# Use the V3 token for MCP calls
mcp() {
  curl -sf -X POST "$HUB/mcp" -H "$AUTH" -H "Content-Type: application/json" -H "$MCP_ACCEPT" -d "$1" 2>/dev/null | grep -o 'data:.*' | sed 's/^data: //'
}

for AGENT in "alpha:GPT-5.4:working on analysis" "beta:Claude:translating docs" "gamma:MiniMax:monitoring tasks"; do
  IFS=: read -r NAME MODEL TASK <<< "$AGENT"
  mcp "{\"jsonrpc\":\"2.0\",\"id\":\"r-$NAME\",\"method\":\"tools/call\",\"params\":{\"name\":\"report_status\",\"arguments\":{\"resume_id\":\"demo-$NAME\",\"alias\":\"$NAME\",\"status\":\"idle\",\"agent\":\"agent-node:demo\",\"model\":\"$MODEL\"}}}" >/dev/null
  ok "Agent '$NAME' online (model: $MODEL)"
done

# ── Step 5: Send tasks ──
step 5 "Dispatching Tasks"
TASKS=(
  '{"alias":"alpha","task":"Analyze the top 5 trending AI papers this week and summarize key innovations","from_session":"demo-hub","priority":"high"}'
  '{"alias":"beta","task":"Translate the project README from Chinese to English, preserving technical terms","from_session":"demo-hub"}'
  '{"alias":"gamma","task":"Monitor system health: check CPU, memory, disk usage and report anomalies","from_session":"demo-hub"}'
)
for T in "${TASKS[@]}"; do
  ALIAS=$(echo "$T" | python3 -c "import json,sys; print(json.load(sys.stdin)['alias'])" 2>/dev/null)
  mcp "{\"jsonrpc\":\"2.0\",\"id\":\"t-$ALIAS\",\"method\":\"tools/call\",\"params\":{\"name\":\"send_task\",\"arguments\":$T}}" >/dev/null
  PRIO=$(echo "$T" | python3 -c "import json,sys; print(json.load(sys.stdin).get('priority','normal'))" 2>/dev/null)
  TASK_TEXT=$(echo "$T" | python3 -c "import json,sys; print(json.load(sys.stdin)['task'][:60])" 2>/dev/null)
  [ "$PRIO" = "high" ] && P="${C_YELLOW}[HIGH]${C_RESET}" || P=""
  ok "→ $ALIAS: $TASK_TEXT... $P"
done

# ── Step 6: Simulate agent work ──
step 6 "Agents Processing..."
sleep 1
for AGENT in alpha beta gamma; do
  mcp "{\"jsonrpc\":\"2.0\",\"id\":\"w-$AGENT\",\"method\":\"tools/call\",\"params\":{\"name\":\"report_status\",\"arguments\":{\"resume_id\":\"demo-$AGENT\",\"alias\":\"$AGENT\",\"status\":\"working\",\"progress\":50}}}" >/dev/null
done
info "All 3 agents working..."
sleep 1

# Complete tasks
mcp '{"jsonrpc":"2.0","id":"c1","method":"tools/call","params":{"name":"report_completion","arguments":{"alias":"alpha","task":"Analyze the top 5 trending AI papers this week and summarize key innovations","result":"Top 5: 1) Scaling Laws for LLM Agents 2) Multi-Modal Reasoning 3) Code Generation Benchmarks 4) RLHF Improvements 5) Efficient Inference"}}}' >/dev/null
ok "alpha completed: AI papers analysis"

mcp '{"jsonrpc":"2.0","id":"c2","method":"tools/call","params":{"name":"report_completion","arguments":{"alias":"beta","task":"Translate the project README from Chinese to English, preserving technical terms","result":"Translation complete. 196 lines, 12 code blocks preserved, technical terms (MCP, SSE, CommHub) kept intact."}}}' >/dev/null
ok "beta completed: README translation"

mcp '{"jsonrpc":"2.0","id":"c3","method":"tools/call","params":{"name":"report_completion","arguments":{"alias":"gamma","task":"Monitor system health: check CPU, memory, disk usage and report anomalies","result":"System healthy. CPU: 23%, Memory: 4.2GB/16GB, Disk: 45% used. No anomalies detected."}}}' >/dev/null
ok "gamma completed: health check"

# ── Step 7: Show results ──
step 7 "Results Dashboard"
echo ""
echo -e "${C_DIM}  ┌──────────┬────────────┬──────────────────────────────────────────┐${C_RESET}"
echo -e "${C_DIM}  │${C_RESET} ${C_BOLD}Agent${C_RESET}    ${C_DIM}│${C_RESET} ${C_BOLD}Status${C_RESET}     ${C_DIM}│${C_RESET} ${C_BOLD}Result${C_RESET}                                   ${C_DIM}│${C_RESET}"
echo -e "${C_DIM}  ├──────────┼────────────┼──────────────────────────────────────────┤${C_RESET}"

# Fetch actual status
STATUS=$(mcp '{"jsonrpc":"2.0","id":"s","method":"tools/call","params":{"name":"get_all_status","arguments":{}}}')

for AGENT in alpha beta gamma; do
  S=$(echo "$STATUS" | python3 -c "
import json,sys
d=json.loads(json.load(sys.stdin)['result']['content'][0]['text'])
for s in d['sessions']:
  if s['alias']=='$AGENT':
    print(s['status'])
    break
" 2>/dev/null || echo "?")
  [ "$S" = "idle" ] && SC="${C_GREEN}$S${C_RESET}" || SC="$S"
  echo -e "${C_DIM}  │${C_RESET} ${C_CYAN}$AGENT${C_RESET}    ${C_DIM}│${C_RESET} $SC       ${C_DIM}│${C_RESET} task completed                           ${C_DIM}│${C_RESET}"
done
echo -e "${C_DIM}  └──────────┴────────────┴──────────────────────────────────────────┘${C_RESET}"

# Task stats
STATS=$(curl -sf "$HUB/api/stats" -H "$AUTH" 2>/dev/null)
echo ""
info "Task stats: $(echo "$STATS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"total={d['tasks']['total']}, by_status={d['tasks']['by_status']}\")" 2>/dev/null)"

# ── Step 8: What's next ──
step 8 "Explore More"
echo ""
echo -e "  ${C_BOLD}Dashboard:${C_RESET}  https://agent-net.vansin.me"
echo -e "  ${C_BOLD}CLI:${C_RESET}        anet status / anet tasks / anet demo"
echo -e "  ${C_BOLD}API docs:${C_RESET}   $HUB/health"
echo ""
echo -e "  ${C_DIM}npm i -g @sleep2agi/agent-network@preview${C_RESET}"
echo -e "  ${C_DIM}npm i -g @sleep2agi/agent-node@preview${C_RESET}"
echo ""
echo -e "${C_GREEN}${C_BOLD}  Demo complete! 🎉${C_RESET}"
echo ""

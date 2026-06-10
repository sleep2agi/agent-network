#!/usr/bin/env bash
# #214 维度 1 — getting-started.md 首装路径 Docker E2E
# Records doc-says vs actually-happens for each step.
set -u
ART=/artifacts
NODE_TAG="${NODE_TAG:-node24}"
ANET_V="$(anet -v 2>&1 || true)"
LOG(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$ART/run.log"; }
mask(){ sed -E 's/(utok_|ntok_|sk-|tp-|xai-|sk-ant-)[A-Za-z0-9_-]+/\1•••MASKED•••/g'; }
HUB=http://127.0.0.1:9200
FINDINGS=()

push_finding(){
  # 维度/现象/级别/details
  FINDINGS+=("$1")
}

mkdir -p "$ART"
: > "$ART/run.log"
: > "$ART/findings.txt"
echo "# #214 维度 1 — Docker E2E ($NODE_TAG)" > "$ART/report.md"
echo "Node: $(node -v) | Bun: $(bun --version) | anet: $ANET_V" | tee -a "$ART/report.md" >> "$ART/run.log"
echo >> "$ART/report.md"

# ============================================================
# Step 0 — Pre-flight (Node + Bun versions vs doc claim)
# Doc says: Node ≥ 22.13.0, Bun ≥ 1.2.0
# ============================================================
LOG "Step 0 — pre-flight"
NODE_VER=$(node -v | sed 's/v//')
BUN_VER=$(bun --version 2>/dev/null || echo "missing")
{
  echo "## Step 0 — pre-flight"
  echo "- Doc says: Node ≥ 22.13.0, Bun ≥ 1.2.0"
  echo "- Actual:   Node $NODE_VER, Bun $BUN_VER"
  if [ "$BUN_VER" = "missing" ]; then
    echo "- ⚠️ DOC-CLAIM-GAP: doc says \"commhub-server 与 agent-node 在第一次需要时由 bunx / npx 自动拉取，无需手动安装\" — but bun itself NOT auto-installed. Fresh user with Node only will hit 'bunx: command not found' on Step 2."
    push_finding "维度1/Step0/Bun 缺失被 doc 隐藏/级别 P1/用户:'commhub-server 与 agent-node 在第一次需要时由 bunx / npx 自动拉取，无需手动安装' 容易误读为 Bun 也会被自动拉取。一台只装 Node 的机器跑 'anet hub start' 会在第一次 bunx 时报 command not found，doc 应在 §0 明示 Bun 是用户自装前提。"
  else
    echo "- ✅ Bun present (system pre-install in this image; in a real fresh box user must install Bun separately — same finding still applies)"
    push_finding "维度1/Step0/Bun 自装提示弱/级别 P2/Doc §0 '依赖' 表只列 Bun 版本号, '由 bunx / npx 自动拉取' 那行紧跟其后会让快读用户误以为 Bun 也自动。建议拆成 '前置(需手装)' + '自动拉取' 两段。"
  fi
  echo
} >> "$ART/report.md"

# ============================================================
# Step 1 — 安装 CLI (npm install -g @sleep2agi/agent-network)
# Doc says: 只需要装一个全局包. 验证: anet -v
# ============================================================
LOG "Step 1 — install verify"
# (install was done in Dockerfile to bake the image; verify the command works)
anet -v > "$ART/step1-v.log" 2>&1
RC=$?
{
  echo "## Step 1 — anet -v"
  echo '```'
  cat "$ART/step1-v.log"
  echo '```'
  echo "- exit code: $RC"
  if [ $RC -eq 0 ]; then
    echo "- ✅ command runs, version printed"
    # is the v output user-friendly?
    if grep -qE '^v?[0-9]' "$ART/step1-v.log"; then
      echo "- ✅ printed in 'vX.Y.Z' shape"
    else
      echo "- ⚠️ output shape unusual: \"$(cat $ART/step1-v.log | tr -d '\n')\""
      push_finding "维度1/Step1/anet -v 输出非常规/级别 P3/用户预期 'vX.Y.Z'。实际 '$(cat $ART/step1-v.log | tr -d '\n')'。"
    fi
  else
    echo "- ❌ exit code $RC"
    push_finding "维度1/Step1/anet -v 失败/级别 P0/install 后基本验证命令报错 rc=$RC，新用户 1 步就卡。"
  fi
  echo
} >> "$ART/report.md"

# ============================================================
# Step 2 — anet hub start
# Doc says:
#   - 默认只监听 http://127.0.0.1:9200
#   - SQLite 数据库在 ~/.commhub/commhub.db
#   - 自动创建默认管理员账号 admin / anethub
#   - 终端会打印局域网 URL + 重置数据提示
#   - v0.10.11+ 提供 anet hub status / anet hub stop
# ============================================================
LOG "Step 2 — hub start"
nohup anet hub start > "$ART/step2-hub.log" 2>&1 &
WRAPPER_PID=$!
HUB_UP=""
for i in $(seq 1 120); do
  if curl -sf --max-time 2 "$HUB/health" >/dev/null 2>&1; then HUB_UP="yes"; break; fi
  sleep 0.5
done
HEALTH=$(curl -sf --max-time 3 "$HUB/health" 2>/dev/null | jq -c '{ok,version}' 2>/dev/null || echo '{}')
LOG "step2: /health → $HEALTH"
{
  echo "## Step 2 — anet hub start"
  echo "### Doc claims:"
  echo "- 默认监听 http://127.0.0.1:9200 — actual: $([ "$HUB_UP" = "yes" ] && echo "✅ /health 200 → $HEALTH" || echo "❌ unreachable")"
  echo "- SQLite at ~/.commhub/commhub.db — $([ -f /root/.commhub/commhub.db ] || [ -f ~/.commhub/commhub.db ] && echo "✅ file exists" || echo "❌ not found")"
  echo "- 自动创建 admin / anethub — $(grep -q 'admin' "$ART/step2-hub.log" && grep -q 'anethub' "$ART/step2-hub.log" && echo "✅ printed in hub log" || echo "⚠️ not visible in log")"
  echo "- LAN URL printed — $(grep -qE 'LAN.*http|\(LAN' "$ART/step2-hub.log" && echo "✅ visible" || echo "⚠️ not visible")"
  echo "- '重置数据' hint — $(grep -qE 'wipe everything|rm -rf|清空|重置|Start fresh' "$ART/step2-hub.log" && echo "✅ visible" || echo "⚠️ not visible")"
  echo
  echo "### hub log first 60 lines:"
  echo '```'
  head -60 "$ART/step2-hub.log" | mask
  echo '```'
  echo
} >> "$ART/report.md"

# v0.10.11+ tip — anet hub status + anet hub stop
LOG "Step 2 tip — hub status + stop"
anet hub status > "$ART/step2-status.log" 2>&1
RC_STATUS=$?
{
  echo "### tip box: \`anet hub status\` (v0.10.11+)"
  echo '```'
  cat "$ART/step2-status.log" | mask
  echo '```'
  echo "- exit code: $RC_STATUS"
  if [ $RC_STATUS -eq 0 ]; then
    if grep -qiE 'pid|port|version' "$ART/step2-status.log"; then
      echo "- ✅ PID / port / version visible (matches doc)"
    else
      echo "- ⚠️ output present but missing PID/port/version triad"
      push_finding "维度1/Step2 tip/anet hub status 输出不全/级别 P2/Doc 说 '显示 PID / port / commhub-server 版本'，实际输出未三者俱全（用户难以 grep）。"
    fi
  else
    echo "- ❌ command failed"
    push_finding "维度1/Step2 tip/anet hub status 失败/级别 P1/Doc 在 v0.10.11+ 提示框承诺该命令，但实际 rc=$RC_STATUS。"
  fi
  echo
} >> "$ART/report.md"

# ============================================================
# Step 3 — anet hub dashboard (SKIP — no browser, but try the command)
# ============================================================
LOG "Step 3 — dashboard (probe only)"
nohup anet hub dashboard > "$ART/step3-dash.log" 2>&1 &
DASH_PID=$!
sleep 6
DASH_UP=""
for i in $(seq 1 12); do
  if curl -sf --max-time 2 http://127.0.0.1:3000/ >/dev/null 2>&1; then DASH_UP="yes"; break; fi
  sleep 1
done
{
  echo "## Step 3 — anet hub dashboard"
  echo "- HTTP probe http://localhost:3000/ — $([ "$DASH_UP" = "yes" ] && echo "✅ reachable" || echo "⚠️ not reachable in 24s (this is auth-free probe; full browser UAT = Vincent)")"
  echo "- log tail:"
  echo '```'
  tail -30 "$ART/step3-dash.log" | mask
  echo '```'
} >> "$ART/report.md"
[ "$DASH_UP" = "yes" ] || push_finding "维度1/Step3/dashboard 启动慢或失败/级别 P2/24s 内 localhost:3000 仍未响应；Doc 没提示 first-run 编译时间预期。"
echo >> "$ART/report.md"

# ============================================================
# Step 4 — anet login + whoami
# ============================================================
LOG "Step 4 — login + whoami"
anet login --username admin --password anethub > "$ART/step4-login.log" 2>&1
RC_LOGIN=$?
anet whoami > "$ART/step4-whoami.log" 2>&1
RC_WHOAMI=$?
{
  echo "## Step 4 — login + whoami"
  echo "- \`anet login\` rc=$RC_LOGIN"
  echo '```'
  cat "$ART/step4-login.log" | mask
  echo '```'
  echo "- \`anet whoami\` rc=$RC_WHOAMI"
  echo '```'
  cat "$ART/step4-whoami.log" | mask
  echo '```'
  if [ $RC_LOGIN -eq 0 ] && [ -f ~/.anet/config.json ]; then
    echo "- ✅ config.json written (Doc claim verified)"
  else
    echo "- ❌ login flow broke"
    push_finding "维度1/Step4/login 流失败/级别 P0/rc=$RC_LOGIN，config.json $([ -f ~/.anet/config.json ] && echo '存在' || echo '缺失')。"
  fi
  echo
} >> "$ART/report.md"

# ============================================================
# Step 5 — anet node create my-bot (wizard PROBE)
# Doc says: 先选供应商、再选模型. We probe the first prompt only.
# ============================================================
LOG "Step 5 — node create wizard probe"
timeout 35 drive-node-create.exp > "$ART/step5-wizard.log" 2>&1 || true
{
  echo "## Step 5 — \`anet node create my-bot\` (wizard probe)"
  echo "Driven with \`expect\`, Ctrl-C after first prompt observed."
  echo "### wizard trace:"
  echo '```'
  cat "$ART/wizard-trace.txt" 2>/dev/null | mask | head -80
  echo '```'
  if grep -q 'DOC-MATCH: vendor prompt shown' "$ART/step5-wizard.log"; then
    echo "- ✅ first prompt = vendor (doc claim '先选供应商、再选模型' verified)"
  elif grep -q 'DOC-MISMATCH' "$ART/step5-wizard.log"; then
    echo "- ❌ DOC-MISMATCH — see trace"
    push_finding "维度1/Step5/wizard 首选项与 doc 不符/级别 P1/Doc §5 说 '先选供应商、再选模型'，实际 wizard 行为偏离（trace 见 step5-wizard.log）。"
  else
    echo "- ⚠️ wizard probe timeout/EOF — no first prompt classified"
  fi
  echo
} >> "$ART/report.md"

# Now create node bypassing wizard via --runtime grok-build-acp (no auth needed)
LOG "Step 5b — node create --runtime grok-build-acp (non-interactive bypass)"
anet node create my-bot --runtime grok-build-acp > "$ART/step5b-create.log" 2>&1
RC_MK=$?
{
  echo "### Step 5b — \`--runtime\` flag bypass (for harness completion)"
  echo "- \`anet node create my-bot --runtime grok-build-acp\` rc=$RC_MK"
  echo '```'
  head -25 "$ART/step5b-create.log" | mask
  echo '```'
  CFG=/work/.anet/nodes/my-bot/config.json
  if [ -f "$CFG" ]; then
    echo "- ✅ \`.anet/nodes/my-bot/config.json\` written at doc-claimed path"
  else
    echo "- ❌ config not at doc-claimed path \`.anet/nodes/my-bot/config.json\`"
    push_finding "维度1/Step5/config 路径偏离 doc/级别 P1/Doc §5 'config 会写到当前目录下 .anet/nodes/my-bot/config.json'，实际未找到该文件。"
  fi
  echo
} >> "$ART/report.md"

# ============================================================
# Step 6 — anet node start my-bot — expect "SSE connected"
# ============================================================
LOG "Step 6 — node start"
nohup anet node start my-bot > "$ART/step6-start.log" 2>&1 &
NODE_PID=$!
# wait up to 45s for SSE connected line OR registration in /api/status
REGD=""
SSE_LINE=""
UTOK=$(jq -r '.token' ~/.anet/config.json 2>/dev/null)
for i in $(seq 1 45); do
  if grep -qE 'SSE.*connect|sse.*connect' "$ART/step6-start.log" 2>/dev/null; then
    SSE_LINE=$(grep -E 'SSE.*connect|sse.*connect' "$ART/step6-start.log" | head -1)
    break
  fi
  SESS=$(curl -sf "$HUB/api/status" -H "Authorization: Bearer $UTOK" 2>/dev/null | jq -c '[.sessions[]?|select(.alias=="my-bot")][0]' 2>/dev/null)
  [ -n "$SESS" ] && [ "$SESS" != "null" ] && REGD="$SESS"
  [ -n "$REGD" ] && break
  sleep 1
done
{
  echo "## Step 6 — \`anet node start my-bot\`"
  echo "Doc says: 看到 \`SSE connected\` 即表示节点已上线"
  if [ -n "$SSE_LINE" ]; then
    echo "- ✅ \`SSE connected\` visible in log: \`$SSE_LINE\`"
  elif [ -n "$REGD" ]; then
    echo "- ⚠️ no literal 'SSE connected' string, but node DID register on hub: \`$(echo "$REGD" | mask)\`"
    push_finding "维度1/Step6/'SSE connected' 提示词不见/级别 P2/Doc 承诺看到 'SSE connected' 即上线，实际节点已 register 但输出里没有这个字符串。用户照 doc 找信号会觉得 '没上线' 反复重试。"
  else
    echo "- ❌ neither SSE-connected line nor hub registration within 45s"
    push_finding "维度1/Step6/节点未上线/级别 P0/anet node start 后 45s 内既无 'SSE connected' 输出，也未在 /api/status 出现。"
  fi
  echo "- start log tail:"
  echo '```'
  tail -40 "$ART/step6-start.log" | mask
  echo '```'
  echo
} >> "$ART/report.md"

# ============================================================
# Step 7-8 — dashboard chat + multi-agent: SKIP (browser UAT)
# Step 9 — anet project up/restart/down — bonus
# ============================================================
{
  echo "## Step 7-8 — Dashboard chat + multi-agent collab"
  echo "- ⏭ SKIP (browser UAT, Vincent path). Auth-free probe = dashboard reachable above."
  echo
} >> "$ART/report.md"

LOG "Step 9 — project up/restart/down"
# Create a 2nd node so project has > 1
anet node create video-bot --runtime grok-build-acp > "$ART/step9-mk2.log" 2>&1
RC_MK2=$?
# stop the running my-bot first so 'project up' has clean state
kill -TERM "$NODE_PID" 2>/dev/null; sleep 2

# project up
anet project up --stagger 1 > "$ART/step9-up.log" 2>&1
RC_UP=$?
sleep 3
# project restart
anet project restart --stagger 1 > "$ART/step9-restart.log" 2>&1 &
RC_RESTART_PID=$!
sleep 5
kill -TERM $RC_RESTART_PID 2>/dev/null
# project down
anet project down > "$ART/step9-down.log" 2>&1
RC_DOWN=$?
{
  echo "## Step 9 — \`anet project up/restart/down\`"
  for cmd in up restart down; do
    case "$cmd" in
      up) rc=$RC_UP; logf=step9-up.log;;
      restart) rc=N/A; logf=step9-restart.log;;
      down) rc=$RC_DOWN; logf=step9-down.log;;
    esac
    echo "### \`anet project $cmd\` (rc=$rc)"
    echo '```'
    head -30 "$ART/$logf" | mask
    echo '```'
  done
  [ $RC_UP -eq 0 ] || push_finding "维度1/Step9/anet project up 失败/级别 P1/2 节点的 project up 报错 rc=$RC_UP; doc 把它当默认推荐替代单点 start。"
  echo
} >> "$ART/report.md"

# ============================================================
# Findings rollup
# ============================================================
{
  echo "## Findings 总览 ($NODE_TAG)"
  echo
  if [ ${#FINDINGS[@]} -eq 0 ]; then
    echo "- 0 findings — 全步骤照 doc 走通 ✅"
  else
    for f in "${FINDINGS[@]}"; do echo "- $f"; done
  fi
} >> "$ART/report.md"

# emit findings.txt for cross-dim aggregation (line-format)
for f in "${FINDINGS[@]}"; do echo "$f" >> "$ART/findings.txt"; done

# cleanup
kill -TERM "$DASH_PID" 2>/dev/null
for p in $(pgrep -f 'commhub-server' 2>/dev/null); do kill -TERM "$p" 2>/dev/null; done

echo "=== REPORT ==="
cat "$ART/report.md"
echo
echo "=== artifacts ==="
ls -la "$ART"

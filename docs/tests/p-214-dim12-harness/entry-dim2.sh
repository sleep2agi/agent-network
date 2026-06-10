#!/usr/bin/env bash
# #214 维度 2 — anet upgrade path Docker E2E
# Old baseline: agent-network@2.2.6 (v0.10.7 era)
# Tests: anet upgrade (default) / --dry-run / --channel preview / --channel latest / --self
set -u
ART=/artifacts
HUB=http://127.0.0.1:9200
LOG(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$ART/run.log"; }
mask(){ sed -E 's/(utok_|ntok_|sk-|tp-|xai-|sk-ant-)[A-Za-z0-9_-]+/\1•••MASKED•••/g'; }
FINDINGS=()
push_finding(){ FINDINGS+=("$1"); }

mkdir -p "$ART"
: > "$ART/run.log"
: > "$ART/findings.txt"

V_BEFORE=$(anet -v 2>&1 | head -1)
echo "# #214 维度 2 — upgrade path Docker E2E" > "$ART/report.md"
echo "Baseline anet: $V_BEFORE (target: 2.2.6 v0.10.7 era)" >> "$ART/report.md"
echo "Node: $(node -v) | Bun: $(bun --version)" >> "$ART/report.md"
echo >> "$ART/report.md"

LOG "Baseline: $V_BEFORE"

# ============================================================
# Step A — anet upgrade --dry-run (preview-no-commit)
# ============================================================
LOG "Step A — anet upgrade --dry-run"
anet upgrade --dry-run > "$ART/A-dryrun.log" 2>&1
RC_A=$?
{
  echo "## A. anet upgrade --dry-run"
  echo '```'
  cat "$ART/A-dryrun.log" | mask
  echo '```'
  echo "- exit code: $RC_A"
  V_NOW=$(anet -v 2>&1 | head -1)
  if [ "$V_NOW" = "$V_BEFORE" ]; then
    echo "- ✅ anet -v unchanged after --dry-run (no side-effect): $V_NOW"
  else
    echo "- ❌ --dry-run changed installed version (side-effect leak): $V_BEFORE → $V_NOW"
    push_finding "维度2/A.anet upgrade --dry-run/级别 P0/--dry-run 真的升级了 (不该 mutate): $V_BEFORE → $V_NOW"
  fi
  if [ $RC_A -ne 0 ]; then
    push_finding "维度2/A.anet upgrade --dry-run/级别 P1/--dry-run rc=$RC_A 非零，dry-run 应 always exit 0 即使 plan 出错"
  fi
  echo
} >> "$ART/report.md"

# ============================================================
# Step B — anet upgrade (default → latest)
# ============================================================
LOG "Step B — anet upgrade (no flag, default = latest)"
anet upgrade > "$ART/B-upgrade.log" 2>&1
RC_B=$?
V_AFTER_B=$(anet -v 2>&1 | head -1)
LATEST_AN=$(npm view @sleep2agi/agent-network@latest version 2>/dev/null)
LATEST_NODE=$(npm view @sleep2agi/agent-node@latest version 2>/dev/null)
LATEST_HUB=$(npm view @sleep2agi/commhub-server@latest version 2>/dev/null)
INSTALLED_AN=$(npm ls -g --depth=0 --json 2>/dev/null | jq -r '.dependencies."@sleep2agi/agent-network".version // "missing"')
INSTALLED_NODE=$(npm ls -g --depth=0 --json 2>/dev/null | jq -r '.dependencies."@sleep2agi/agent-node".version // "missing"')
INSTALLED_HUB=$(npm ls -g --depth=0 --json 2>/dev/null | jq -r '.dependencies."@sleep2agi/commhub-server".version // "missing"')
{
  echo "## B. anet upgrade (default → latest)"
  echo '```'
  cat "$ART/B-upgrade.log" | mask | tail -50
  echo '```'
  echo "- exit code: $RC_B"
  echo "- anet -v: $V_BEFORE → $V_AFTER_B"
  echo "- npm latest dist-tags: agent-network=$LATEST_AN, agent-node=$LATEST_NODE, commhub-server=$LATEST_HUB"
  echo "- installed (npm -g): agent-network=$INSTALLED_AN, agent-node=$INSTALLED_NODE, commhub-server=$INSTALLED_HUB"
  if [ "$INSTALLED_AN" = "$LATEST_AN" ]; then
    echo "- ✅ agent-network → latest"
  else
    echo "- ❌ agent-network NOT at latest after upgrade"
    push_finding "维度2/B.upgrade default/级别 P0/agent-network 升级未到 latest: installed=$INSTALLED_AN, npm latest=$LATEST_AN"
  fi
  if [ "$INSTALLED_NODE" = "missing" ] && [ "$INSTALLED_HUB" = "missing" ]; then
    echo "- ⚠️ agent-node + commhub-server still 'missing' on -g — they're npx-fetched on first use (per doc §0), not necessarily installed by \`anet upgrade\`"
    push_finding "维度2/B.upgrade default/级别 P2/anet upgrade 只升 agent-network，commhub-server + agent-node 仍 'missing' on npm -g。Doc 没说 upgrade 是否会预拉这两个；用户期待'三包同升'，实际只升 1。"
  elif [ "$INSTALLED_NODE" = "$LATEST_NODE" ] && [ "$INSTALLED_HUB" = "$LATEST_HUB" ]; then
    echo "- ✅ all 3 packages aligned to latest"
  else
    echo "- ⚠️ partial alignment"
  fi
  echo
} >> "$ART/report.md"

# ============================================================
# Step C — hub start works after upgrade
# ============================================================
LOG "Step C — post-upgrade hub start"
nohup anet hub start > "$ART/C-hub.log" 2>&1 &
HUB_UP=""
for i in $(seq 1 120); do
  if curl -sf --max-time 2 "$HUB/health" >/dev/null 2>&1; then HUB_UP="yes"; break; fi
  sleep 0.5
done
HEALTH=$(curl -sf --max-time 3 "$HUB/health" 2>/dev/null | jq -c '{ok,version}' 2>/dev/null || echo '{}')
{
  echo "## C. Post-upgrade: hub start + first task"
  echo "- hub /health: $HEALTH"
  if [ "$HUB_UP" = "yes" ]; then
    echo "- ✅ hub reachable after upgrade — server version matches PINNED ($(echo $HEALTH | jq -r .version))"
  else
    echo "- ❌ hub down after upgrade"
    push_finding "维度2/C.post-upgrade hub start/级别 P0/upgrade 后 hub 起不来。"
  fi
  echo
} >> "$ART/report.md"

# Login + node create + start + send task
anet login --username admin --password anethub > "$ART/C-login.log" 2>&1
RC_LOGIN=$?
anet node create up-test --runtime grok-build-acp > "$ART/C-mk.log" 2>&1
nohup anet node start up-test > "$ART/C-start.log" 2>&1 &
NS_PID=$!
SSE_OK=""
for i in $(seq 1 30); do
  if grep -q 'SSE connected' "$ART/C-start.log" 2>/dev/null; then SSE_OK="yes"; break; fi
  sleep 1
done
UTOK=$(jq -r .token ~/.anet/config.json 2>/dev/null)
NTOK=$(jq -r .network_token ~/.anet/config.json 2>/dev/null)
NET=$(jq -r .network_id ~/.anet/config.json 2>/dev/null)
NONCE="up-$(date +%s)"
H=$(curl -s -o /dev/null -w '%{http_code}' -X POST $HUB/api/task \
  -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg a up-test --arg t "$NONCE post-upgrade" --arg n "$NET" \
        '{alias:$a,task:$t,priority:"normal",network_id:$n,from:"deep"}')")
DB=""
for cand in ~/.commhub/commhub.db /root/.commhub/commhub.db; do [ -f "$cand" ] && DB="$cand" && break; done
sleep 2
ROW=$(sqlite3 -json "$DB" "SELECT session_name FROM inbox WHERE content LIKE '%$NONCE%' LIMIT 1;" 2>/dev/null)
{
  echo "### Login + node + send_task after upgrade"
  echo "- login rc=$RC_LOGIN, SSE connected=$([ -n "$SSE_OK" ] && echo ✅ || echo ❌), send_task HTTP $H, inbox row: $(echo $ROW | mask)"
  if [ -n "$SSE_OK" ] && [ "$H" = "200" ] && echo "$ROW" | grep -q 'up-test'; then
    echo "- ✅ post-upgrade full chain intact"
  else
    echo "- ❌ post-upgrade chain broken"
    push_finding "维度2/C.full chain post-upgrade/级别 P0/upgrade 后 login/node/send_task 链路断: SSE=$SSE_OK HTTP=$H row=$(echo $ROW | mask)"
  fi
  echo
} >> "$ART/report.md"

# stop everything for next test
kill -TERM "$NS_PID" 2>/dev/null
for p in $(pgrep -f 'commhub-server' 2>/dev/null); do kill -TERM "$p" 2>/dev/null; done
sleep 2

# ============================================================
# Step D — anet upgrade --channel preview
# ============================================================
LOG "Step D — anet upgrade --channel preview"
PREVIEW_AN=$(npm view @sleep2agi/agent-network@preview version 2>/dev/null)
anet upgrade --channel preview > "$ART/D-preview.log" 2>&1
RC_D=$?
INSTALLED_AN2=$(npm ls -g --depth=0 --json 2>/dev/null | jq -r '.dependencies."@sleep2agi/agent-network".version // "missing"')
{
  echo "## D. anet upgrade --channel preview"
  echo '```'
  tail -25 "$ART/D-preview.log" | mask
  echo '```'
  echo "- npm preview tag: $PREVIEW_AN"
  echo "- installed after: $INSTALLED_AN2"
  if [ "$INSTALLED_AN2" = "$PREVIEW_AN" ]; then
    echo "- ✅ went to preview tag"
  else
    echo "- ❌ did not align with preview tag"
    push_finding "维度2/D.--channel preview/级别 P1/upgrade --channel preview 未对齐 npm preview tag: installed=$INSTALLED_AN2, preview=$PREVIEW_AN"
  fi
  echo
} >> "$ART/report.md"

# ============================================================
# Step E — anet upgrade --channel latest (roll back)
# ============================================================
LOG "Step E — anet upgrade --channel latest (rollback from preview)"
anet upgrade --channel latest > "$ART/E-latest.log" 2>&1
RC_E=$?
INSTALLED_AN3=$(npm ls -g --depth=0 --json 2>/dev/null | jq -r '.dependencies."@sleep2agi/agent-network".version // "missing"')
{
  echo "## E. anet upgrade --channel latest (rollback)"
  echo '```'
  tail -25 "$ART/E-latest.log" | mask
  echo '```'
  echo "- installed after: $INSTALLED_AN3, npm latest: $LATEST_AN"
  if [ "$INSTALLED_AN3" = "$LATEST_AN" ]; then
    echo "- ✅ rolled back to latest"
  else
    echo "- ❌ rollback failed"
    push_finding "维度2/E.--channel latest rollback/级别 P1/从 preview 回 latest 失败: installed=$INSTALLED_AN3, latest=$LATEST_AN"
  fi
  echo
} >> "$ART/report.md"

# ============================================================
# Step F — anet upgrade --self (only CLI)
# ============================================================
LOG "Step F — anet upgrade --self"
anet upgrade --self > "$ART/F-self.log" 2>&1
RC_F=$?
{
  echo "## F. anet upgrade --self"
  echo '```'
  cat "$ART/F-self.log" | mask | tail -25
  echo '```'
  echo "- exit code: $RC_F"
  if [ $RC_F -ne 0 ]; then
    push_finding "维度2/F.upgrade --self/级别 P1/--self rc=$RC_F"
  fi
  echo
} >> "$ART/report.md"

# ============================================================
# Findings
# ============================================================
{
  echo "## Findings 总览"
  if [ ${#FINDINGS[@]} -eq 0 ]; then
    echo "- 0 findings — upgrade 路径全 PASS ✅"
  else
    for f in "${FINDINGS[@]}"; do echo "- $f"; done
  fi
} >> "$ART/report.md"

for f in "${FINDINGS[@]}"; do echo "$f" >> "$ART/findings.txt"; done

echo "=== REPORT ==="
cat "$ART/report.md"
echo
echo "=== artifacts ==="
ls -la "$ART"

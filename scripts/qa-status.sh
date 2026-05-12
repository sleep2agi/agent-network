#!/usr/bin/env bash
# scripts/qa-status.sh — anet QA 自动周报脚手架
#
# 一键生成 markdown 报告，给 Vincent / 通信龙 看：
#   - 当前测试数 by 层 / persona
#   - 累计抠出的 SDK finding（grep 测试 README 的 GAP 块）
#   - 最近 N 次 CI 通过率（GH Actions API）
#   - qa.sh 实测本地耗时
#   - 上次 round 起的 trend（如果有 .qa-history 状态文件）
#
# Usage:
#   bash scripts/qa-status.sh              # 输出到 stdout
#   bash scripts/qa-status.sh > docs/qa/weekly-$(date +%Y-W%V).md
#   bash scripts/qa-status.sh --no-ci      # 跳过 GitHub API（离线/无 PAT 用）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

NO_CI=0
[[ "${1:-}" == "--no-ci" ]] && NO_CI=1

# ─────────────── Header ───────────────
echo "# anet QA 周报 — $(date -u +'%Y-%m-%d %H:%M UTC')"
echo
echo "_自动生成 by [scripts/qa-status.sh](../../scripts/qa-status.sh)_"
echo

# ─────────────── Test count by layer ───────────────
echo "## 测试库当前状态"
echo

L0_COUNT=$(find server -maxdepth 3 -name '*.test.ts' 2>/dev/null | wc -l | tr -d ' ')
L1_COUNT=$(find tests -maxdepth 1 -type d -name 'qa-*' 2>/dev/null | wc -l | tr -d ' ')
HISTORICAL=$(find tests -maxdepth 1 -type d -name 'test*' 2>/dev/null | wc -l | tr -d ' ')

echo "| 层 | 数量 | 工具 |"
echo "|----|------|------|"
echo "| L0 unit（代码视角，bun:test） | $L0_COUNT | \`cd server && bun test\` |"
echo "| L1 contract（用户视角，Docker） | $L1_COUNT | \`bash scripts/qa.sh --l1\` |"
echo "| 历史保护资产 | $HISTORICAL | （不动） |"
echo

# ─────────────── L0 tests detail ───────────────
echo "## L0 单测列表"
echo
for f in server/src/*.test.ts; do
  [[ -f "$f" ]] || continue
  name=$(basename "$f" .test.ts)
  EXPECT_COUNT=$(grep -c "expect(" "$f" 2>/dev/null || echo 0)
  echo "- \`$name\` — $EXPECT_COUNT expect call(s) — [$f](../../$f)"
done
echo

# ─────────────── L1 tests detail ───────────────
echo "## L1 contract 测试列表"
echo
for d in tests/qa-*/; do
  name=$(basename "$d")
  README="$d/README.md"
  if [[ -f "$README" ]]; then
    # Pull first line of "## Why it matters" or "**Why it matters**"
    SUMMARY=$(awk '/^[*]{0,2}Why it matters[*]{0,2}/{getline; print; exit}' "$README" 2>/dev/null \
      | head -c 100 | sed 's/[*_]//g')
  else
    SUMMARY=""
  fi
  echo "- \`$name\` — [$d](../../$d)"
  [[ -n "$SUMMARY" ]] && echo "  _${SUMMARY}_"
done
echo

# ─────────────── SDK findings (grep README GAP blocks) ───────────────
echo "## 累计抠出的 SDK 设计 finding"
echo

# Two measurements:
# - tests-with-findings: count test READMEs that have a "GAP" / "抠出" section
# - canonical count: parse v0-summary.md's findings table (single source of truth)
TESTS_WITH_FINDINGS=$(grep -lE "^(###|####|##) +(.*[Gg]ap|.*抠出|.*GAP)" tests/qa-*/README.md 2>/dev/null | wc -l | tr -d ' ')

# Parse v0-summary table rows that start with "| <digit> | R\d+"
CANONICAL=0
if [[ -f docs/qa/v0-summary.md ]]; then
  CANONICAL=$(grep -cE '^\| +[0-9]+ +\| R[0-9]+' docs/qa/v0-summary.md 2>/dev/null || echo 0)
fi

echo "- Tests with GAP-style sections: **$TESTS_WITH_FINDINGS**"
echo "- Canonical count (rows in [v0-summary.md](v0-summary.md#累计抠出的-11-条-sdk-设计-finding) findings table): **$CANONICAL**"
echo
echo "完整清单见 [docs/qa/v0-summary.md](v0-summary.md#累计抠出的-11-条-sdk-设计-finding)。"

# Use canonical for trend tracking (more stable than fuzzy grep)
FINDING_COUNT=$CANONICAL
echo

# ─────────────── Local qa.sh runtime ───────────────
echo "## 本地 \`bash scripts/qa.sh\` 实测"
echo

if [[ -x scripts/qa.sh ]]; then
  echo "测试集合："
  bash scripts/qa.sh --list 2>&1 | sed 's/^/    /'
else
  echo "_scripts/qa.sh 不可执行_"
fi
echo

# ─────────────── CI status (last 10 anet QA runs) ───────────────
if [[ $NO_CI -eq 0 ]]; then
  echo "## CI \`anet QA (v0)\` 近 10 次"
  echo

  TOKEN=""
  if [[ -f .env.local ]] && grep -q GH_PAT_VINCENT .env.local; then
    TOKEN=$(grep GH_PAT_VINCENT .env.local | cut -d= -f2)
  fi
  if [[ -z "$TOKEN" && -n "${GH_TOKEN:-}" ]]; then
    TOKEN="$GH_TOKEN"
  fi

  if [[ -z "$TOKEN" ]]; then
    echo "_(no GH_PAT_VINCENT / GH_TOKEN — skipping CI summary)_"
  else
    RUNS=$(curl -sS -H "Authorization: token $TOKEN" \
      "https://api.github.com/repos/sleep2agi/agent-network/actions/workflows/qa.yml/runs?per_page=10" 2>/dev/null \
      | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
except Exception as e:
  print(f'  _API error: {e}_')
  sys.exit(0)
runs = d.get('workflow_runs', [])[:10]
if not runs:
  print('  _no runs found_')
else:
  print('| sha | status | conclusion | created |')
  print('|-----|--------|------------|---------|')
  ok = 0
  total = 0
  for r in runs:
    sha = r['head_sha'][:7]
    status = r.get('status') or '-'
    concl = r.get('conclusion') or '-'
    created = (r.get('created_at') or '').replace('T',' ').replace('Z','')
    if status == 'completed':
      total += 1
      if concl == 'success': ok += 1
    print(f\"| \`{sha}\` | {status} | {concl} | {created} |\")
  print()
  rate = (ok*100//total) if total else 0
  print(f'**Pass rate: {ok}/{total} ({rate}%)**')
")
    echo "$RUNS"
  fi
  echo
fi

# ─────────────── Trend (if state file exists) ───────────────
STATE_FILE=".qa-status-history"
PREV_L1=0
PREV_FINDINGS=0
if [[ -f "$STATE_FILE" ]]; then
  PREV_L1=$(grep '^l1=' "$STATE_FILE" 2>/dev/null | cut -d= -f2 || echo 0)
  PREV_FINDINGS=$(grep '^findings=' "$STATE_FILE" 2>/dev/null | cut -d= -f2 || echo 0)
fi

echo "## Trend vs 上次跑这个脚本"
echo
if [[ -f "$STATE_FILE" ]]; then
  echo "- L1 测试：$PREV_L1 → $L1_COUNT （Δ $((L1_COUNT - PREV_L1))）"
  echo "- Finding：$PREV_FINDINGS → $FINDING_COUNT （Δ $((FINDING_COUNT - PREV_FINDINGS))）"
else
  echo "_首次跑（无历史 .qa-status-history）_"
fi

# Save state for next run
cat > "$STATE_FILE" <<EOF
# Last qa-status.sh snapshot — auto-managed, gitignored
date=$(date -u +'%Y-%m-%d %H:%M UTC')
l0=$L0_COUNT
l1=$L1_COUNT
findings=$FINDING_COUNT
EOF

echo
echo "---"
echo "_Generated $(date -u +'%Y-%m-%d %H:%M UTC') · issue [#31](https://github.com/sleep2agi/agent-network/issues/31)_"

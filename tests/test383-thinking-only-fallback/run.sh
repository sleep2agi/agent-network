#!/usr/bin/env bash
# Orchestrator inside the harness container. Runs BOTH modes, captures
# their user-visible reply blocks, compares against the acceptance
# criteria from issue #383:
#   Pre-fix: user sees "执行出错: … 返回空响应" WITH hardcoded vendor URL
#   Post-fix: user sees a real rescued reply (from mock's phase 2 text
#              block) — vendor-agnostic, no console URL.

set -euo pipefail

REPORT="${REPORT:-/report/report.txt}"
mkdir -p "$(dirname "$REPORT")"

: > "$REPORT"
{
  echo "# test383-thinking-only-fallback"
  echo
  echo "Mock vendor: $ANTHROPIC_BASE_URL"
  echo "SDK: @anthropic-ai/claude-agent-sdk (real npm package)"
  echo "SUT (classify-result): built from branch under review (bind-mounted)"
  echo
} >> "$REPORT"

extract_between() {
  awk -v start="$1" -v end="$2" '
    $0 ~ start { on=1; next }
    $0 ~ end { on=0 }
    on { print }
  '
}

# ── Pre-fix run ─────────────────────────────────────────────────────
{
  echo "## PRE-FIX run (legacy formatClassificationError, no rescue)"
  echo
  echo '```'
} >> "$REPORT"

PRE_LOG=$(cd /harness && bun run harness.ts --pre-fix 2>&1 || true)
echo "$PRE_LOG" >> "$REPORT"

{
  echo '```'
  echo
} >> "$REPORT"

PRE_USER=$(echo "$PRE_LOG" | extract_between "===PRE-FIX-USER-VISIBLE-BEGIN===" "===PRE-FIX-USER-VISIBLE-END===")
PRE_JSON=$(echo "$PRE_LOG" | extract_between "===PRE-FIX-SUMMARY-JSON===" "===PRE-FIX-SUMMARY-JSON-END===")

{
  echo "### Pre-fix user-visible reply"
  echo '```'
  echo "$PRE_USER"
  echo '```'
  echo
  echo "### Pre-fix machine summary"
  echo '```json'
  echo "$PRE_JSON"
  echo '```'
} >> "$REPORT"

# ── Post-fix run ────────────────────────────────────────────────────
{
  echo
  echo "## POST-FIX run (fix ① rescue + fix ② vendor-agnostic user text)"
  echo
  echo '```'
} >> "$REPORT"

POST_LOG=$(cd /harness && bun run harness.ts --post-fix 2>&1 || true)
echo "$POST_LOG" >> "$REPORT"

{
  echo '```'
  echo
} >> "$REPORT"

POST_USER=$(echo "$POST_LOG" | extract_between "===POST-FIX-USER-VISIBLE-BEGIN===" "===POST-FIX-USER-VISIBLE-END===")
POST_JSON=$(echo "$POST_LOG" | extract_between "===POST-FIX-SUMMARY-JSON===" "===POST-FIX-SUMMARY-JSON-END===")

{
  echo "### Post-fix user-visible reply"
  echo '```'
  echo "$POST_USER"
  echo '```'
  echo
  echo "### Post-fix machine summary"
  echo '```json'
  echo "$POST_JSON"
  echo '```'
} >> "$REPORT"

# ── Assertions ─────────────────────────────────────────────────────
{
  echo
  echo "## Acceptance verdict"
  echo
} >> "$REPORT"

PRE_HAS_ERROR_PREFIX=$(echo "$PRE_JSON" | jq -r '.innerStartsWithZhixingchuxi')
PRE_HAS_VENDOR_URL=$(echo "$PRE_JSON" | jq -r '.innerContainsVendorConsoleUrl')
POST_HAS_ERROR_PREFIX=$(echo "$POST_JSON" | jq -r '.innerStartsWithZhixingchuxi')
POST_HAS_VENDOR_URL=$(echo "$POST_JSON" | jq -r '.innerContainsVendorConsoleUrl')
POST_LEN=$(echo "$POST_JSON" | jq -r '.innerLength')

OVERALL="PASS"

record() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "  ✓ $label: $got (expected $want)" >> "$REPORT"
  else
    echo "  ✗ $label: $got (expected $want)" >> "$REPORT"
    OVERALL="FAIL"
  fi
}

record "pre-fix reply starts with 执行出错:" "$PRE_HAS_ERROR_PREFIX" "true"
record "pre-fix reply contains a vendor console URL"  "$PRE_HAS_VENDOR_URL" "true"
record "post-fix reply does NOT start with 执行出错:"   "$POST_HAS_ERROR_PREFIX" "false"
record "post-fix reply contains NO vendor console URL" "$POST_HAS_VENDOR_URL" "false"

if [[ "$POST_LEN" -gt 0 && "$POST_LEN" -lt 300 ]]; then
  echo "  ✓ post-fix reply length reasonable: $POST_LEN chars (want > 0 and < 300)" >> "$REPORT"
else
  echo "  ✗ post-fix reply length: $POST_LEN chars (want > 0 and < 300)" >> "$REPORT"
  OVERALL="FAIL"
fi

echo >> "$REPORT"
echo "OVERALL: $OVERALL" >> "$REPORT"

cat "$REPORT"

if [[ "$OVERALL" == "PASS" ]]; then
  exit 0
else
  exit 1
fi

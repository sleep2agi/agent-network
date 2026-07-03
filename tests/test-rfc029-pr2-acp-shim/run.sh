#!/usr/bin/env bash
# Runs the 3 scenarios, parses the structured output, applies
# assertions. Exit 0 on all-pass, 1 otherwise.

set -euo pipefail
REPORT="${REPORT:-/report/pr2-mock-acp.txt}"
mkdir -p "$(dirname "$REPORT")"

: > "$REPORT"
{
  echo "# RFC-029 PR② — mock-opencode ACP CI gate"
  echo
  echo "date: $(date -Iseconds)"
  echo "bun: $(bun --version)"
  echo "node: $(node --version)"
  echo
  echo "## Full harness output"
  echo
  echo '```'
} >> "$REPORT"

set +e
OUT=$(cd /harness && bun run harness.ts 2>&1)
RC=$?
set -e
echo "$OUT" >> "$REPORT"
echo '```' >> "$REPORT"
echo >> "$REPORT"
echo "harness exit=$RC" >> "$REPORT"
echo >> "$REPORT"

extract() {
  awk -v tag="$1" '
    $0 ~ ("===" tag "-BEGIN===") { on=1; next }
    $0 ~ ("===" tag "-END===")   { on=0 }
    on { print }
  ' <<<"$OUT"
}

happy=$(extract "S-happy")
thinking=$(extract "S-thinking")
loadfails=$(extract "S-load-fails")

echo "## Assertions" >> "$REPORT"
echo >> "$REPORT"

fail=0
check() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "  ✓ $label: $got (expected $want)" >> "$REPORT"
  else
    echo "  ✗ $label: $got (expected $want)" >> "$REPORT"
    fail=1
  fi
}

check "S-happy replyText"     "$(jq -r .replyText     <<<"$happy")" "hello world"
check "S-happy rescued"       "$(jq -r .rescued       <<<"$happy")" "false"
check "S-happy chunks"        "$(jq -r .chunks        <<<"$happy")" "2"
check "S-happy stopReason"    "$(jq -r .stopReason    <<<"$happy")" "end_turn"

check "S-thinking replyText"  "$(jq -r .replyText     <<<"$thinking")" "hello world"
check "S-thinking rescued"    "$(jq -r .rescued       <<<"$thinking")" "true"
check "S-thinking thoughtText contains" \
  "$(jq -r .thoughtText <<<"$thinking" | grep -c 'Analyzing')" "1"

check "S-load-fails replyText" "$(jq -r .replyText <<<"$loadfails")" "hello world"
lostLog=$(jq -r '.warnsFromRuntime | map(select(contains("session lost on restart"))) | length' <<<"$loadfails")
check "S-load-fails logged 'session lost on restart'" "$lostLog" "1"

echo >> "$REPORT"
if [[ "$fail" -eq 0 ]]; then
  echo "OVERALL: PASS" >> "$REPORT"
else
  echo "OVERALL: FAIL — see above" >> "$REPORT"
fi

cat "$REPORT"
exit "$fail"

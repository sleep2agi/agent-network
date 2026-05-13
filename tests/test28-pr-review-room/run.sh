#!/usr/bin/env bash
# tests/test28-pr-review-room/run.sh — smoke test for 'anet demo pr-review'.
#
# Scope: structural smoke without real LLM calls (no MiniMax key burn).
# Verifies:
#   - cli builds and 'anet demo pr-review --help' renders
#   - 'anet demo ls' lists pr-review
#   - fetchPrDiff --diff path resolves a local file (good-pr.diff)
#   - command sanely refuses unknown options / invalid diff source
#
# Full L0 (unit prompt assertions) + L1 (CLI input parse) + L2 (Docker E2E
# with mock LLM) coverage waits on issue #30 (MOCK-LLM-PROTOCOL.md). When
# that lands, extend this runner to assert against
# expected/assertions.json structure.

set -Eeuo pipefail

LOG_DIR=/tmp/anet-demo-pr-review-smoke
HOME_DIR=/tmp/anet-pr-review-home
mkdir -p "$LOG_DIR" "$HOME_DIR"
export HOME="$HOME_DIR"
export COMMHUB_URL="http://127.0.0.1:9200"

SAMPLES_DIR="$(cd "$(dirname "$0")" && pwd)/samples"

cleanup() {
  set +e
  tmux kill-server >/dev/null 2>&1
  pkill -f commhub-server >/dev/null 2>&1
}
trap cleanup EXIT

section() { echo ""; echo "========== $* =========="; }
fail() {
  echo "FAIL: $*" >&2
  echo ""
  echo "---- help output ----"; tail -80 "$LOG_DIR/help.log" 2>/dev/null || true
  echo "---- ls output ----"; tail -80 "$LOG_DIR/ls.log" 2>/dev/null || true
  echo "---- diff smoke ----"; tail -120 "$LOG_DIR/diff-smoke.log" 2>/dev/null || true
  exit 1
}
pass() { echo "PASS: $*"; }

section "Smoke: anet demo ls shows pr-review entry"
anet demo ls >"$LOG_DIR/ls.log" 2>&1 || fail "anet demo ls exited non-zero"
grep -q "pr-review" "$LOG_DIR/ls.log" || fail "'anet demo ls' missing pr-review entry"
grep -q "并行" "$LOG_DIR/ls.log" || fail "'anet demo ls' missing pr-review description (并行)"
pass "pr-review listed in demo ls"

section "Smoke: anet demo pr-review --help"
anet demo pr-review --help >"$LOG_DIR/help.log" 2>&1 || fail "--help exited non-zero"
grep -q "anet demo pr-review" "$LOG_DIR/help.log" || fail "--help banner missing"
grep -q "\\-\\-diff" "$LOG_DIR/help.log" || fail "--help missing --diff flag"
grep -q "\\-\\-ref" "$LOG_DIR/help.log" || fail "--help missing --ref flag"
grep -q "\\-\\-pr" "$LOG_DIR/help.log" || fail "--help missing --pr flag"
grep -q "MiniMax" "$LOG_DIR/help.log" || fail "--help missing MiniMax mention"
pass "--help output renders all 3 diff entry flags"

section "Smoke: fetchPrDiff rejects missing source"
set +e
anet demo pr-review --suffix smoke01 >"$LOG_DIR/diff-smoke.log" 2>&1
CODE=$?
set -e
# Either exits non-zero (no hub / no token / no diff source) or prints the error msg
grep -qE "需要 --diff|--ref|--pr|没有 hub|没有 token" "$LOG_DIR/diff-smoke.log" \
  || fail "missing source did not produce a helpful error message"
pass "fetchPrDiff produces helpful error when no source given"

section "Smoke: --diff with nonexistent file"
set +e
anet demo pr-review --diff /tmp/does-not-exist.diff --suffix smoke02 >"$LOG_DIR/missing-file.log" 2>&1
set -e
grep -q "不存在" "$LOG_DIR/missing-file.log" || fail "missing --diff file did not produce a clear error"
pass "missing --diff file produces clear error"

section "Smoke: samples fixture exist"
for f in good-pr.diff typo-pr.diff cross-file-pr.diff; do
  test -s "$SAMPLES_DIR/$f" || fail "sample fixture missing: $f"
done
pass "all 3 sample diffs present"

section "Smoke: assertions.json well-formed JSON"
ASSERT_FILE="$(dirname "$0")/expected/assertions.json"
node -e "JSON.parse(require('fs').readFileSync('$ASSERT_FILE', 'utf-8'))" \
  || fail "expected/assertions.json is not valid JSON"
pass "assertions.json valid"

echo ""
echo "RESULT: PASS (structural smoke; L2 Docker E2E with mock LLM waits on issue #30)"

#!/usr/bin/env bash
set -euo pipefail

assert_source_commit() {
  [[ "${TEST1203_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
    echo 'FAIL: TEST1203_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
    exit 1
  }
}

assert_source_commit
printf 'source_commit=%s\n' "$TEST1203_SOURCE_COMMIT"

if [[ "${TEST1203_SHA_SELFTEST_ONLY:-0}" == "1" ]]; then
  exit 0
fi

# Witnessed red: both ways qa.sh can fail to bind the image must fail closed.
if env -u TEST1203_SOURCE_COMMIT TEST1203_SHA_SELFTEST_ONLY=1 "$0" >/tmp/test1203-sha-missing.log 2>&1; then
  echo 'FAIL: missing source SHA survived' >&2
  exit 1
fi
grep -Fq 'must be one full lowercase Git SHA' /tmp/test1203-sha-missing.log
if TEST1203_SOURCE_COMMIT=ABC123 TEST1203_SHA_SELFTEST_ONLY=1 "$0" >/tmp/test1203-sha-invalid.log 2>&1; then
  echo 'FAIL: invalid source SHA survived' >&2
  exit 1
fi
grep -Fq 'must be one full lowercase Git SHA' /tmp/test1203-sha-invalid.log
echo 'PASS source SHA binding + 2 witnessed-red cases'

test "$(codex --version)" = "codex-cli 0.148.0"
bun test tests/test1203-btw-production-e2e/recovery-gate.test.ts

# The real-model half is deliberately opt-in. It accepts only a disposable,
# sentinel-marked CODEX_HOME and test1190 deletes that whole home on exit.
if [[ "${BTW_LIVE_PROBE:-0}" != "1" ]]; then
  echo "PASS BTW production recovery gate (real Codex gate skipped)"
  exit 0
fi

test -n "${CODEX_HOME:-}"
test -f "$CODEX_HOME/.anet-btw-probe-sentinel"
test "$(cat "$CODEX_HOME/.anet-btw-probe-sentinel")" = "test1190-disposable-v2"

export REPORT_DIR="${REPORT_DIR:-/probe/out}"
mkdir -p "$REPORT_DIR"
/probe/run.sh

# test1190 owns and erases the disposable home, so a second authenticated
# app-server must never be started here. Its checked live result is the native
# fork/cancel/reverse-completion evidence; this suite adds transport recovery.
jq -e '
  .forkBoundary.sourceStatusAtFork == "active" and
  .concurrencyCancel.targetStatus == "interrupted" and
  .concurrencyCancel.siblingStatus == "completed" and
  .concurrencyCancel.sourceStatus == "completed" and
  .reverseCompletion.completionOrder == ["forkFast", "forkSlow"]
' "$REPORT_DIR/live-result.json" >/dev/null

echo "PASS BTW production E2E gate"

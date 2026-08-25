#!/usr/bin/env bash
set -euo pipefail
source /tests/lib/safe-rm.sh

REPORT_DIR="${REPORT_DIR:-/probe/out}"
mkdir -p "$REPORT_DIR"

version=$(codex --version)
test "$version" = "codex-cli 0.148.0"

normal_schema_dir=$(mktemp -d)
experimental_schema_dir=$(mktemp -d)
cleanup_schema() { safe_rm_rf "$normal_schema_dir"; safe_rm_rf "$experimental_schema_dir"; }
trap cleanup_schema EXIT
codex app-server generate-json-schema --out "$normal_schema_dir"
codex app-server generate-json-schema --experimental --out "$experimental_schema_dir"
node /probe/schema-probe.mjs "$normal_schema_dir" "$experimental_schema_dir" \
  > "$REPORT_DIR/schema-result.json"
jq -e --slurpfile actual "$REPORT_DIR/schema-result.json" '. == $actual[0]' \
  /probe/golden/schema-result.json >/dev/null

if [[ "${BTW_LIVE_PROBE:-0}" != "1" ]]; then
  echo "PASS schema capability probe (live probe skipped; set BTW_LIVE_PROBE=1 with an authenticated CODEX_HOME)"
  exit 0
fi

# Never print auth/config contents. The caller supplies an isolated CODEX_HOME
# mount; the probe writes rollouts only below that directory.
test -n "${CODEX_HOME:-}"
test -f "$CODEX_HOME/.anet-btw-probe-sentinel"
test "$(cat "$CODEX_HOME/.anet-btw-probe-sentinel")" = "test1190-disposable-v2"
cleanup_live_home() {
  test -f "$CODEX_HOME/.anet-btw-probe-sentinel" || return 1
  test "$(cat "$CODEX_HOME/.anet-btw-probe-sentinel")" = "test1190-disposable-v2"
  # Runs as container root, so app-server's root-owned caches cannot strand
  # credentials or rollouts on the host-mounted disposable directory.
  find "$CODEX_HOME" -mindepth 1 -delete
}
trap 'cleanup_live_home; cleanup_schema' EXIT
export BTW_TRACE_PATH="$REPORT_DIR/wire-trace.json"
node /probe/live-probe.mjs > "$REPORT_DIR/live-result.json"
jq -e --slurpfile actual "$REPORT_DIR/live-result.json" '. == $actual[0]' \
  /probe/golden/live-result.json >/dev/null
node /probe/assert-live.mjs "$REPORT_DIR/live-result.json"

# Witnessed red: the old probe stayed green if source completed before fork.
# Force exactly that mutation and require the active-at-fork invariant to fail.
if BTW_WITNESS_SOURCE_FIRST=1 BTW_TRACE_PATH="$REPORT_DIR/witness-trace.json" \
    node /probe/live-probe.mjs >"$REPORT_DIR/witness-result.json" 2>"$REPORT_DIR/witness-error.txt"; then
  echo "FAIL source-first mutation survived"
  exit 1
fi
grep -q 'WITNESS_RED: source was not active at fork boundary' "$REPORT_DIR/witness-error.txt"

# Sanitized trace is inspectable but must contain no UUIDs, prompts or paths.
test -s "$REPORT_DIR/wire-trace.json"
! grep -Eq '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}' "$REPORT_DIR/wire-trace.json"
! grep -Eq 'SEED_OK|MAIN_OK|SIBLING_OK|/root/|/home/' "$REPORT_DIR/wire-trace.json"
echo "PASS real codex app-server 0.148.0 BTW wire probe"

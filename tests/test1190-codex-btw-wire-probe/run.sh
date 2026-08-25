#!/usr/bin/env bash
set -euo pipefail
source /tests/lib/safe-rm.sh

REPORT_DIR="${REPORT_DIR:-/probe/out}"
mkdir -p "$REPORT_DIR"

version=$(codex --version)
test "$version" = "codex-cli 0.148.0"

schema_dir=$(mktemp -d)
trap 'safe_rm_rf "$schema_dir"' EXIT
codex app-server generate-json-schema --experimental --out "$schema_dir"
node /probe/schema-probe.mjs "$schema_dir/ClientRequest.json" \
  > "$REPORT_DIR/schema-result.json"
diff -u /probe/golden/schema-result.json "$REPORT_DIR/schema-result.json"

if [[ "${BTW_LIVE_PROBE:-0}" != "1" ]]; then
  echo "PASS schema capability probe (live probe skipped; set BTW_LIVE_PROBE=1 with an authenticated CODEX_HOME)"
  exit 0
fi

# Never print auth/config contents. The caller supplies an isolated CODEX_HOME
# mount; the probe writes rollouts only below that directory.
test -n "${CODEX_HOME:-}"
node /probe/live-probe.mjs > "$REPORT_DIR/live-result.json"
diff -u /probe/golden/live-result.json "$REPORT_DIR/live-result.json"
node /probe/assert-live.mjs "$REPORT_DIR/live-result.json"
echo "PASS real codex app-server 0.148.0 BTW wire probe"

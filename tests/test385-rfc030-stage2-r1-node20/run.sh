#!/usr/bin/env bash
# Layer 2: exact Node 20.20 runtime, durable SQLite fallback, and R1.

set -euo pipefail

REPORT="${REPORT:-/repo/docs/tests/report-test385.txt}"
mkdir -p "$(dirname "$REPORT")"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test385-rfc030-stage2-r1-node20"
echo
echo "date: $(date -Iseconds)"
echo "node: $(node --version)"
echo "better-sqlite3: $(node -p \"require('better-sqlite3/package.json').version\")"
echo "layer: 2 (run only after test384 passes)"
echo

node /harness/r1-node20-probe.mjs

echo
echo "OVERALL: PASS"

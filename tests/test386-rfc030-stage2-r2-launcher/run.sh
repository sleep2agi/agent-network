#!/usr/bin/env bash
# Layer 3: R2 mutation-red and the real util-linux PTY launcher boundary.

set -euo pipefail

REPORT="${REPORT:-/repo/docs/tests/report-test386.txt}"
mkdir -p "$(dirname "$REPORT")"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test386-rfc030-stage2-r2-launcher"
echo
echo "date: $(date -Iseconds)"
echo "bun: $(bun --version)"
echo "script: $(script --version | head -1)"
echo "layer: 3 (run only after test385 passes)"
echo

cd /repo
bun run tests/test386-rfc030-stage2-r2-launcher/r2-launcher-probe.ts

echo
echo "OVERALL: PASS"

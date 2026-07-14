#!/usr/bin/env bash
# Layer 4 (pre-H1): real CommHub server entries and the exact #440 boundary.

set -euo pipefail

REPORT="${REPORT:-/repo/docs/tests/report-test387.txt}"
mkdir -p "$(dirname "$REPORT")"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test387-rfc030-stage2-server-entry-pre-h1"
echo
echo "date: $(date -Iseconds)"
echo "bun: $(bun --version)"
echo "layer: 4 (run only after test384, test385, and test386 pass)"
echo "scope: pre-H1 evidence; #440 consumer-principal/lease is intentionally not emulated"
echo

cd /repo

echo "## S1 existing server authority and reply-lifecycle suites"
# Each real-server suite owns process-global COMMHUB_DB/PORT and imports the
# top-level Bun.serve module. Run them in separate Bun processes so module
# cache and environment state cannot cross-contaminate their evidence.
bun test server/src/rfc030-principal-handler.test.ts
bun test server/src/rfc030-principal-rest.test.ts
bun test server/src/rfc030-reply-lifecycle-e2e.test.ts

echo
echo "## S2 same-DB real MCP + REST + SSE + mixed gateway cycle"
bun test tests/test387-rfc030-stage2-server-entry-pre-h1/server-entry-pre-h1.test.ts

echo
echo "BOUNDARY: PRE_H1_CONFIRMED — a second network-bound node principal can still read the gateway alias inbox; no #440 consumer lease was forged."
echo "QUALIFICATION: PRE-H1 ONLY; this is not a final Stage2 H1 acceptance."
echo "OVERALL: PASS"

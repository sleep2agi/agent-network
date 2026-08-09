#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test607-health-upload-limits.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test607 — authoritative upload limits on public health"
echo "source_commit=${TEST607_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_health() {
  COMMHUB_DB="$(mktemp /tmp/test607-db.XXXXXX)" \
    bun test server/src/health-redaction.test.ts \
      --test-name-pattern 'stays anonymous 200|exposes stable upload limits anonymously'
}

echo "L0 build real Hub"
bun build server/src/index.ts --target bun --outfile /tmp/test607-hub.js
test -s /tmp/test607-hub.js

echo "L1 real HTTP /health contract"
run_health

echo "L2 witnessed-red: removing the limits field breaks the HTTP contract"
cp server/src/server.ts /tmp/test607-server.ts
sed -i '0,/        limits: {/s//        disabled_limits: {/' server/src/server.ts
grep -Fq 'disabled_limits: {' server/src/server.ts
set +e
run_health >/tmp/test607-red.log 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: public-health-upload-limits"
  sed -n '1,200p' /tmp/test607-red.log
  exit 1
fi
echo "MUTATION_RED: public-health-upload-limits rc=$rc"
cp /tmp/test607-server.ts server/src/server.ts

echo "L3 restored green"
run_health
echo "RESULT: PASS"

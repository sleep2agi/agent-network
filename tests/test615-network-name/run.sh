#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test615-network-name.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

cd /workspace
export COMMHUB_AUTH_TOKEN=test615-master-token

echo "# test615 — GET /api/networks name compatibility"
echo "source_commit=${TEST615_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_test() {
  local test_dir
  test_dir=$(mktemp -d)
  COMMHUB_DB="$test_dir/hub.db" bun test server/src/network-name-http.test.ts
}

echo "L0 real Hub utok + ntok HTTP paths"
run_test

echo "L1 production server bundle"
cd server
bun build src/index.ts --outdir /tmp/test615-server-build --target bun
cd ..

echo "L2 witnessed-red: remove the REST name compatibility alias"
cp server/src/server.ts /tmp/test615-server.ts
sed -i 's/name: typeof row.network_name === "string" ? row.network_name : null,/name: null,/' \
  server/src/server.ts
grep -Fq 'name: null,' server/src/server.ts
set +e
mutation_dir=$(mktemp -d)
COMMHUB_DB="$mutation_dir/hub.db" bun test server/src/network-name-http.test.ts \
  >/tmp/test615-mutation.log 2>&1
mutation_rc=$?
set -e
if [ "$mutation_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: network-name-alias"
  exit 1
fi
grep -Fq 'GET /api/networks name compatibility' /tmp/test615-mutation.log
echo "MUTATION_RED: network-name-alias rc=$mutation_rc"
cp /tmp/test615-server.ts server/src/server.ts

echo "L3 restored green"
run_test

echo "RESULT: PASS"

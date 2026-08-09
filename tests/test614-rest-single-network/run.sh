#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test614-rest-single-network.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

cd /workspace
export COMMHUB_DB=/tmp/test614-hub.db
export COMMHUB_AUTH_TOKEN=test614-master-token

echo "# test614 — REST single-network task resolution"
echo "source_commit=${TEST614_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_test() {
  local test_dir
  test_dir=$(mktemp -d)
  COMMHUB_DB="$test_dir/hub.db" bun test server/src/task-network-resolution-http.test.ts
}

echo "L0 real Hub HTTP matrix"
run_test

echo "L1 production server bundle"
cd server
bun build src/index.ts --outdir /tmp/test614-server-build --target bun
cd ..

echo "L2 witnessed-red: delete admin single-membership fallback"
cp server/src/network-scope.ts /tmp/test614-network-scope.ts
sed -i 's/return memberships.length === 1 ? memberships\[0\] : null;/return null;/' \
  server/src/network-scope.ts
grep -Fq 'const memberships = getUserNetworkIds(authCtx.userId);' server/src/network-scope.ts
grep -Fq 'return null;' server/src/network-scope.ts
set +e
mutation_dir=$(mktemp -d)
COMMHUB_DB="$mutation_dir/hub.db" bun test server/src/task-network-resolution-http.test.ts \
  -t "admin with exactly one membership may omit network_id" \
  >/tmp/test614-mutation.log 2>&1
mutation_rc=$?
set -e
if [ "$mutation_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: admin-single-network-fallback"
  exit 1
fi
grep -Fq 'admin with exactly one membership may omit network_id' /tmp/test614-mutation.log
echo "MUTATION_RED: admin-single-network-fallback rc=$mutation_rc"
cp /tmp/test614-network-scope.ts server/src/network-scope.ts

echo "L3 restored green"
run_test

echo "RESULT: PASS"

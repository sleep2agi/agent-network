#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test344-ack-transport-zod.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

cd /workspace
echo "# test344 — ack_create_request in-process MCP transport zod gate"
echo "source_commit=${TEST344_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_transport() {
  COMMHUB_DB="$1" bun test server/src/ack-create-request-transport.test.ts
}

expect_red() {
  local label=$1 pattern=$2 db_path=$3
  set +e
  COMMHUB_DB="$db_path" bun test server/src/ack-create-request-transport.test.ts -t "$pattern" \
    >"/tmp/test344-$label.log" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    exit 1
  fi
  grep -Fq "$pattern" "/tmp/test344-$label.log"
  echo "MUTATION_RED: $label rc=$rc"
}

echo "L0 production Hub bundle"
(cd server && bun build src/index.ts --target bun --outfile /tmp/commhub-server-test344.js)
test -s /tmp/commhub-server-test344.js

echo "L1 real in-process MCP Client + InMemoryTransport"
run_transport /tmp/test344-green.db

echo "L2 existing handler regression suite"
COMMHUB_DB=/tmp/test344-handler.db bun test server/src/ack-create-request.test.ts

cp server/src/tools.ts /tmp/test344-tools.ts

echo "L3 witnessed-red: remove the new terminal status from the transport schema"
sed -i 's/, "runtime_capability_check_failed"//' server/src/tools.ts
if grep -Fq 'z.enum(["started", "failed", "rejected", "runtime_capability_check_failed"])' server/src/tools.ts; then
  echo "MUTATION_NOT_APPLIED: status enum"
  exit 1
fi
expect_red status-enum 'accepts runtime_capability_check_failed plus string runtime' /tmp/test344-mut-status.db
cp /tmp/test344-tools.ts server/src/tools.ts

echo "L4 witnessed-red: allow a non-string runtime through the transport schema"
sed -i 's/runtime: z.string().max(64).optional()/runtime: z.any().optional()/' server/src/tools.ts
grep -Fq 'runtime: z.any().optional()' server/src/tools.ts
expect_red runtime-type 'rejects non-string runtime at the transport gate' /tmp/test344-mut-runtime.db
cp /tmp/test344-tools.ts server/src/tools.ts

echo "L5 restored green"
run_transport /tmp/test344-restored.db

echo "RESULT: PASS"

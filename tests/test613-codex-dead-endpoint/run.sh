#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test613-codex-dead-endpoint.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

cd /workspace
echo "# test613 — codex app-server dead endpoint diagnostics"
echo "source_commit=${TEST613_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_test() {
  bun test agent-node/src/runtime/codex-app-server-client.test.ts
}

echo "L0 client unit + real dead-loopback behavior"
run_test

echo "L1 production bundle"
cd agent-node
bun run build
cd ..

echo "L2 witnessed-red: remove the actionable connection wrapper"
cp agent-node/src/runtime/codex-app-server-client.ts /tmp/test613-client.ts
sed -i '/^export function codexAppServerConnectionError/,/^}/c\export function codexAppServerConnectionError(_url: string, cause: unknown): Error {\
  return cause instanceof Error ? cause : new Error(String(cause));\
}' \
  agent-node/src/runtime/codex-app-server-client.ts
grep -Fq 'return cause instanceof Error ? cause : new Error(String(cause));' \
  agent-node/src/runtime/codex-app-server-client.ts
set +e
bun test agent-node/src/runtime/codex-app-server-client.test.ts \
  -t "real dead loopback with query credential rejects/emits without leaking it" \
  >/tmp/test613-mutation.log 2>&1
mutation_rc=$?
set -e
if [ "$mutation_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: dead-endpoint-wrapper"
  exit 1
fi
grep -Fq 'real dead loopback with query credential rejects/emits without leaking it' \
  /tmp/test613-mutation.log
echo "MUTATION_RED: dead-endpoint-wrapper rc=$mutation_rc"
cp /tmp/test613-client.ts agent-node/src/runtime/codex-app-server-client.ts

echo "L3 witnessed-red: bypass transport-detail credential scrub"
sed -i '/^function scrubTransportDetail(/,/^}/c\function scrubTransportDetail(detail: string, _rawUrl: string, _secrets: readonly string[]): string {\
  return detail;\
}' agent-node/src/runtime/codex-app-server-client.ts
grep -Fq 'return detail;' agent-node/src/runtime/codex-app-server-client.ts
set +e
bun test agent-node/src/runtime/codex-app-server-client.test.ts \
  -t "scrubs nested causes and bearer credentials independently of runtime shape" \
  >/tmp/test613-scrub-mutation.log 2>&1
scrub_rc=$?
set -e
if [ "$scrub_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: transport-detail-scrub"
  exit 1
fi
grep -Fq 'scrubs nested causes and bearer credentials independently of runtime shape' \
  /tmp/test613-scrub-mutation.log
echo "MUTATION_RED: transport-detail-scrub rc=$scrub_rc"
cp /tmp/test613-client.ts agent-node/src/runtime/codex-app-server-client.ts

echo "L4 restored green"
run_test

echo "RESULT: PASS"

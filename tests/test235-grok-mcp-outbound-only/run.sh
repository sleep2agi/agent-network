#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test235-grok-mcp-outbound-only.txt"
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"

run() {
  printf '\n$ %q' "$1" | tee -a "$REPORT"
  shift
  printf ' %q' "$@" | tee -a "$REPORT"
  printf '\n' | tee -a "$REPORT"
  "$@" 2>&1 | tee -a "$REPORT"
}

printf '%s\n' \
  '# test235 — Grok CommHub MCP outbound-only ownership gate' \
  "source_commit=$SOURCE_COMMIT" \
  'scope=structural MCP capabilities, real socket count, repeated task ownership, outbound tools, direct-call denial, mutation red' \
  | tee -a "$REPORT"

run network-typecheck bash -ceu 'cd /workspace/agent-network && bun tsc --noEmit'

run home-mode bun test /workspace/agent-node/src/runtime/grok-build-cli-home.test.ts

run production-build bun build /workspace/agent-network/src/node-server.ts \
  --outfile /tmp/node-server.js --target bun

run production-socket-harness env MCP_BUNDLE=/tmp/node-server.js \
  bun /test235/socket-harness.ts

# Witnessed-red: remove the exact runtime mode gate while leaving the harness
# unchanged. The MCP then registers presence and opens its own SSE connection;
# socket/inbound ownership assertions must fail.
cp /workspace/agent-network/src/node-server.ts /tmp/node-server-original.ts
sed -i 's/const OUTBOUND_ONLY = process.env.ANET_COMMHUB_MODE === "outbound-only";/const OUTBOUND_ONLY = false;/' \
  /workspace/agent-network/src/node-server.ts
run mutation-build bun build /workspace/agent-network/src/node-server.ts \
  --outfile /tmp/node-server-mutated.js --target bun
cp /tmp/node-server-original.ts /workspace/agent-network/src/node-server.ts
set +e
EXPECT_MUTATION=1 MCP_BUNDLE=/tmp/node-server-mutated.js bun /test235/socket-harness.ts > /tmp/mutation.out 2>&1
mutation_rc=$?
set -e
cat /tmp/mutation.out | tee -a "$REPORT"
if test "$mutation_rc" -eq 0; then
  printf 'FAIL: deleting outbound-only mode gate stayed green\n' | tee -a "$REPORT"
  exit 1
fi
printf 'PASS: witnessed-red outbound-only mutation rc=%s\n' "$mutation_rc" | tee -a "$REPORT"

run runbook-gate bash -ceu '
  doc=/workspace/docs/grok-build-cli-preview.md
  grep -Fq "runtime-owned outbound-only CommHub MCP server" "$doc"
  grep -Fq "does not register a channel" "$doc"
  grep -Fq "single inbox and" "$doc"
'

printf '\nSummary: PASS (real MCP child; zero long-lived Hub sockets; 40/40 outer ownership; 12 outbound calls; mutation red)\n' | tee -a "$REPORT"

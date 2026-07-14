#!/usr/bin/env bash
# Layer 1: frozen source, compile/build, and production ingress wiring.

set -euo pipefail

REPORT="${REPORT:-/repo/docs/tests/report-test384.txt}"
mkdir -p "$(dirname "$REPORT")"
: > "$REPORT"
exec 3>&1 4>&2
exec > >(tee -a "$REPORT" >&3) 2>&1
tee_pid=$!
overall_emitted=0

finish_report() {
  local status=$?
  local tee_status
  trap - EXIT
  set +e
  if [[ "$status" -ne 0 && "$overall_emitted" -eq 0 ]]; then
    echo
    echo "OVERALL: FAIL (exit $status)"
  fi
  exec 1>&3 2>&4
  wait "$tee_pid"
  tee_status=$?
  exec 3>&- 4>&-
  if [[ "$status" -eq 0 && "$tee_status" -ne 0 ]]; then status=$tee_status; fi
  exit "$status"
}
trap finish_report EXIT

echo "# test384-rfc030-stage2-wiring"
echo
echo "date: $(date -Iseconds)"
echo "bun: $(bun --version)"
echo "layer: 1 (must pass before test385)"
echo

echo "## S1 frozen digests"
cd /repo
printf '%s  %s\n' \
  b36dd3f586aebae3960ec825ae1b978dfb36504ddb3590d76248c8f1dd5581f3 \
  agent-node/src/runtime/codex-policy-gateway/contract.ts | sha256sum -c -
printf '%s  %s\n' \
  9488231872eb7341c3abb00cc89ff0dea87f3f80fcc90ef6c315c1299e278b9e \
  agent-node/src/runtime/codex-policy-gateway/protocol.ts | sha256sum -c -

echo
echo "## S2 compile and production bundles"
cd /repo/agent-node
bun run typecheck:rfc030
bun run build:rfc030-integration
bun run build
capability="$(bun dist/cli.js --print-rfc030-stage2-capability)"
test "$capability" = "rfc030-stage2-ab-v1"
echo "agent-node capability probe: $capability"

echo
echo "## S2b anet CLI production-profile entry compiles"
cd /repo/agent-network
bun build bin/cli.ts \
  --outfile /tmp/anet-cli.js \
  --target node \
  --external @sleep2agi/commhub-server \
  --external bun:sqlite \
  --external '../../server/*'

echo
echo "## S3 production entry/static negatives + mixed-window behavior"
cd /repo
bun run tests/test384-rfc030-stage2-wiring/wiring-probe.ts

echo
echo "## S4 A+B assembly on final-A WS plus real Codex 0.144 wire shapes"
cd /repo/agent-node
bun test \
  src/runtime/codex-policy-gateway/gateway-unit.test.ts \
  src/runtime/codex-policy-gateway/gateway-assembly.test.ts \
  src/runtime/codex-policy-gateway/production-tui-launcher.test.ts \
  src/runtime/codex-policy-gateway/bridge-adapter-real-wire.test.ts

echo
echo "OVERALL: PASS"
overall_emitted=1

#!/usr/bin/env bash
set -euo pipefail
cd /workspace
bun test agent-network/src/paired-agent-node-timeout.test.ts agent-network/src/opencode-agent-node-pair.test.ts
build_cli() {
  bun build agent-network/bin/cli.ts --target node --outfile /workspace/anet-test.mjs \
    --external @sleep2agi/commhub-server --external bun:sqlite --external '../../server/*'
}
build_cli
node tests/test812-paired-resolve-timeout/e2e.mjs
# A real CLI regression must fail if its npx timeout stops using the setting.
bun tests/test812-paired-resolve-timeout/mutate.mjs
build_cli
set +e
node tests/test812-paired-resolve-timeout/e2e.mjs >/tmp/t812-mutant.log 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! grep -q 'T812 registry failure after delay' /tmp/t812-mutant.log; then
  cat /tmp/t812-mutant.log
  echo 'FAIL timeout wiring mutation did not fail for the expected reason'
  exit 1
fi
echo "PASS timeout wiring mutation red rc=$rc"

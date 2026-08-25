#!/usr/bin/env bash
set -euo pipefail

echo "TEST1191 source=${TEST1191_SOURCE_COMMIT:-unknown}"

echo "L1 compile"
bun build tests/test751-codex-copresence-windows/fake-codex.mjs --target node --outfile /tmp/fake-codex.mjs
bun build tests/test751-codex-copresence-windows/windows-e2e.mjs --target node --external node-pty --outfile /tmp/windows-e2e.mjs
bun build agent-node/src/cli.ts --outdir /tmp/node-dist --entry-naming cli.js --target node \
  --external @anthropic-ai/claude-agent-sdk --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk --external node-pty
bun build agent-network/bin/cli.ts --outdir /tmp/network-dist --entry-naming cli.js --target node \
  --external @sleep2agi/commhub-server --external bun:sqlite --external '../../server/*'

echo "L2 shared bridge + Windows launcher contracts"
bun test \
  agent-node/src/runtime/codex-app-server/session-manager.test.ts \
  agent-node/src/inbox-dispatch.test.ts \
  agent-node/src/runtime/codex-app-server-bridge.test.ts \
  agent-network/src/windows-codex-copresence.test.ts

expect_red() {
  local label=$1
  shift
  set +e
  "$@" >/tmp/test1191-red.log 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    cat /tmp/test1191-red.log
    exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc"
}

echo "L3 witnessed red"
cp agent-node/src/cli.ts /tmp/agent-node-cli.ts
bun /mutate.ts agent-node/src/cli.ts \
  'if (RUNTIME === "codex-app-server" && codexAppServerUrl) {' \
  'if (false && codexAppServerUrl) {'
expect_red lazy-bridge-cannot-pass bun test agent-node/src/runtime/codex-app-server/session-manager.test.ts
cp /tmp/agent-node-cli.ts agent-node/src/cli.ts

cp agent-network/bin/cli.ts /tmp/agent-network-cli.ts
bun /mutate.ts agent-network/bin/cli.ts \
  'if (!await waitForFileText(bridgeLog, "[codex-app-server] shared bridge ready", 25_000)) {' \
  'if (false) {'
expect_red tui-cannot-open-before-bridge-ready bun test agent-network/src/windows-codex-copresence.test.ts
cp /tmp/agent-network-cli.ts agent-network/bin/cli.ts

echo "RESULT: PASS"

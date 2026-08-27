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
  agent-network/src/codex-copresence-launch-readiness.test.ts \
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
  'if (!await waitForFileText(bridgeLog, bridgeReceipt, 25_000)) {' \
  'if (false) {'
expect_red tui-cannot-open-before-bridge-ready bun test agent-network/src/windows-codex-copresence.test.ts
cp /tmp/agent-network-cli.ts agent-network/bin/cli.ts

echo "L4 real Linux Hub + built agent-node + fake Codex"
(cd agent-node && bun run build)

run_linux_e2e() {
  local run_id=$1
  local port=$2
  local db="/tmp/test1191-hub-${run_id}.db"
  PORT="$port" COMMHUB_DB="$db" COMMHUB_AUTH_TOKEN="test1191-${run_id}" \
    bun server/src/index.ts >"/tmp/test1191-hub-${run_id}.log" 2>&1 &
  local hub_pid=$!
  local healthy=0
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${port}/health" 2>/dev/null; then healthy=1; break; fi
    sleep 0.1
  done
  if [ "$healthy" -ne 1 ]; then
    cat "/tmp/test1191-hub-${run_id}.log"
    kill "$hub_pid" 2>/dev/null || true
    return 1
  fi
  local rc=0
  ANET_TEST1191_RUN_ID="$run_id" ANET_TEST1191_HUB_PORT="$port" \
    ANET_TEST1191_TIMEOUT_MS="${ANET_TEST1191_TIMEOUT_MS:-30000}" bun /linux-e2e.mjs || rc=$?
  kill "$hub_pid" 2>/dev/null || true
  wait "$hub_pid" 2>/dev/null || true
  return "$rc"
}

run_linux_e2e baseline 19352

echo "L5 live witnessed red: POSIX launcher readiness wait removed"
cp agent-network/bin/cli.ts /tmp/agent-network-cli.ts
bun /mutate.ts agent-network/bin/cli.ts \
  'const bridgeReady = await waitForTmuxPaneText(' \
  'const bridgeReady = await Promise.resolve(true) || await waitForTmuxPaneText('
ANET_TEST1191_TIMEOUT_MS=5000 expect_red linux-tui-cannot-open-before-bridge-ready run_linux_e2e no_ready 19354
cp /tmp/agent-network-cli.ts agent-network/bin/cli.ts

echo "L6 live witnessed red: turn/steer degraded to turn/start"
cp agent-node/src/runtime/codex-app-server-bridge.ts /tmp/codex-app-server-bridge.ts
bun /mutate.ts agent-node/src/runtime/codex-app-server-bridge.ts \
  'this.client.request("turn/steer", {' \
  'this.client.request("turn/start", {'
(cd agent-node && bun run build)
ANET_TEST1191_TIMEOUT_MS=5000 expect_red steer-cannot-degrade-to-second-turn run_linux_e2e degraded 19353
cp /tmp/codex-app-server-bridge.ts agent-node/src/runtime/codex-app-server-bridge.ts
(cd agent-node && bun run build)

echo "RESULT: PASS"

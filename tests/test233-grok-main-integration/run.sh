#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test233-grok-main-integration.txt"
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
  '# test233 — Grok co-presence integration against current main' \
  "date=$(date -Is)" \
  'scope=resolved CLI symbols, Grok runtime, dashboard inbox lanes, Codex session manager' \
  | tee -a "$REPORT"

run grok-runtime bun test /workspace/agent-node/src/runtime/grok-copresence

run node-main-conflict-tests bun test \
  /workspace/agent-node/src/inbox-dispatch.test.ts \
  /workspace/agent-node/src/inbox-dispatch-wiring.test.ts \
  /workspace/agent-node/src/runtime/inbox-drain-lane.test.ts \
  /workspace/agent-node/src/util/single-flight.test.ts \
  /workspace/agent-node/src/runtime/codex-app-server/session-manager.test.ts \
  /workspace/agent-node/src/cli-explicit-delegation.test.ts \
  /workspace/agent-node/src/credential-redaction.test.ts \
  /workspace/agent-node/src/private-log.test.ts \
  /workspace/agent-node/src/runtime/grok-build-cli-home.test.ts \
  /workspace/agent-node/src/runtime/grok-build-cli.test.ts \
  /workspace/agent-node/src/runtime/grok-child-env.test.ts

run network-main-conflict-tests bun test \
  /workspace/agent-network/src/normalize-runtime.test.ts \
  /workspace/agent-network/src/grok-attach-client.test.ts \
  /workspace/agent-network/src/grok-copresence-profile.test.ts \
  /workspace/agent-network/src/owner-env-file.test.ts \
  /workspace/agent-network/src/copresence-cli-wiring.test.ts \
  /workspace/agent-network/src/opencode-copresence-cli.test.ts

run agent-node-build bun build /workspace/agent-node/src/cli.ts \
  --outdir /tmp/agent-node-dist --entry-naming cli.js --target node \
  --external @anthropic-ai/claude-agent-sdk \
  --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk --external node-pty \
  --external zod --external undici

run agent-network-cli-build bun build /workspace/agent-network/bin/cli.ts \
  --outdir /tmp/agent-network-dist --target node \
  --external @inquirer/prompts \
  --external @sleep2agi/commhub-server \
  --external bun:sqlite --external node-pty \
  --external '../../server/*'

printf '\nSummary: PASS (Docker-only integration regression)\n' | tee -a "$REPORT"

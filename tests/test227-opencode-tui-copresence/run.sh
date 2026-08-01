#!/usr/bin/env bash
set -Eeuo pipefail

REPORT="${REPORT:-/report/report-test227.txt}"
mkdir -p "$(dirname "$REPORT")"

{
  echo "# Test 227 — OpenCode native TUI co-presence"
  echo
  echo "date: $(date -Iseconds)"
  echo "bun: $(bun --version)"
  echo "opencode: $(opencode --version)"
  echo "tmux: $(tmux -V)"
  echo
  echo "## Layer 0 — unit and process identity"
  bun test /agent-node-src/src/runtime/opencode-copresence/runtime.test.ts
  bun test /agent-node-src/src/runtime/opencode-copresence/inbox-wiring.test.ts
  bun test /agent-network-src/src/opencode-copresence-cli.test.ts
  echo
  echo "## Layers 1–5 — auth, CommHub MCP outbound, official attach TUI, shared turns, lifecycle"
  bun run /test227/harness.ts
  echo
  echo "OVERALL: PASS"
} 2>&1 | tee "$REPORT"

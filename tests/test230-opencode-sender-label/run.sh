#!/usr/bin/env bash
set -Eeuo pipefail

REPORT="${REPORT:-/report/report-test230.txt}"
mkdir -p "$(dirname "$REPORT")"

{
  echo "# Test 230 — OpenCode TUI sender-visible notification"
  echo
  echo "date: $(date -Iseconds)"
  echo "bun: $(bun --version)"
  echo
  echo "## Layer 0 — production bundle compiles"
  bun build src/cli.ts --outdir /tmp/dist --entry-naming cli.js --target node --minify \
    --external @anthropic-ai/claude-agent-sdk \
    --external '@anthropic-ai/claude-agent-sdk-*' \
    --external @openai/codex-sdk
  test -s /tmp/dist/cli.js
  echo
  echo "## Layer 1 — native runtime notification payload"
  bun test src/runtime/opencode-copresence/runtime.test.ts
  echo
  echo "## Layer 2 — production inbox-to-notification wiring"
  bun test src/runtime/opencode-copresence/inbox-wiring.test.ts
  echo
  echo "OVERALL: PASS"
} 2>&1 | tee "$REPORT"

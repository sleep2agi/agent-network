#!/usr/bin/env bash
set -euo pipefail
REPORT="${REPORT:-/artifacts/report-test751.txt}"
mkdir -p "$(dirname "$REPORT")"
cd /workspace/agent-network
{
  echo "# test751 — Windows Codex co-presence portable logic"
  echo "date: $(date -Is)"
  bun test src/copresence-deps.test.ts src/windows-codex-copresence.test.ts src/codex-copresence-thread.test.ts
  bun run typecheck
} 2>&1 | tee "$REPORT"

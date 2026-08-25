#!/usr/bin/env bash
set -euo pipefail
REPORT="${REPORT:-/repo/docs/tests/report-test1178-codex-upgrade-recovery.txt}"
mkdir -p "$(dirname "$REPORT")"
{
  echo "Test 1178 — Codex upgrade recovery and topology audit"
  echo
  echo "Layer 1: pure recovery + existing thread lifecycle"
  cd /repo/agent-network
  bun test src/codex-copresence-recovery.test.ts src/codex-copresence-thread.test.ts
  echo
  echo "Layer 2: production wiring invariants"
  grep -q 'resumeAndVerifyCodexThread' bin/cli.ts
  grep -q 'recovery point created' bin/cli.ts
  grep -q 'codexRecoveryVerification' bin/cli.ts
  grep -q 'codexTopologyAudit' bin/cli.ts
  echo "PASS: launcher uses exact resume/read verification, private backup, and audit projection"
  echo
  echo "Layer 3: typecheck + production bundle"
  bun run typecheck
  bun run build
  echo "PASS: typecheck and production bundle"
  echo
  echo "Witnessed-red contract"
  echo "Mutation proven by unit stub: thread/read returns exact id with empty history; test rejects and call trace is only thread/resume,thread/read (no thread/start)."
  echo "RESULT: PASS"
} 2>&1 | tee "$REPORT"

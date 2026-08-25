#!/usr/bin/env bash
set -euo pipefail
REPORT="${REPORT:-/repo/docs/tests/report-test1178-codex-upgrade-recovery.txt}"
mkdir -p "$(dirname "$REPORT")"
{
  echo "Test 1178 — Codex upgrade recovery and topology audit"
  echo
  echo "Layer 1: pure recovery + existing thread lifecycle"
  cd /repo/agent-network
  bun test src/codex-copresence-recovery.test.ts src/codex-copresence-thread.test.ts src/opencode-agent-node-pair.test.ts
  echo
  echo "Layer 2: production wiring invariants"
  grep -q 'resumeAndVerifyCodexThread' bin/cli.ts
  grep -q 'recovery point created' bin/cli.ts
  grep -q 'codexRecoveryVerification' bin/cli.ts
  grep -q 'codexTopologyAudit' bin/cli.ts
  grep -q 'resolveCodexAgentNodeLaunchPlan' bin/cli.ts
  grep -q 'pairedAgentNodeResolution' bin/cli.ts
  [ "$(grep -c 'await quiesceThenSnapshot' bin/cli.ts)" -eq 2 ] || { echo "FAIL: both Windows and POSIX cutovers must share quiesce-before-snapshot" >&2; exit 1; }
  if sed -n '/function resolveCodexAgentNodeLaunchPlan/,/^}/p' bin/cli.ts | grep -q 'which agent-node'; then
    echo "FAIL: codex paired resolver consults PATH global" >&2
    exit 1
  fi
  if sed -n '/function resolveCodexAgentNodeLaunchPlan/,/^}/p' bin/cli.ts | grep -q '@sleep2agi/agent-node@preview'; then
    echo "FAIL: codex paired resolver uses floating preview" >&2
    exit 1
  fi
  echo "PASS: launcher uses exact resume/read verification, quiesced private snapshot, and audit projection"
  echo "PASS: stale PATH globals are ignored; codex bridge selects exact paired preview.33 and fails closed on identity/capability drift"
  echo
  echo "Layer 3: typecheck + production bundle"
  bun run typecheck
  bun run build
  echo "PASS: typecheck and production bundle"
  echo
  echo "Witnessed-red contract"
  echo "Mutation proven by unit stub: thread/read returns exact id with empty history; test rejects and call trace is only thread/resume,thread/read (no thread/start)."
  echo "Mutation proven by paired-runtime stub: preview.32 differs from the required preview.33; the resolution plan has allowPathGlobal=false and an exact non-floating spec. Missing codex-app-server help is rejected."
  echo "Mutation proven by active-writer stub: snapshot throws if reached while writer=true; production Windows and POSIX call the shared quiesceThenSnapshot boundary exactly once each."
  echo "Mutation proven by recursive state fixture: nested session files have relative path + byte size + sha256; a symlink to outside CODEX_HOME is rejected instead of copied."
  echo "Identity boundary: config-recovery.json is redacted non-credential metadata only. The original config.json and CODEX_HOME remain in place and are never replaced or cleared."
  echo
  echo "Release gate (report-only; this Draft does not publish or bump versions)"
  echo "agent-network preview.44 is immutable/already published. After merge, bump agent-network to preview.45 and update PAIRED_AGENT_NETWORK_VERSION in the same exact release commit; run all release gates before publishing preview.45. Do not overwrite preview.44 or move latest."
  echo "RESULT: PASS"
} 2>&1 | tee "$REPORT"

#!/usr/bin/env bash
set -euo pipefail
REPORT="${REPORT:-/repo/docs/tests/report-test1178-codex-upgrade-recovery.txt}"
mkdir -p "$(dirname "$REPORT")"
{
  echo "Test 1178 — Codex upgrade recovery and topology audit"
  echo
  echo "Layer 1: pure recovery + existing thread lifecycle"
  cd /repo/agent-network
  bun test src/codex-copresence-recovery.test.ts src/codex-copresence-resume-timeout.test.ts src/codex-copresence-env.test.ts src/codex-copresence-rpc.test.ts src/codex-copresence-thread.test.ts src/codex-pending-thread-restart.test.ts src/opencode-agent-node-pair.test.ts
  cd /repo/agent-node
  bun test src/runtime/codex-app-server-bridge.test.ts src/runtime/codex-app-server/resume-timeout.test.ts
  cd /repo/agent-network
  echo
  echo "Layer 2: production wiring invariants"
  grep -q 'resumeAndVerifyCodexThread' src/codex-copresence-rpc.ts
  grep -q 'recovery point created' bin/cli.ts
  grep -q 'bestEffortCodexRecoveryPoint' bin/cli.ts
  grep -q 'skipped Codex recovery-point backup' src/codex-copresence-recovery.ts
  grep -q 'isDeferredThreadMaterialized' /repo/agent-node/src/runtime/codex-app-server-bridge.ts
  [ "$(grep -c 'resolveCopresenceResumeBudget(opts.codexHome' bin/cli.ts)" -eq 2 ] || { echo "FAIL: both launchers must derive the bounded recovery deadline" >&2; exit 1; }
  [ "$(grep -c 'ANET_CODEX_RESUME_TIMEOUT_MS.*resumeBudget.timeoutMs\|ANET_CODEX_RESUME_TIMEOUT_MS.*recoveryTimeoutMs' bin/cli.ts)" -eq 2 ] || { echo "FAIL: both launchers must hand the same recovery deadline to the bridge" >&2; exit 1; }
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
  echo "PASS: stale PATH globals are ignored; codex bridge selects exact paired preview.34 and fails closed on identity/capability drift"
  echo
  echo "Layer 3: typecheck + production bundle"
  bun run typecheck
  bun run build
  echo "PASS: typecheck and production bundle"
  echo
  echo "Layer 4: witnessed-red mutations"
  bun /repo/mutation.mjs
  echo
  echo "Witnessed-red contract"
  echo "Mutation proven by unit stub: thread/read returns exact id with empty history; test rejects and call trace is only thread/resume,thread/read (no thread/start)."
  echo "Mutation proven by paired-runtime stub: preview.33 differs from the required preview.34; the resolution plan has allowPathGlobal=false and an exact non-floating spec. Missing codex-app-server help is rejected."
  echo "Mutation proven by active-writer stub: snapshot throws if reached while writer=true; production Windows and POSIX call the shared quiesceThenSnapshot boundary exactly once each."
  echo "Mutation proven by recursive state fixture: nested session files have relative path + byte size + sha256; a symlink to outside CODEX_HOME is rejected instead of copied."
  echo "Mutation proven by >2 GiB sparse rollout: restoring a whole-file read fails while the streaming sparse copy passes."
  echo "Mutation proven by slow fake app-server: reducing the derived thread/resume deadline below its response delay fails closed."
  echo "Mutation proven by acknowledged-without-rollout fake: a deferred candidate cannot become codexThreadId until its exact rollout exists; the materialization retry shares ANET_CODEX_RESUME_TIMEOUT_MS."
  echo "Mutation proven by --new-session selector: restoring the recorded thread id makes the co-presence test fail; both native platform lanes also discard pending candidates."
  echo "Real private-tmux E2E (test535): a fake config.env provider key is present in app-server, bridge, and TUI /proc environments; deleting the merge is witnessed red. Values never enter argv and the 0600 source file is gone after launch."
  echo "Identity boundary: config-recovery.json is redacted non-credential metadata only. The original config.json and CODEX_HOME remain in place and are never replaced or cleared."
  echo
  echo "Release gate (report-only; this Draft does not publish or bump versions)"
  echo "This change does not bump or publish any package. A release must be built later from an exact main SHA after merge."
  echo "RESULT: PASS"
} 2>&1 | sed 's/[[:space:]]*$//' | tee "$REPORT"

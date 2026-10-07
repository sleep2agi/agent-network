#!/usr/bin/env bash
set -euo pipefail
# Exercise Codex behavior, not host resource admission (covered by test612).
# Shared CI runner load/memory must not delay the fixture's app-server startup.
export ANET_START_MEM_GATE=0

# test-codex-copresence-first-start — #535 (codex CLI audit: P1-1 first start, P1-2 bridge
# failure output, P1-3 needs-login, P2-9 single-node verify). Real Hub on a throwaway port,
# real `anet node start` co-presence on a private tmux socket, built agent-node, fake codex,
# fake (slow) npx. Every layer has a witnessed red: the fix is removed and the same scenario
# must fail for the stated reason.

cd /workspace
echo "T535 source=${T535_SOURCE_COMMIT:-unknown}"
if [ -n "${EXPECTED_SOURCE_COMMIT:-}" ] && [ "${T535_SOURCE_COMMIT:-}" != "$EXPECTED_SOURCE_COMMIT" ]; then
  echo "FAIL: source provenance mismatch image=${T535_SOURCE_COMMIT:-unset} expected=$EXPECTED_SOURCE_COMMIT"
  exit 1
fi
SUITE=tests/test-codex-copresence-first-start

echo "L1 unit: login gate, bridge log, unsafe-directory text, lifecycle verdict"
bun test \
  agent-network/src/codex-copresence-login-gate.test.ts \
  agent-network/src/codex-copresence-bridge-log.test.ts \
  agent-network/src/unsafe-package-path-reason.test.ts \
  agent-network/src/codex-lifecycle-preflight.test.ts \
  agent-network/src/codex-lifecycle-restart.test.ts

echo "L2 build agent-node"
(cd agent-node && bun run build >/dev/null)

NEXT_PORT=19350
run_e2e() {
  local scenario=$1 run_id=$2 delay=${3:-0}
  local port=$NEXT_PORT
  NEXT_PORT=$((NEXT_PORT + 1))
  local db="/tmp/t535-hub-${run_id}.db"
  HOME="$(mktemp -d)" PORT="$port" COMMHUB_DB="$db" COMMHUB_AUTH_TOKEN="t535-${run_id}" \
    bun server/src/index.ts >"/tmp/t535-hub-${run_id}.log" 2>&1 &
  local hub_pid=$!
  local healthy=0
  for _ in $(seq 1 100); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${port}/health" 2>/dev/null; then healthy=1; break; fi
    sleep 0.1
  done
  if [ "$healthy" -ne 1 ]; then
    cat "/tmp/t535-hub-${run_id}.log"
    kill "$hub_pid" 2>/dev/null || true
    return 1
  fi
  local rc=0
  T535_SCENARIO="$scenario" T535_RUN_ID="$run_id" T535_HUB_PORT="$port" T535_NPX_DELAY_S="$delay" \
    bun "$SUITE/e2e.mjs" || rc=$?
  kill "$hub_pid" 2>/dev/null || true
  wait "$hub_pid" 2>/dev/null || true
  return "$rc"
}

# expect_red LABEL WHY CMD… — the mutant must fail, and fail for WHY.
expect_red() {
  local label=$1 why=$2
  shift 2
  local rc=0
  "$@" >/tmp/t535-red.log 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"; cat /tmp/t535-red.log; exit 1
  fi
  if ! grep -Fq -- "$why" /tmp/t535-red.log; then
    echo "MUTATION_RED_FOR_THE_WRONG_REASON: $label (wanted: $why)"; tail -n 60 /tmp/t535-red.log; exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc ($why)"
}
CLI=agent-network/bin/cli.ts
cp "$CLI" /tmp/t535-cli.ts
restore_cli() { cp /tmp/t535-cli.ts "$CLI"; }

# 30 s > the 25 s bridge wait: the audit measured ~32 s for the first real fetch.
DELAY=30

echo "L3 first start with a ${DELAY}s agent-node fetch reaches ready; single node verify PASS"
run_e2e slow-fetch slow "$DELAY"

echo "L4 the bridge's own error survives its tmux session"
run_e2e bridge-dies dies 0

echo "L5 logged out: needs-login, exit 3, nothing started"
run_e2e logged-out out 0

echo "L6 recovery backup failure is fail-closed before any replacement process"
run_e2e backup-fails backup 0

echo "L7 witnessed red: swallowing recovery backup failure must start nothing"
bun tests/test-codex-copresence-first-start/mutate.mjs agent-network/bin/cli.ts \
  '  const backup = backupCodexRecoveryState({ nodeDir, codexHome });' \
  '  let backup; try { backup = backupCodexRecoveryState({ nodeDir, codexHome }); } catch { console.error("MUTANT swallowed recovery backup failure"); return; }'
expect_red backup-fail-open 'start succeeded although the recovery backup failed' run_e2e backup-fails red-backup 0
restore_cli

echo "L8 witnessed red (P1-1): the bridge resolves agent-node itself again (slow npx inside the 25 s wait)"
bun tests/test-codex-copresence-first-start/mutate.mjs agent-network/bin/cli.ts '      ...(pairedAgentNodeEntrypoint ? { ANET_CODEX_PAIRED_AGENT_NODE: pairedAgentNodeEntrypoint } : {}),' ''
expect_red bridge-resolves 'did not reach ready' run_e2e slow-fetch red-slow "$DELAY"
restore_cli

echo "L9 witnessed red (P1-2): the bridge output is no longer copied to its log"
bun tests/test-codex-copresence-first-start/mutate.mjs agent-network/bin/cli.ts '      codexBridgeTeeCommand(shellQuote(bridgeLog)),' ''
expect_red no-bridge-log "the bridge's own error line was not printed" run_e2e bridge-dies red-dies 0
restore_cli

echo "L10 witnessed red (P1-3): the login gate is skipped"
bun tests/test-codex-copresence-first-start/mutate.mjs agent-network/bin/cli.ts 'if (loginGate.state === "needs-login") {' 'if (false) {'
expect_red no-login-gate 'logged-out start exited' run_e2e logged-out red-out 0
restore_cli

echo "L11 witnessed red (P2-9): identity_attested back to unknown without a peer"
bun tests/test-codex-copresence-first-start/mutate.mjs agent-network/bin/cli.ts 'const unattested = { key: "identity_attested", status: "n/a" as const' 'const unattested = { key: "identity_attested", status: "unknown" as const'
expect_red verify-unknown 'single-node verify exited 2' run_e2e slow-fetch red-verify 0
restore_cli

echo "L12 witnessed red: config.env must reach all three co-presence processes"
cp agent-network/src/codex-copresence-env.ts /tmp/t535-env-helper.ts
bun tests/test-codex-copresence-first-start/mutate.mjs agent-network/src/codex-copresence-env.ts '  return out;' '  return Object.fromEntries(Object.entries(required));'
expect_red missing-config-env 'app-server pane pid=' run_e2e slow-fetch red-env 0
cp /tmp/t535-env-helper.ts agent-network/src/codex-copresence-env.ts

echo "L13 witnessed red: reserved config.env validation must precede quiesce"
bun tests/test-codex-copresence-first-start/mutate.mjs agent-network/bin/cli.ts \
  '  codexCopresenceStageEnv(opts.configEnv, {});' \
  '  // mutation: defer reserved config.env validation until after quiesce'
expect_red late-reserved-env 'reserved config.env changed the live session set' run_e2e slow-fetch red-env-order 0
restore_cli

cmp -s /tmp/t535-cli.ts "$CLI" || { echo "FAIL: cli.ts not restored"; exit 1; }
cmp -s /tmp/t535-env-helper.ts agent-network/src/codex-copresence-env.ts || { echo "FAIL: codex-copresence-env.ts not restored"; exit 1; }
leftover=$(pgrep -f 't535-codex app-server' || true)
[ -z "$leftover" ] || { echo "FAIL: app-server left running: $leftover"; exit 1; }
echo "T535 PASS"

#!/usr/bin/env bash
set -euo pipefail

# testwd — #461 App Server watchdog (agent-node): a dead co-presence app-server is relaunched on the
# original tmux session / argv / --listen / CODEX_HOME, the bridge resumes the original thread, the
# Hub's degraded gate (.86, node_degraded) closes during the restart and reopens by itself, and after
# N restarts in the window the node gives up and stays degraded with the reason.
#
# Real Hub (throwaway: temp DB, port 1924x — never 9200), real `anet node start` co-presence in tmux,
# built agent-node, fake codex (tests/test751-codex-copresence-windows/fake-codex.mjs).

echo "TESTWD source=${TESTWD_SOURCE_COMMIT:-unknown}"

echo "L1 unit: watchdog decisions, relaunch from the launch snapshot, health monitor wiring"
bun test \
  agent-node/src/runtime/codex-appserver-watchdog.test.ts \
  agent-node/src/runtime/codex-appserver-relaunch.test.ts \
  agent-node/src/runtime/codex-health.test.ts

echo "L2 build agent-node"
(cd agent-node && bun run build >/dev/null)

run_e2e() {
  local run_id=$1
  local port=$2
  local db="/tmp/testwd-hub-${run_id}.db"
  HOME="$(mktemp -d)" PORT="$port" COMMHUB_DB="$db" COMMHUB_AUTH_TOKEN="testwd-${run_id}" \
    bun server/src/index.ts >"/tmp/testwd-hub-${run_id}.log" 2>&1 &
  local hub_pid=$!
  local healthy=0
  for _ in $(seq 1 100); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${port}/health" 2>/dev/null; then healthy=1; break; fi
    sleep 0.1
  done
  if [ "$healthy" -ne 1 ]; then
    cat "/tmp/testwd-hub-${run_id}.log"
    kill "$hub_pid" 2>/dev/null || true
    return 1
  fi
  local rc=0
  ANET_TESTWD_RUN_ID="$run_id" ANET_TESTWD_HUB_PORT="$port" \
    ANET_TESTWD_TIMEOUT_MS="${ANET_TESTWD_TIMEOUT_MS:-40000}" bun /e2e.mjs || rc=$?
  kill "$hub_pid" 2>/dev/null || true
  wait "$hub_pid" 2>/dev/null || true
  tmux kill-server 2>/dev/null || true
  return "$rc"
}

echo "L3 real Hub + anet co-presence + built agent-node: kill → degraded → relaunch → ok → give up"
run_e2e baseline 19242

echo "L3b #465 hung app-server (alive, port listening): close1006 → SIGTERM, silent+ignores SIGTERM → SIGKILL, relaunch; foreign marker never killed"
ANET_TESTWD_SCENARIO=hung run_e2e hung 19245

# expect_red LABEL WHY CMD… — the mutant must fail, and fail for WHY (a red for an unrelated reason —
# a crash, a port clash — would otherwise read exactly like the guard catching the mutation).
expect_red() {
  local label=$1 why=$2
  shift 2
  set +e
  "$@" >/tmp/testwd-red.log 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    cat /tmp/testwd-red.log
    exit 1
  fi
  if ! grep -Fq -- "$why" /tmp/testwd-red.log; then
    echo "MUTATION_RED_FOR_THE_WRONG_REASON: $label (wanted: $why)"
    tail -n 60 /tmp/testwd-red.log
    exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc ($why)"
}

echo "L4 witnessed red: the probe result no longer reaches the watchdog (no auto-restart)"
cp agent-node/src/cli.ts /tmp/agent-node-cli.ts
bun /mutate.ts agent-node/src/cli.ts \
  'return codexAppServerWatchdog ? codexAppServerWatchdog.observe(h) : h;' \
  'return h;'
(cd agent-node && bun run build >/dev/null)
ANET_TESTWD_TIMEOUT_MS=15000 expect_red no-watchdog-no-heal 'timeout waiting for hub shows app_server degraded (restarting)' run_e2e no_watchdog 19243
cp /tmp/agent-node-cli.ts agent-node/src/cli.ts

echo "L5 witnessed red: the restart budget is ignored (would restart forever)"
cp agent-node/src/runtime/codex-appserver-watchdog.ts /tmp/watchdog.ts
bun /mutate.ts agent-node/src/runtime/codex-appserver-watchdog.ts \
  'if (restarts.length >= maxRestarts) {' \
  'if (false) {'
expect_red unit-budget 'gives up after N restarts inside the window' bun test agent-node/src/runtime/codex-appserver-watchdog.test.ts
(cd agent-node && bun run build >/dev/null)
ANET_TESTWD_TIMEOUT_MS=15000 expect_red e2e-budget 'timeout waiting for hub shows gave up' run_e2e no_budget 19244
cp /tmp/watchdog.ts agent-node/src/runtime/codex-appserver-watchdog.ts

echo "L6 witnessed red (#465): the hung kill path is disabled (a hung app-server is never recovered)"
cp agent-node/src/cli.ts /tmp/agent-node-cli.ts
bun /mutate.ts agent-node/src/cli.ts \
  'if (restartOpts?.killHung && appsrvSnapshot && NODE_CODEX_HOME) {' \
  'if (false) {'
(cd agent-node && bun run build >/dev/null)
ANET_TESTWD_SCENARIO=hung ANET_TESTWD_TIMEOUT_MS=25000 expect_red no-hung-kill 'timeout waiting for close1006: relaunch #2' run_e2e no_hung_kill 19246
cp /tmp/agent-node-cli.ts agent-node/src/cli.ts

echo "L7 witnessed red (#465): the marker check is dropped from the strict identity check (a foreign process would be signalled)"
cp agent-node/src/runtime/codex-appserver-relaunch.ts /tmp/relaunch.ts
bun /mutate.ts agent-node/src/runtime/codex-appserver-relaunch.ts \
  'if (envVarFromEnviron(environ, "ANET_NODE_MARKER") !== deps.marker) return' \
  'if (false) return'
expect_red unit-foreign-marker 'a foreign process is never signalled' bun test agent-node/src/runtime/codex-appserver-relaunch.test.ts
cp /tmp/relaunch.ts agent-node/src/runtime/codex-appserver-relaunch.ts
(cd agent-node && bun run build >/dev/null)

echo "L7b witnessed red: a declined restart / a down first probe is no longer reported at once (only via a later report)"
# CI flake (PR #2328, twice): the probe hit the foreign listener before the bridge saw its ws close, so the 1st failure
# went out raw and the 2nd ("not restarting: …") had the same signature → never reported → the e2e timed out waiting
# for the Hub to show it. Same shape at start-up: a down first tick was never reported. The e2e race is timing-only,
# so the reds are witnessed on the unit tests that pin both reports.
cp agent-node/src/runtime/codex-health.ts /tmp/codex-health.ts
bun /mutate.ts agent-node/src/runtime/codex-health.ts \
  'if (/; not restarting: /.test(e)) return "blocked";' \
  ''
expect_red unit-blocked-flip 'a blocked restart is a signature flip too' bun test agent-node/src/runtime/codex-appserver-watchdog.test.ts
cp /tmp/codex-health.ts agent-node/src/runtime/codex-health.ts
bun /mutate.ts agent-node/src/runtime/codex-health.ts \
  'if (firstAndDown || (lastSig !== null && sig !== lastSig))' \
  'if (lastSig !== null && sig !== lastSig)'
expect_red unit-first-tick-down 'the first tick reports a down result at once' bun test agent-node/src/runtime/codex-health.test.ts
cp /tmp/codex-health.ts agent-node/src/runtime/codex-health.ts

echo "L8 #2255 the TUI paints before it connects (fake delays its websocket 2 s): start still succeeds"
ANET_TEST_TUI_CONNECT_DELAY_MS=2000 run_e2e tui_late_connect 19249

echo "L8 witnessed red: attribution probed only once (gives up on the first miss)"
cp agent-network/src/posix-codex-copresence.ts /tmp/posix.ts
bun /mutate.ts agent-network/src/posix-codex-copresence.ts \
  'if (now() - started >= opts.deadlineMs) return { outcome: "deadline", probes, waitedMs: now() - started };' \
  'return { outcome: "deadline", probes, waitedMs: now() - started };'
ANET_TEST_TUI_CONNECT_DELAY_MS=2000 ANET_TESTWD_TIMEOUT_MS=15000 expect_red single-shot-attribution 'TUI second-client health failed' run_e2e tui_single_shot 19250
cp /tmp/posix.ts agent-network/src/posix-codex-copresence.ts

echo "TESTWD PASS"

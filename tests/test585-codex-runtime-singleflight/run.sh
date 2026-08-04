#!/usr/bin/env bash
set -u

cd /workspace/agent-node

normal_log=/tmp/test585-normal.log
if ! bun test \
  ./src/runtime/codex-app-server/session-manager.test.ts \
  ./src/runtime/codex-app-server/runtime.test.ts \
  ./src/inbox-dispatch.test.ts >"$normal_log" 2>&1; then
  cat "$normal_log"
  echo "RESULT: FAIL normal"
  exit 1
fi
cat "$normal_log"

for mutation in bypass_singleflight sticky_rejected_open bypass_cli_wiring publish_dead_session stale_exit_clears_new; do
  cp ./src/runtime/codex-app-server/session-manager.ts /tmp/session-manager.ts
  cp ./src/util/single-flight.ts /tmp/single-flight.ts
  cp ./src/cli.ts /tmp/cli.ts
  bun /harness/mutate.ts "$mutation"
  mutation_log="/tmp/test585-${mutation}.log"
  if bun test ./src/runtime/codex-app-server/session-manager.test.ts >"$mutation_log" 2>&1; then
    cat "$mutation_log"
    cp /tmp/session-manager.ts ./src/runtime/codex-app-server/session-manager.ts
    cp /tmp/single-flight.ts ./src/util/single-flight.ts
    cp /tmp/cli.ts ./src/cli.ts
    echo "RESULT: FAIL mutation-survived $mutation"
    exit 1
  fi
  echo "WITNESSED-RED: $mutation"
  tail -12 "$mutation_log"
  cp /tmp/session-manager.ts ./src/runtime/codex-app-server/session-manager.ts
  cp /tmp/single-flight.ts ./src/util/single-flight.ts
  cp /tmp/cli.ts ./src/cli.ts
done

bun run build >/tmp/test585-build.log 2>&1 || {
  cat /tmp/test585-build.log
  echo "RESULT: FAIL build"
  exit 1
}
echo "BUILD: PASS"
echo "RESULT: PASS"

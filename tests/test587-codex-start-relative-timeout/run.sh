#!/usr/bin/env bash
set -u

cd /workspace/agent-node
normal=/tmp/test587-normal.log
if ! bun test \
  ./src/runtime/codex-app-server-bridge.test.ts \
  ./src/runtime/codex-app-server/runtime.test.ts \
  ./src/runtime/codex-app-server/session-manager.test.ts >"$normal" 2>&1; then
  cat "$normal"
  echo "RESULT: FAIL normal"
  exit 1
fi
cat "$normal"

for mutation_name in timer_at_submission ignore_started_event wrong_task_arms_timer omit_bridge_started_event omit_steer_started_event omit_queue_deadline queue_timeout_does_not_cancel cancel_queue_noop failure_returned_as_success; do
  cp ./src/runtime/codex-app-server/runtime.ts /tmp/test587-runtime.ts
  cp ./src/runtime/codex-app-server-bridge.ts /tmp/test587-bridge.ts
  cp ./src/cli.ts /tmp/test587-cli.ts
  if ! bun /harness/mutate.ts "$mutation_name"; then
    cp /tmp/test587-runtime.ts ./src/runtime/codex-app-server/runtime.ts
    cp /tmp/test587-bridge.ts ./src/runtime/codex-app-server-bridge.ts
    cp /tmp/test587-cli.ts ./src/cli.ts
    echo "RESULT: FAIL mutation-anchor $mutation_name"
    exit 1
  fi
  mutation=/tmp/test587-${mutation_name}.log
  if bun test \
    ./src/runtime/codex-app-server-bridge.test.ts \
    ./src/runtime/codex-app-server/runtime.test.ts \
    ./src/runtime/codex-app-server/session-manager.test.ts >"$mutation" 2>&1; then
    cat "$mutation"
    cp /tmp/test587-runtime.ts ./src/runtime/codex-app-server/runtime.ts
    cp /tmp/test587-bridge.ts ./src/runtime/codex-app-server-bridge.ts
    cp /tmp/test587-cli.ts ./src/cli.ts
    echo "RESULT: FAIL mutation-survived $mutation_name"
    exit 1
  fi
  echo "WITNESSED-RED: $mutation_name"
  tail -16 "$mutation"
  cp /tmp/test587-runtime.ts ./src/runtime/codex-app-server/runtime.ts
  cp /tmp/test587-bridge.ts ./src/runtime/codex-app-server-bridge.ts
  cp /tmp/test587-cli.ts ./src/cli.ts
done

bun run build >/tmp/test587-build.log 2>&1 || {
  cat /tmp/test587-build.log
  echo "RESULT: FAIL build"
  exit 1
}
echo "BUILD: PASS"
echo "RESULT: PASS"

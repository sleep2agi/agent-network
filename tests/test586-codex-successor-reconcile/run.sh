#!/usr/bin/env bash
set -u

cd /workspace/agent-node
normal=/tmp/test586-normal.log
if ! bun test \
  ./src/runtime/codex-app-server-bridge.test.ts \
  ./src/runtime/codex-app-server/runtime.test.ts >"$normal" 2>&1; then
  cat "$normal"
  echo "RESULT: FAIL normal"
  exit 1
fi
cat "$normal"

for mutation_name in aggregate_active_shortcut missing_turn_fail_open wrong_turn_attribution drain_during_successor; do
  cp ./src/runtime/codex-app-server-bridge.ts /tmp/codex-app-server-bridge.ts
  bun /harness/mutate.ts "$mutation_name"
  mutation="/tmp/test586-${mutation_name}.log"
  if bun test ./src/runtime/codex-app-server-bridge.test.ts >"$mutation" 2>&1; then
    cat "$mutation"
    cp /tmp/codex-app-server-bridge.ts ./src/runtime/codex-app-server-bridge.ts
    echo "RESULT: FAIL mutation-survived $mutation_name"
    exit 1
  fi
  echo "WITNESSED-RED: $mutation_name"
  tail -18 "$mutation"
  cp /tmp/codex-app-server-bridge.ts ./src/runtime/codex-app-server-bridge.ts
done

bun run build >/tmp/test586-build.log 2>&1 || {
  cat /tmp/test586-build.log
  echo "RESULT: FAIL build"
  exit 1
}
echo "BUILD: PASS"
echo "RESULT: PASS"

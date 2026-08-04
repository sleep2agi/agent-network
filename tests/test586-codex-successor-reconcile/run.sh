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

cp ./src/runtime/codex-app-server-bridge.ts /tmp/codex-app-server-bridge.ts
bun /harness/mutate.ts aggregate_active_shortcut
mutation=/tmp/test586-mutation.log
if bun test ./src/runtime/codex-app-server-bridge.test.ts \
  --test-name-pattern 'successor keeps the thread active' >"$mutation" 2>&1; then
  cat "$mutation"
  cp /tmp/codex-app-server-bridge.ts ./src/runtime/codex-app-server-bridge.ts
  echo "RESULT: FAIL mutation-survived"
  exit 1
fi
echo "WITNESSED-RED: aggregate_active_shortcut"
cat "$mutation"
cp /tmp/codex-app-server-bridge.ts ./src/runtime/codex-app-server-bridge.ts

bun run build >/tmp/test586-build.log 2>&1 || {
  cat /tmp/test586-build.log
  echo "RESULT: FAIL build"
  exit 1
}
echo "BUILD: PASS"
echo "RESULT: PASS"

#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/repo
ART=/artifacts
PASS=0
FAIL=0
mkdir -p "$ART"

ok(){ PASS=$((PASS+1)); printf 'PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }
expect_red(){
  local name="$1"; shift
  if "$@" >"$ART/$name.log" 2>&1; then bad "mutation $name stayed green"; else ok "mutation $name witnessed red"; fi
}

printf 'source_commit=%s\n' "${TEST659_SOURCE_COMMIT:-unknown}"
cd "$ROOT/agent-node"

bun test \
  src/runtime/codex-app-server/runtime.test.ts \
  src/runtime/codex-app-server-bridge.test.ts
ok "activity-reset and exact-turn unit contracts"

bun run build >/dev/null
ok "agent-node bundle builds with activity heartbeat wiring"

grep -F 'if (now - lastActivityHeartbeatAt < 30_000) return;' src/cli.ts >/dev/null
grep -F 'reportStatus("working", task.slice(0, 200))' src/cli.ts >/dev/null
ok "Hub working heartbeat is bounded to at most once per 30 seconds"

cp src/runtime/codex-app-server/runtime.ts /tmp/test659-runtime.orig
sed -i 's/armResponseIdleTimer(true);/\/\/ mutation: idle deadline is not reset/' src/runtime/codex-app-server/runtime.ts
grep -F '// mutation: idle deadline is not reset' src/runtime/codex-app-server/runtime.ts >/dev/null
expect_red remove-idle-reset bun test src/runtime/codex-app-server/runtime.test.ts
cp /tmp/test659-runtime.orig src/runtime/codex-app-server/runtime.ts

cp src/runtime/codex-app-server-bridge.ts /tmp/test659-bridge.orig
sed -i 's/if (pending?.identityConfirmed) {/if (pending) {/' src/runtime/codex-app-server-bridge.ts
grep -F 'if (pending) {' src/runtime/codex-app-server-bridge.ts >/dev/null
expect_red trust-unconfirmed-response-turn bun test src/runtime/codex-app-server-bridge.test.ts
cp /tmp/test659-bridge.orig src/runtime/codex-app-server-bridge.ts

sed -i 's/bridge.on("task_activity", onActivity);/\/\/ mutation: listener removed/' src/runtime/codex-app-server/runtime.ts
grep -F '// mutation: listener removed' src/runtime/codex-app-server/runtime.ts >/dev/null
expect_red remove-activity-listener bun test src/runtime/codex-app-server/runtime.test.ts
cp /tmp/test659-runtime.orig src/runtime/codex-app-server/runtime.ts

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]

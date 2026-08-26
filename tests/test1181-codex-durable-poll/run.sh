#!/bin/sh
set -eu

if ! printf '%s' "${TEST1181_SOURCE_COMMIT:-}" | grep -Eq '^[0-9a-f]{40}$'; then
  echo 'FAIL: TEST1181_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
fi
printf 'source_commit=%s\n' "$TEST1181_SOURCE_COMMIT"

if [ "${TEST1181_SHA_SELFTEST_ONLY:-0}" = "1" ]; then
  exit 0
fi

if env -u TEST1181_SOURCE_COMMIT TEST1181_SHA_SELFTEST_ONLY=1 "$0" >/tmp/test1181-sha-missing.log 2>&1; then
  echo 'FAIL: missing source SHA survived' >&2
  exit 1
fi
grep -Fq 'must be one full lowercase Git SHA' /tmp/test1181-sha-missing.log
if TEST1181_SOURCE_COMMIT=ABC123 TEST1181_SHA_SELFTEST_ONLY=1 "$0" >/tmp/test1181-sha-invalid.log 2>&1; then
  echo 'FAIL: invalid source SHA survived' >&2
  exit 1
fi
grep -Fq 'must be one full lowercase Git SHA' /tmp/test1181-sha-invalid.log
echo 'PASS source SHA binding + 2 witnessed-red cases'

cd /workspace

echo "L1 environment + pure durable compensator"
bun test agent-node/src/runtime/commhub-poll-compensator.test.ts

echo "L1 Hub immutable identity + cursor pagination"
bun test server/src/task-consumption.test.ts

echo "L2 fault/reconnect + existing single-flight/steer ownership"
bun test \
  agent-node/src/runtime/inbox-drain-lane.test.ts \
  agent-node/src/runtime/codex-app-server-bridge.test.ts \
  agent-node/src/runtime/codex-app-server/runtime.test.ts

echo "L2 witnessed-red mutations"
./witnessed-red.sh

echo "L3 production bundle"
cd agent-node
bun run build

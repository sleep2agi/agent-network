#!/usr/bin/env bash
set -euo pipefail

cd /app
echo "source_commit=${SOURCE_COMMIT}"
bun test server/src/side-thread.test.ts -t 'terminal events|terminal event arriving|cancel is exact|cross-coordinator|retry persists|archive/purge|bring-back|response loss|ambiguous cancel'

# Witness red: weaken one member of the four-part terminal ownership tuple.
cp server/src/side-thread.ts /tmp/side-thread.ts
sed -i 's/owned\.derived_thread_id !== event\.threadId/false/' server/src/side-thread.ts
grep -F 'false ||' server/src/side-thread.ts >/dev/null
if bun test server/src/side-thread.test.ts -t 'terminal events require' >/tmp/race-mutation.log 2>&1; then
  echo "FAIL: event ownership mutation survived"
  cat /tmp/race-mutation.log
  exit 1
fi
mv /tmp/side-thread.ts server/src/side-thread.ts

echo "PASS test1195 SideThread Hub races + witnessed red"

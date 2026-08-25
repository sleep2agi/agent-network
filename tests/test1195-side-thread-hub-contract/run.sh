#!/usr/bin/env bash
set -euo pipefail

cd /app
echo "source_commit=${SOURCE_COMMIT}"
bun test server/src/side-thread.test.ts -t 'feature flag|create is payload|cross-window|authoritative vendorable|routes use|disabled surface|capability flips'

# Witness red: removing the explicit native-exact-fork mode gate must make the
# unverified/shared adapter case fail.
cp server/src/side-thread.ts /tmp/side-thread.ts
sed -i 's/cap\.mode !== "native-exact-fork"/false/' server/src/side-thread.ts
grep -F 'if (false)' server/src/side-thread.ts >/dev/null
if bun test server/src/side-thread.test.ts -t 'feature flag and missing runtime adapter' >/tmp/contract-mutation.log 2>&1; then
  echo "FAIL: native-mode mutation survived"
  cat /tmp/contract-mutation.log
  exit 1
fi
mv /tmp/side-thread.ts server/src/side-thread.ts

echo "PASS test1195 SideThread Hub contract + witnessed red"

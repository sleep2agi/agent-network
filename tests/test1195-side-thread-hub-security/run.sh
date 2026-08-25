#!/usr/bin/env bash
set -euo pipefail

cd /app/server
echo "source_commit=${SOURCE_COMMIT}"
bun test src/side-thread-http-integration.test.ts

# Witness red: accepting a query-string token would expose the persisted owner
# question across browser/log boundaries. The integration assertion must catch it.
cp src/server.ts /tmp/server.ts
sed -i 's/resolveRequestAuth(req, { allowQueryToken: false })/resolveRequestAuth(req)/' src/server.ts
grep -F 'actor: resolveSideThreadActor(req, resolveRequestAuth(req), isAdmin)' src/server.ts >/dev/null
if bun test src/side-thread-http-integration.test.ts >/tmp/security-mutation.log 2>&1; then
  echo "FAIL: query-token auth mutation survived"
  cat /tmp/security-mutation.log
  exit 1
fi
mv /tmp/server.ts src/server.ts

echo "PASS test1195 SideThread Hub auth/SSE security + witnessed red"

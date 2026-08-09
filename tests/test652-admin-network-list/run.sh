#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test652-admin-network-list.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1
cd /workspace

echo "# test652 — global admin /api/networks visibility"
echo "source_commit=${TEST652_SOURCE_COMMIT:-unknown}"
echo "bun=$(bun --version)"
echo "date=$(date -Is)"

run_http_test() {
  COMMHUB_DB=$(mktemp /tmp/test652-db.XXXXXX) \
    bun test server/src/admin-networks-http.test.ts
}

echo "L0: production Hub build"
bun build server/src/index.ts --target bun --outfile /tmp/test652-hub.js
test -s /tmp/test652-hub.js

echo "L1: real HTTP admin/member/ntok visibility"
run_http_test

cp server/src/server.ts /tmp/test652-server.ts

echo "L2 witnessed-red: collapse global admin back to membership-only listing"
sed -i '/const networks = resolved.user.role === "admin"/,/: getUserAllNetworks(resolved.user.user_id);/c\      const networks = getUserAllNetworks(resolved.user.user_id);' server/src/server.ts
grep -Fq 'const networks = getUserAllNetworks(resolved.user.user_id);' server/src/server.ts
set +e
run_http_test >/tmp/test652-admin-mutation.log 2>&1
admin_rc=$?
set -e
test "$admin_rc" -ne 0
grep -Fq 'global admin utok sees every network' /tmp/test652-admin-mutation.log
echo "MUTATION_RED: admin-membership-only rc=$admin_rc"
cp /tmp/test652-server.ts server/src/server.ts

echo "L3 witnessed-red: let ordinary utok use the global-admin listing"
sed -i '/const networks = resolved.user.role === "admin"/,/: getUserAllNetworks(resolved.user.user_id);/ s/resolved.user.role === "admin"/true/' server/src/server.ts
grep -Fq 'const networks = true' server/src/server.ts
set +e
run_http_test >/tmp/test652-member-mutation.log 2>&1
member_rc=$?
set -e
test "$member_rc" -ne 0
grep -Fq 'ordinary utok remains limited to member networks' /tmp/test652-member-mutation.log
echo "MUTATION_RED: ordinary-user-global-list rc=$member_rc"
cp /tmp/test652-server.ts server/src/server.ts

echo "L4 restored green"
run_http_test

echo "RESULT: PASS"

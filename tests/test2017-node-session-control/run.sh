#!/usr/bin/env bash
set -euo pipefail
test -f /.dockerenv
[[ "${SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]]
echo "source_commit=$SOURCE_COMMIT"
source /work/tests/lib/safe-rm.sh
SAFE_RM_ALLOW_PREFIXES=/tmp/anet-session-control.
fixture=$(mktemp -d /tmp/anet-session-control.XXXXXX)
readonly fixture
trap 'safe_rm_rf "$fixture"' EXIT
unset DATABASE_URL COMMHUB_TEST_PG_URL
export HOME="$fixture" COMMHUB_DB="$fixture/hub.db" COMMHUB_DEV_OPEN=1 COMMHUB_AUTH_TOKEN=legacy-test-only
cd /work/server
bun test "$@" src/node-session-control-http.test.ts

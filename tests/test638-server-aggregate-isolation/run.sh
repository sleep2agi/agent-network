#!/usr/bin/env bash
set -euo pipefail

EXPECTED_SOURCE_COMMIT="${EXPECTED_SOURCE_COMMIT:-}"
if [[ -z "${TEST638_SOURCE_COMMIT:-}" || -z "$EXPECTED_SOURCE_COMMIT" || "$TEST638_SOURCE_COMMIT" != "$EXPECTED_SOURCE_COMMIT" ]]; then
  echo "FAIL: source provenance mismatch image=${TEST638_SOURCE_COMMIT:-unset} expected=${EXPECTED_SOURCE_COMMIT:-unset}"
  exit 1
fi

cd /work

TRACE=/tmp/test638-openat.trace
OUTPUT=/tmp/test638-aggregate.out
PARENT_DB=/tmp/test638-aggregate.db
rm -f "$TRACE" "$OUTPUT" "$PARENT_DB" "$PARENT_DB-wal" "$PARENT_DB-shm"
find /tmp -maxdepth 1 -type d \( -name 'anet-upload-http-db-*' -o -name 'anet-hs-fallback-db-*' \) -exec rm -rf -- {} +

set +e
NODE_ENV=test DATABASE_URL= COMMHUB_DB="$PARENT_DB" \
  strace -f -e trace=openat -o "$TRACE" \
  bun test server/src/ >"$OUTPUT" 2>&1
rc=$?
set -e

summary=$(grep -E '^[[:space:]]*[0-9]+ pass$|^[[:space:]]*[0-9]+ fail$|^[[:space:]]*[0-9]+ expect\(\) calls$' "$OUTPUT" | tr '\n' ';')
[[ -n "$summary" ]] || { echo "FAIL: aggregate summary missing"; exit 1; }

parent_opens=$(grep -F -c "$PARENT_DB" "$TRACE" || true)
upload_opens=$(grep -E -c '/tmp/anet-upload-http-db-[^/]*/commhub\.db' "$TRACE" || true)
host_opens=$(grep -E -c '/tmp/anet-hs-fallback-db-[^/]*/commhub\.db' "$TRACE" || true)

echo "source_commit=$TEST638_SOURCE_COMMIT"
echo "aggregate_summary=$summary"
echo "parent_db_openat_count=$parent_opens"
echo "uploads_intended_db_openat_count=$upload_opens"
echo "host_supervisors_intended_db_openat_count=$host_opens"

failed=0
if [[ $rc -ne 0 ]]; then
  grep -E '^\(fail\)|^[[:space:]]*[0-9]+ tests? failed|^[[:space:]]*[0-9]+ fail$|error: race_workers_not_ready' "$OUTPUT" || true
  echo "FAIL: canonical aggregate suite rc=$rc"
  failed=1
fi
[[ $parent_opens -gt 0 ]] || { echo "FAIL: aggregate parent DB was not observed"; failed=1; }
[[ $upload_opens -gt 0 ]] || { echo "FAIL: uploads integration suite never opened its intended temp DB"; failed=1; }
[[ $host_opens -gt 0 ]] || { echo "FAIL: host-supervisors integration suite never opened its intended temp DB"; failed=1; }

[[ $failed -eq 0 ]] || exit 1

echo "RESULT: PASS"

#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test599-skillhub.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test599 — network-scoped SkillHub"
echo "source_commit=${TEST599_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_real() {
  local db_path=$1
  COMMHUB_DB="$db_path" bun test server/src/skillhub-http.test.ts
}

expect_red() {
  local label=$1 db_path=$2
  set +e
  run_real "$db_path" >/tmp/test599-red.log 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    sed -n '1,180p' /tmp/test599-red.log
    exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc"
}

echo "L0 build + schema"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-skillhub.js
test -s /tmp/commhub-skillhub.js
grep -Fq 'CREATE TABLE IF NOT EXISTS skillhub_skills' server/src/db.ts

echo "L1-L4 real Hub, auth, idempotency, review and tenant isolation"
run_real /tmp/test599-green.db

echo "L5 witnessed-red: pending cannot silently publish"
cp server/src/tools.ts /tmp/test599-tools.ts
sed -i "0,/'pending', ?9/s//'published', ?9/" server/src/tools.ts
grep -Fq "'published', ?9" server/src/tools.ts
expect_red pending-review-required /tmp/test599-mut-publish.db
cp /tmp/test599-tools.ts server/src/tools.ts

echo "L6 witnessed-red: network predicate is load-bearing"
sed -i 's/SELECT status FROM skillhub_skills WHERE skill_id = ?1 AND network_id = ?2/SELECT status FROM skillhub_skills WHERE skill_id = ?1/' server/src/tools.ts
grep -Fq 'SELECT status FROM skillhub_skills WHERE skill_id = ?1`' server/src/tools.ts
expect_red cross-network-review-denied /tmp/test599-mut-tenant.db
cp /tmp/test599-tools.ts server/src/tools.ts

echo "L7 restored green"
run_real /tmp/test599-restored.db
echo "RESULT: PASS"

#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test688-owner-gated-schedule-hub.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test688 — RFC-036 owner-gated schedule Hub"
echo "source_commit=${TEST688_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_real() {
  local db_path=$1
  COMMHUB_DB="$db_path" bun test server/src/external-schedule-edits-http.test.ts
}

expect_red() {
  local label=$1 db_path=$2
  set +e
  run_real "$db_path" >"/tmp/test688-${label}.log" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    sed -n '1,260p' "/tmp/test688-${label}.log"
    exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc"
}

backup() { cp "$1" "/tmp/test688-$(basename "$1")"; }
restore() { cp "/tmp/test688-$(basename "$1")" "$1"; }

echo "L0 build"
bun build server/src/index.ts --target bun --outfile /tmp/commhub-b4.js
test -s /tmp/commhub-b4.js

echo "L1 real Hub HTTP + SQLite contract"
run_real /tmp/test688-green.db

echo "L1b compatibility: SEC1, REST projections, Hub scheduler, file network scope"
COMMHUB_DB=/tmp/test688-reg-sec1.db bun test server/src/config-apply-sec1.test.ts
COMMHUB_DB=/tmp/test688-reg-rest.db bun test server/src/rest-explicit-columns-http.test.ts
COMMHUB_DB=/tmp/test688-reg-sched.db bun test server/src/scheduled-tasks-http.test.ts
COMMHUB_DB=/tmp/test688-reg-file.db bun test server/src/file-network-scope.test.ts

backup server/src/auth.ts
backup server/src/db.ts
backup server/src/server.ts
backup server/src/tools.ts
backup server/src/external-schedule-edits.ts
backup server/src/shared/external-schedule-contract.ts

echo "L2 witnessed-red: exact node owner has no admin/member bypass"
sed -i 's/if (ctx.auth.userId !== node.owner_user_id)/if (false \&\& ctx.auth.userId !== node.owner_user_id)/' server/src/external-schedule-edits.ts
grep -Fq 'if (false && ctx.auth.userId !== node.owner_user_id)' server/src/external-schedule-edits.ts
expect_red exact-owner-no-admin-bypass /tmp/test688-mut-owner.db
restore server/src/external-schedule-edits.ts

echo "L3 witnessed-red: a legacy NULL owner cannot be first-claimed"
sed -i 's/if (existing \&\& !existing.owner_user_id) throw new Error("node_owner_unclaimed");/if (false \&\& existing \&\& !existing.owner_user_id) throw new Error("node_owner_unclaimed");/' server/src/auth.ts
grep -Fq 'if (false && existing && !existing.owner_user_id)' server/src/auth.ts
expect_red legacy-owner-read-only /tmp/test688-mut-legacy.db
restore server/src/auth.ts

echo "L3b witnessed-red: immutable owner claim is audited in the mint transaction"
sed -i "s/'external_schedule.owner_claimed'/'external_schedule.owner_claim_missing'/" server/src/auth.ts
grep -Fq "'external_schedule.owner_claim_missing'" server/src/auth.ts
expect_red owner-claim-audit /tmp/test688-mut-owner-audit.db
restore server/src/auth.ts

echo "L4 witnessed-red: structured patch allowlist is exact"
sed -i 's/keys.some((key) => key !== "enabled" \&\& key !== "cron")/keys.some((_key) => false)/' server/src/shared/external-schedule-contract.ts
grep -Fq 'keys.some((_key) => false)' server/src/shared/external-schedule-contract.ts
expect_red structured-fields-only /tmp/test688-mut-fields.db
restore server/src/shared/external-schedule-contract.ts

echo "L5 witnessed-red: node consumer binding is exact"
perl -0pi -e 's/if \(!token \|\| token\.bound_node_id !== node\.node_id \|\| token\.network_id !== node\.network_id \|\| token\.user_id !== node\.owner_user_id\) \{/if (!token) {/' server/src/external-schedule-edits.ts
grep -Fq 'if (!token) {' server/src/external-schedule-edits.ts
expect_red exact-bound-node-token /tmp/test688-mut-binding.db
restore server/src/external-schedule-edits.ts

echo "L6 witnessed-red: optimistic revision is checked before and inside the transaction"
sed -i 's/Number(schedule.revision) !== Number(body.base_revision)/false/' server/src/external-schedule-edits.ts
sed -i 's/Number(current.revision) !== Number(body.base_revision)/false/' server/src/external-schedule-edits.ts
test "$(grep -Fc 'if (false)' server/src/external-schedule-edits.ts)" -ge 2
expect_red revision-cas /tmp/test688-mut-revision.db
restore server/src/external-schedule-edits.ts

echo "L7 witnessed-red: cross-worker single-flight is DB-enforced"
sed -i 's/CREATE UNIQUE INDEX IF NOT EXISTS idx_external_schedule_edits_singleflight/CREATE INDEX IF NOT EXISTS idx_external_schedule_edits_singleflight/' server/src/db.ts
grep -Fq 'CREATE INDEX IF NOT EXISTS idx_external_schedule_edits_singleflight' server/src/db.ts
expect_red sqlite-singleflight /tmp/test688-mut-singleflight.db
restore server/src/db.ts

echo "L8 witnessed-red: lifecycle audit is mandatory"
perl -0pi -e 's/\): void \{\n  db\.run\(\n    `INSERT INTO audit_log/): void {\n  return;\n  db.run(\n    `INSERT INTO audit_log/' server/src/external-schedule-edits.ts
grep -A1 -F '): void {' server/src/external-schedule-edits.ts | grep -Fq 'return;'
expect_red mandatory-audit /tmp/test688-mut-audit.db
restore server/src/external-schedule-edits.ts

echo "L9 witnessed-red: delivered intents expire instead of wedging the node"
sed -i "s/status IN ('pending', 'delivered')/status = 'pending'/g" server/src/external-schedule-edits.ts
test "$(grep -Fc "status = 'pending' AND expires_at" server/src/external-schedule-edits.ts)" -ge 2
expect_red delivered-ttl /tmp/test688-mut-expiry.db
restore server/src/external-schedule-edits.ts

echo "L10 witnessed-red: terminal retry must be semantically identical"
sed -i 's/if (row.status === body.status \&\& row.result_revision === requestedRevision \&\& row.error_code === requestedError)/if (true || (row.status === body.status \&\& row.result_revision === requestedRevision \&\& row.error_code === requestedError))/' server/src/external-schedule-edits.ts
grep -Fq 'if (true || (row.status === body.status' server/src/external-schedule-edits.ts
expect_red exact-terminal-retry /tmp/test688-mut-terminal.db
restore server/src/external-schedule-edits.ts

echo "L11 witnessed-red: report_status cannot cross an established owner"
sed -i 's/if (existing?.owner_user_id \&\& input.callerUserId !== existing.owner_user_id)/if (false \&\& existing?.owner_user_id \&\& input.callerUserId !== existing.owner_user_id)/' server/src/tools.ts
grep -Fq 'if (false && existing?.owner_user_id' server/src/tools.ts
expect_red report-owner-verify /tmp/test688-mut-report-owner.db
restore server/src/tools.ts

echo "L12 witnessed-red: HTTP token mint must carry node_id into the atomic owner transaction"
sed -i 's/, body.node_id);/);/' server/src/server.ts
grep -Fq 'createNetworkTokenForNode(resolved.user.user_id, body.network_id, body.node_name);' server/src/server.ts
expect_red token-mint-node-id-wire /tmp/test688-mut-token-wire.db
restore server/src/server.ts

echo "L13 restored green"
run_real /tmp/test688-restored.db

echo "RESULT: PASS"

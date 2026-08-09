#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
WORK=/tmp/test292-residual

pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }

mkdir -p "$WORK"
echo "source_commit=$TEST292_RESIDUAL_SOURCE_COMMIT"

run_green() {
  local name=$1 script=$2 expected=$3 log="$WORK/$1.log"
  if timeout 420 bash "$script" >"$log" 2>&1 && grep -Fq "$expected" "$log"; then
    pass "$name: $expected"
  else
    tail -80 "$log" >&2 || true
    fail "$name did not reach its exact green trailer"
  fi
}

# Layered green: cheap isolation and install paths first, then the real
# scheduler windows. A failed prerequisite stops this exact evidence run.
run_green networks /app/test-networks.sh "Results: 26 passed, 0 failed"
[[ $FAIL -eq 0 ]] || exit 1
run_green npm-pack /app/test-loop-npm-pack.sh "Results: 12 passed, 0 failed"
[[ $FAIL -eq 0 ]] || exit 1
run_green self-mgmt /app/test-loop-self-mgmt.sh "Results: 47 passed, 0 failed"
[[ $FAIL -eq 0 ]] || exit 1
run_green runtime /app/test-loop-runtime.sh "Results: 21 passed, 0 failed"

# Witnessed-red 1: if A becomes the bootstrap admin again, its visibility is
# intentionally wider and the ordinary-user isolation assertion must fail.
# The green network script owns :9200 and kills its Hub on EXIT; wait for that
# exact listener to disappear before starting the mutated isolated Hub.
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:9200/health >/dev/null 2>&1 || break
  sleep 0.1
done
MUT_NETWORK="$WORK/networks-admin-a.sh"
cp /app/test-networks.sh "$MUT_NETWORK"
sed -i 's/net_bootstrap_admin/netuser_a/' "$MUT_NETWORK"
sed -i 's|(cd /app/server && exec bun run src/index.ts)|(cd /app/server \&\& exec env COMMHUB_DB=/tmp/test292-mut-network.db bun run src/index.ts)|' "$MUT_NETWORK"
if cmp -s /app/test-networks.sh "$MUT_NETWORK"; then
  fail "mutation: bootstrap-admin anchor did not match"
elif timeout 30 bash "$MUT_NETWORK" >"$WORK/networks-admin-a.log" 2>&1; then
  fail "mutation: admin A was incorrectly accepted as an isolation fixture"
elif grep -Fq "A sees B's network!" "$WORK/networks-admin-a.log"; then
  pass "mutation: restoring admin A turns tenant isolation red"
else
  tail -40 "$WORK/networks-admin-a.log" >&2 || true
  fail "mutation: network test failed for an unrelated reason"
fi

# Witnessed-red 2-4: each loop suite must depend on the exact alias passed to
# the public CLI identity bootstrap. Replacing it with the registration alias
# leaves the expected config absent and must stop before an agent starts.
mutate_exact_alias() {
  local name=$1 source=$2 anchor=$3 replacement=$4 log="$WORK/mut-$1.log"
  local mut="$WORK/mut-$1.sh"
  cp "$source" "$mut"
  sed -i "s|$anchor|$replacement|" "$mut"
  if cmp -s "$source" "$mut"; then
    fail "mutation: $name exact-alias anchor did not match"
  elif timeout 45 bash "$mut" >"$log" 2>&1; then
    fail "mutation: $name ran without its exact node identity"
  elif grep -Eq 'No such file|not authoritative|alias_identity_mismatch|config' "$log"; then
    pass "mutation: $name exact-alias identity is load-bearing"
  else
    tail -40 "$log" >&2 || true
    fail "mutation: $name failed for an unrelated reason"
  fi
}

mutate_exact_alias runtime /app/test-loop-runtime.sh \
  'e2e_create_agent "$alias" "$runtime"' \
  'e2e_create_agent loop-test "$runtime"'
mutate_exact_alias npm-pack /app/test-loop-npm-pack.sh \
  'e2e_create_agent "$ALIAS" claude-agent-sdk' \
  'e2e_create_agent pack-test claude-agent-sdk'
mutate_exact_alias self-mgmt /app/test-loop-self-mgmt.sh \
  'e2e_create_agent "$alias" "$runtime"' \
  'e2e_create_agent m4-tester "$runtime"'

echo "RESULT: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]

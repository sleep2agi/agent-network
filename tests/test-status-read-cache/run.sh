#!/usr/bin/env bash
# test-status-read-cache — #431 GET /api/status memoization + strong ETag, and what it buys on the wire.
#
#   L1  unit/http: cached body == recomputed body under random writes / health reports / health expiry
#       (status-read-cache-http.test.ts), plus the existing /api/status suites (alias resolver, alias /
#       node_id filters, degraded passthrough) unchanged.
#   L2  measurement (printed, not gated — CI runners are too noisy for a CPU threshold): 306 synthetic
#       sessions, the old agent-node alias-resolver read (ntok + Accept: application/json + node's default
#       Accept-Encoding: gzip, deflate, no If-None-Match) at production's read:write ratio; full reads; a
#       client that sends If-None-Match. Gated only on "the cache is used" (hits > 0).
#   L3  witnessed red: each mutation must turn L1 red, for the named test.
#       #500 step 2: the full projection carries queue_depth (tasks table), so writes to `tasks` also invalidate
#       the full body — task-queue-ahead-http.test.ts joins L1 and its tasks-write invalidation is mutated too.
#       Follow-up: task-queue-ahead-scale.test.ts (57k tasks) pins the queue_depth plan off idx_tasks_status.
#
# Throwaway everything: HOME=$(mktemp -d), temp SQLite, port 0 (never 9200).
set -euo pipefail
cd /work/server
echo "source_commit=${SOURCE_COMMIT:-unknown}"

run_tests() {
  local h; h="$(mktemp -d)"
  HOME="$h" COMMHUB_DB="$h/hub.db" bun test "$@"
}

echo "== L1 cached == recomputed; existing /api/status suites unchanged"
for f in src/status-read-cache-http.test.ts src/status-alias-resolver-http.test.ts src/status-alias-filter-http.test.ts \
         src/status-node-id-filter-http.test.ts src/node-health-dispatch-http.test.ts src/http-gzip.test.ts src/requirements-etag-http.test.ts \
         src/task-queue-ahead-http.test.ts src/task-queue-ahead-scale.test.ts; do
  run_tests "$f"
done

echo "== L2 measurement (306 sessions)"
h="$(mktemp -d)"
out="$(HOME="$h" COMMHUB_DB="$h/hub.db" SERVER_SRC=/work/server/src bun /work/tests/test-status-read-cache/bench.ts)"
printf '%s\n' "$out" | sed -n '/^{/,$p'
json="$(printf '%s\n' "$out" | sed -n '/^{/,$p')"
hits="$(printf '%s' "$json" | bun -e 'const j=JSON.parse(await Bun.stdin.text());console.log(j.cache?.hits ?? 0)')"
[ "$hits" -gt 0 ] || { echo "FAIL: the status cache was never hit"; exit 1; }

expect_red() {
  local label=$1 file=$2 test_name=$3 out rc=0
  out="$(run_tests "$file" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then echo "MUTATION_FALSE_GREEN: $label"; exit 1; fi
  if ! printf '%s\n' "$out" | grep -Fq "(fail) $test_name"; then
    echo "MUTATION_RED_FOR_THE_WRONG_REASON: $label (wanted a failure in: $test_name)"
    printf '%s\n' "$out" | grep -E '^\((pass|fail)\)|^error:' | head -20
    exit 1
  fi
  echo "MUTATION_RED: $label"
}

echo "== L3 witnessed red"
cp src/status-read-cache.ts /tmp/cache.ts
bun /work/tests/mutate.ts src/status-read-cache.ts \
  'if (SESSIONS_WORD.test(sql)) sessionsWriteGen++;' \
  'if (false) sessionsWriteGen++;'
expect_red writes-never-invalidate src/status-read-cache-http.test.ts \
  'GET /api/status bodies are byte-identical with the cache > random writes / health reports / expiry: cached == recomputed, and the cache is really used'
cp /tmp/cache.ts src/status-read-cache.ts

bun /work/tests/mutate.ts src/status-read-cache.ts 'hit.taskGen === taskGen && hit.healthVer === healthVer &&' 'hit.taskGen === taskGen &&'
expect_red health-reports-never-invalidate src/status-read-cache-http.test.ts \
  'GET /api/status bodies are byte-identical with the cache > random writes / health reports / expiry: cached == recomputed, and the cache is really used'
cp /tmp/cache.ts src/status-read-cache.ts

bun /work/tests/mutate.ts src/status-read-cache.ts '&& now < hit.validUntil' ''
expect_red health-expiry-ignored src/status-read-cache-http.test.ts \
  'GET /api/status bodies are byte-identical with the cache > a health report expiring (no write at all) invalidates the cached body on time'
cp /tmp/cache.ts src/status-read-cache.ts

cp src/server.ts /tmp/server.ts
bun /work/tests/mutate.ts src/server.ts \
  'return { body: JSON.stringify({ ok: true, sessions, summary }), cacheable: !timeDependent };' \
  'return { body: JSON.stringify({ ok: true, sessions, summary }), cacheable: true };'
expect_red time-dependent-body-cached src/status-read-cache-http.test.ts \
  'GET /api/status bodies are byte-identical with the cache > full projection with a health report is not cached (its body moves with time)'
cp /tmp/server.ts src/server.ts

# #500 step 2 — a write that touches only `tasks` must invalidate the cached full body (queue_depth moves).
TASKS_INVALIDATION='#500 queue_depth on status reads > a write that touches only tasks invalidates the cached full body (new ETag, new queue_depth); light stays cached'
bun /work/tests/mutate.ts src/status-read-cache.ts 'if (TASKS_WORD.test(sql)) tasksWriteGen++;' 'if (false) tasksWriteGen++;'
expect_red tasks-writes-never-counted src/task-queue-ahead-http.test.ts "$TASKS_INVALIDATION"
cp /tmp/cache.ts src/status-read-cache.ts

bun /work/tests/mutate.ts src/status-read-cache.ts 'hit.taskGen === taskGen && ' ''
expect_red tasks-generation-not-compared src/task-queue-ahead-http.test.ts "$TASKS_INVALIDATION"
cp /tmp/cache.ts src/status-read-cache.ts

bun /work/tests/mutate.ts src/server.ts '}, Date.now(), { dependsOnTasks: !isLight });' '}, Date.now(), { dependsOnTasks: false });'
expect_red full-projection-ignores-tasks src/task-queue-ahead-http.test.ts "$TASKS_INVALIDATION"
cp /tmp/server.ts src/server.ts

# #500 follow-up — at production scale (57k tasks, 31k stuck acked) queue_depth must not go through idx_tasks_status.
# Removing the index hint from the filter must turn the plan assertion (and the cost budget) red.
cp src/task-queue-ahead.ts /tmp/tqa.ts
bun /work/tests/mutate.ts src/task-queue-ahead.ts "WHERE (status || '') IN" "WHERE status IN"
expect_red queue-depth-uses-status-index src/task-queue-ahead-scale.test.ts \
  '#500 queue_depth at production scale (57k tasks, 31k stuck acked) > plans: never idx_tasks_status; whole table via idx_tasks_created, alias list and per-send via idx_tasks_to_created'
cp /tmp/tqa.ts src/task-queue-ahead.ts

echo "PASS test-status-read-cache"

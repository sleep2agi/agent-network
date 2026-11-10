#!/usr/bin/env bash
set -euo pipefail
cd /work/server
test -f /.dockerenv
unset DATABASE_URL COMMHUB_TEST_PG_URL
echo "source_commit=$SOURCE_COMMIT"
run_case() {
  local backend="$1" case_name="$2" fixture_dir
  fixture_dir=$(mktemp -d /tmp/activity1113.XXXXXX)
  if [[ "$backend" == pg ]]; then
    local db_name="anet_1113_${case_name}_test"
    runuser -u postgres -- "$pg_bin/createdb" -h "$pg_socket" -p 25513 -O clock_tester "$db_name"
    export COMMHUB_TEST_PG_URL="postgres://clock_tester:$fixture_password@127.0.0.1:25513/$db_name"
  fi
  echo "CASE $backend $case_name"
  if [[ "$case_name" == green ]]; then
    # The existing terminal suite injects SQLite-only triggers; keep its supported backend.
    terminal_suite=()
    if [[ "$backend" == sqlite ]]; then terminal_suite=(src/scheduled-run-terminal.test.ts); fi
    env HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 bun test src/scheduled-stuck-http.test.ts src/scheduled-tasks-http.test.ts src/task-consumption.test.ts src/node-caller-identity-http.test.ts "${terminal_suite[@]}"
  else
    cp src/task-activity.ts /tmp/activity1113-helper.ts
    cp src/scheduled-stuck.ts /tmp/activity1113-clock.ts
    case "$case_name" in
      context)
        sed -i 's/if (row.thread_id !== context.thread_id || row.turn_id !== context.turn_id)/if (false \&\& (row.thread_id !== context.thread_id || row.turn_id !== context.turn_id))/' src/task-activity.ts
        sed -i 's/AND thread_id = ?4 AND turn_id = ?5/AND CAST(?4 AS TEXT) IS NOT NULL AND CAST(?5 AS TEXT) IS NOT NULL/' src/task-activity.ts
        file=src/node-caller-identity-http.test.ts; pattern='activity lease: rejects wrong';;
      terminal)
        sed -i 's/if (!\["created", "delivered", "acked", "running"\].includes(row.status))/if (false \&\& !["created", "delivered", "acked", "running"].includes(row.status))/' src/task-activity.ts
        sed -i "s/AND status IN ('created', 'delivered', 'acked', 'running')/AND status IS NOT NULL/" src/task-activity.ts
        file=src/node-caller-identity-http.test.ts; pattern='terminal never receives';;
      owner)
        sed -i 's/!row || row.to_node_id !== caller.nodeId/!row || false/' src/task-activity.ts
        sed -i 's/AND to_node_id = ?3/AND CAST(?3 AS TEXT) IS NOT NULL/' src/task-activity.ts
        file=src/node-caller-identity-http.test.ts; pattern='bound node wins|activity lease: rejects foreign node|legacy null node';;
      idle)
        sed -i 's/if (source === "consumed_at" \&\& blocker.last_activity_at)/if (false \&\& source === "consumed_at" \&\& blocker.last_activity_at)/' src/scheduled-stuck.ts
        file=src/scheduled-stuck-http.test.ts; pattern='fresh exact-task activity protects';;
      cap)
        sed -i 's/if (Number.isFinite(created) \&\& nowMs - created >= capMs)/if (false \&\& Number.isFinite(created) \&\& nowMs - created >= capMs)/' src/scheduled-stuck.ts
        file=src/scheduled-stuck-http.test.ts; pattern='fresh activity cannot evade';;
    esac
    set +e
    env HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 bun test "$file" -t "$pattern" >/tmp/activity1113-red.log 2>&1
    rc=$?
    set -e
    cp /tmp/activity1113-helper.ts src/task-activity.ts
    cp /tmp/activity1113-clock.ts src/scheduled-stuck.ts
    if [[ "$rc" == 0 ]] || ! grep -q 'expect(received)' /tmp/activity1113-red.log; then cat /tmp/activity1113-red.log; echo "MUTATION_INVALID $backend $case_name"; exit 1; fi
    echo "MUTATION_ASSERTION_RED $backend $case_name"
  fi
}
for case_name in ${ACTIVITY_CASES:-green context terminal owner idle cap}; do run_case sqlite "$case_name"; done
echo 'RESULT sqlite PASS'
pg_bin=$(find /usr/lib/postgresql -name initdb -printf '%h\n' | sort -V | tail -1)
pg_root=$(mktemp -d /tmp/activity1113-pg.XXXXXX)
chmod 755 "$pg_root"
pg_data="$pg_root/data"; pg_socket="$pg_root/socket"
install -d -o postgres -g postgres "$pg_data" "$pg_socket"
trap 'runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -m immediate stop >/dev/null 2>&1 || true' EXIT
runuser -u postgres -- "$pg_bin/initdb" -D "$pg_data" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -l "$pg_socket/log" -o "-p 25513 -k $pg_socket -c listen_addresses=127.0.0.1" -w start >/dev/null
fixture_password="fixture-$(od -An -tx8 -N8 /dev/urandom | tr -d ' ')"
runuser -u postgres -- "$pg_bin/psql" -h "$pg_socket" -p 25513 -c "CREATE ROLE clock_tester LOGIN PASSWORD '$fixture_password'" >/dev/null
for case_name in ${ACTIVITY_CASES:-green context terminal owner idle cap}; do run_case pg "$case_name"; done
echo 'RESULT postgres PASS'

unset COMMHUB_TEST_PG_URL DATABASE_URL
cd /work
bun test agent-node/src/task-runtime-evidence.test.ts agent-node/src/runtime/codex-app-server/runtime.test.ts agent-network/src/opencode-agent-node-pair.test.ts agent-network/src/package-version-consistency.test.ts agent-node/src/package-version-consistency.test.ts
cp agent-node/src/task-runtime-evidence.ts /tmp/activity1113-reporter.ts
sed -i 's/if (!opts.taskId || !opts.reportActivity || !consumedContext || activityInFlight)/if (true || !opts.taskId || !opts.reportActivity || !consumedContext || activityInFlight)/' agent-node/src/task-runtime-evidence.ts
set +e
bun test agent-node/src/task-runtime-evidence.test.ts -t 'exact task activity lease reporter' >/tmp/activity1113-reporter-red.log 2>&1
rc=$?
set -e
cp /tmp/activity1113-reporter.ts agent-node/src/task-runtime-evidence.ts
if [[ "$rc" == 0 ]] || ! grep -q 'expect(received)' /tmp/activity1113-reporter-red.log; then cat /tmp/activity1113-reporter-red.log; echo 'MUTATION_INVALID runtime reporter'; exit 1; fi
echo 'MUTATION_ASSERTION_RED runtime reporter'
echo 'RESULT all PASS'

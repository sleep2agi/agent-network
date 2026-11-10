#!/usr/bin/env bash
set -euo pipefail
cd /work/server
test -f /.dockerenv
unset DATABASE_URL COMMHUB_TEST_PG_URL
echo "source_commit=$SOURCE_COMMIT"
run_case() {
  local backend="$1" case_name="$2" fixture_dir
  fixture_dir=$(mktemp -d /tmp/clock1112.XXXXXX)
  if [[ "$backend" == pg ]]; then
    local db_name="anet_1112_${case_name}_test"
    runuser -u postgres -- "$pg_bin/createdb" -h "$pg_socket" -p 25512 -O clock_tester "$db_name"
    export COMMHUB_TEST_PG_URL="postgres://clock_tester:$fixture_password@127.0.0.1:25512/$db_name"
  fi
  echo "CASE $backend $case_name"
  if [[ "$case_name" == green ]]; then
    # The existing terminal suite injects SQLite-only triggers; keep its supported backend.
    terminal_suite=()
    if [[ "$backend" == sqlite ]]; then terminal_suite=(src/scheduled-run-terminal.test.ts); fi
    env HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 bun test src/scheduled-stuck-http.test.ts src/scheduled-tasks-http.test.ts "${terminal_suite[@]}"
  else
    cp src/scheduled-stuck.ts /tmp/clock1112-original.ts
    if [[ "$case_name" == creation ]]; then
      sed -i 's/blockerTimeoutClock(blocker, scheduleJson, now)/blockerTimeoutClock({ created_at: blocker.created_at }, scheduleJson, now)/' src/scheduled-stuck.ts
      pattern="queue budget"
    else
      sed -i 's/if (Number.isFinite(created) \&\& nowMs - created >= capMs)/if (false \&\& Number.isFinite(created) \&\& nowMs - created >= capMs)/' src/scheduled-stuck.ts
      pattern="total cap:"
    fi
    ! cmp -s src/scheduled-stuck.ts /tmp/clock1112-original.ts
    set +e
    env HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 bun test src/scheduled-stuck-http.test.ts -t "$pattern" >/tmp/clock1112-red.log 2>&1
    rc=$?
    set -e
    cp /tmp/clock1112-original.ts src/scheduled-stuck.ts
    if [[ "$rc" == 0 ]] || ! grep -q 'expect(received)' /tmp/clock1112-red.log; then
      cat /tmp/clock1112-red.log
      echo "MUTATION_INVALID $backend $case_name"; exit 1
    fi
    echo "MUTATION_ASSERTION_RED $backend $case_name"
  fi
}
for case_name in ${CLOCK_CASES:-green creation cap}; do run_case sqlite "$case_name"; done
echo 'RESULT sqlite PASS'
pg_bin=$(find /usr/lib/postgresql -name initdb -printf '%h\n' | sort -V | tail -1)
pg_root=$(mktemp -d /tmp/clock1112-pg.XXXXXX)
chmod 755 "$pg_root"
pg_data="$pg_root/data"; pg_socket="$pg_root/socket"
install -d -o postgres -g postgres "$pg_data" "$pg_socket"
trap 'runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -m immediate stop >/dev/null 2>&1 || true' EXIT
runuser -u postgres -- "$pg_bin/initdb" -D "$pg_data" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -l "$pg_socket/log" -o "-p 25512 -k $pg_socket -c listen_addresses=127.0.0.1" -w start >/dev/null
fixture_password="fixture-$(od -An -tx8 -N8 /dev/urandom | tr -d ' ')"
runuser -u postgres -- "$pg_bin/psql" -h "$pg_socket" -p 25512 -c "CREATE ROLE clock_tester LOGIN PASSWORD '$fixture_password'" >/dev/null
for case_name in ${CLOCK_CASES:-green creation cap}; do run_case pg "$case_name"; done
echo 'RESULT postgres PASS'

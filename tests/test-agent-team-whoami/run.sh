#!/usr/bin/env bash
set -euo pipefail
test -f /.dockerenv
cd /work/server
unset DATABASE_URL COMMHUB_TEST_PG_URL
echo "source_commit=${SOURCE_COMMIT:-unknown}"
run_case() {
  local backend="$1" case_name="$2" fixture_dir
  fixture_dir=$(mktemp -d /tmp/team-whoami.XXXXXX)
  if [[ "$backend" == pg ]]; then
    local db_name="anet_team_whoami_${case_name}_test"
    runuser -u postgres -- "$pg_bin/createdb" -h "$pg_socket" -p 25435 -O team_tester "$db_name"
    export COMMHUB_TEST_PG_URL="postgres://team_tester:$fixture_password@127.0.0.1:25435/$db_name"
  fi
  echo "CASE $backend $case_name"
  if [[ "$case_name" == green ]]; then
    env COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 bun test src/agent-team-whoami-http.test.ts
  else
    env COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 MUTATION_CASE="$case_name" bun /work/tests/test-agent-team-whoami/mutations.ts
  fi
}
for c in green identity network bound cap; do run_case sqlite "$c"; done
echo 'RESULT sqlite PASS'
pg_bin=$(find /usr/lib/postgresql -name initdb -printf '%h\n' | sort -V | tail -1)
pg_root=$(mktemp -d /tmp/team-whoami-pg.XXXXXX)
chmod 755 "$pg_root"
pg_data="$pg_root/data"; pg_socket="$pg_root/socket"
install -d -o postgres -g postgres "$pg_data" "$pg_socket"
trap 'runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -m immediate stop >/dev/null 2>&1 || true' EXIT
runuser -u postgres -- "$pg_bin/initdb" -D "$pg_data" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -l "$pg_socket/log" -o "-p 25435 -k $pg_socket -c listen_addresses=127.0.0.1" -w start >/dev/null
fixture_password="fixture-$(od -An -tx8 -N8 /dev/urandom | tr -d ' ')"
runuser -u postgres -- "$pg_bin/psql" -h "$pg_socket" -p 25435 -c "CREATE ROLE team_tester LOGIN PASSWORD '$fixture_password'" >/dev/null
for c in green identity network bound cap; do run_case pg "$c"; done
echo 'RESULT postgres PASS'

#!/usr/bin/env bash
set -euo pipefail
cd /work/server
test -f /.dockerenv
unset DATABASE_URL COMMHUB_TEST_PG_URL
echo "source_commit=$SOURCE_COMMIT"
run_case() {
  local backend="$1" case_name="$2" fixture_dir
  fixture_dir=$(mktemp -d /tmp/tag1091.XXXXXX)
  if [[ "$backend" == pg ]]; then
    local db_name="anet_1091_${case_name}_test"
    runuser -u postgres -- "$pg_bin/createdb" -h "$pg_socket" -p 25191 -O session_tester "$db_name"
    export COMMHUB_TEST_PG_URL="postgres://session_tester:$fixture_password@127.0.0.1:25191/$db_name"
  fi
  echo "CASE $backend $case_name"
  env HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 bun test src/requirements-stats-http.test.ts

}
for case_name in green; do run_case sqlite "$case_name"; done
echo 'RESULT sqlite PASS'
pg_bin=$(find /usr/lib/postgresql -name initdb -printf '%h\n' | sort -V | tail -1)
pg_root=$(mktemp -d /tmp/tag1091-pg.XXXXXX)
chmod 755 "$pg_root"
pg_data="$pg_root/data"; pg_socket="$pg_root/socket"
install -d -o postgres -g postgres "$pg_data" "$pg_socket"
trap 'runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -m immediate stop >/dev/null 2>&1 || true' EXIT
runuser -u postgres -- "$pg_bin/initdb" -D "$pg_data" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -l "$pg_socket/log" -o "-p 25191 -k $pg_socket -c listen_addresses=127.0.0.1" -w start >/dev/null
fixture_password="fixture-$(od -An -tx8 -N8 /dev/urandom | tr -d ' ')"
runuser -u postgres -- "$pg_bin/psql" -h "$pg_socket" -p 25191 -c "CREATE ROLE session_tester LOGIN PASSWORD '$fixture_password'" >/dev/null
for case_name in green; do run_case pg "$case_name"; done
echo 'RESULT postgres PASS'

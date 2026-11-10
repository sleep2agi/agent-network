#!/usr/bin/env bash
set -euo pipefail
cd /work/server
test -f /.dockerenv
unset DATABASE_URL COMMHUB_TEST_PG_URL
echo "source_commit=$SOURCE_COMMIT"
run_case() {
  local backend="$1" case_name="$2" fixture_dir
  fixture_dir=$(mktemp -d /tmp/password717.XXXXXX)
  if [[ "$backend" == pg ]]; then
    local db_name="anet_717_${case_name}_test"
    runuser -u postgres -- "$pg_bin/createdb" -h "$pg_socket" -p 25717 -O session_tester "$db_name"
    export COMMHUB_TEST_PG_URL="postgres://session_tester:$fixture_password@127.0.0.1:25717/$db_name"
  fi
  echo "CASE $backend $case_name"
  if [[ "$case_name" == green ]]; then
    env HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 bun test src/auth-password-change-cli-tokens-http.test.ts
  else
    cp src/password-network-tokens.ts /tmp/pw717-helper.ts
    cp src/auth.ts /tmp/pw717-auth.ts
    cp src/server.ts /tmp/pw717-server.ts
    case "$case_name" in
      owner)
        sed -i 's/user_id = ?1 AND network_id/CAST(?1 AS TEXT) IS NOT NULL AND network_id/' src/password-network-tokens.ts
        pattern="explicit boolean opt-in";;
      scope)
        sed -i "s/ AND scope = 'full'//" src/password-network-tokens.ts
        pattern="scope and binding protect";;
      strict)
        sed -i 's/body.revoke_network_tokens === true/!!body.revoke_network_tokens/' src/server.ts
        pattern="non-true option";;
      atomic)
        python3 - <<'MUT'
from pathlib import Path
p=Path('src/auth.ts');s=p.read_text()
a='const nextHash = hashPassword(newPassword);\n  return db.transaction(() => {';b="  });\n}\n\n/**\n * #261 P0-2"
assert s.count(a)==1 and s.count(b)==1
s=s.replace(a,'const nextHash = hashPassword(newPassword);\n  return (() => {').replace(b,"  })();\n}\n\n/**\n * #261 P0-2")
p.write_text(s)
MUT
        pattern="a failed network revoke rolls back";;
    esac
    set +e
    env HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 bun test src/auth-password-change-cli-tokens-http.test.ts -t "$pattern" >/tmp/password717-red.log 2>&1
    rc=$?
    set -e
    cp /tmp/pw717-helper.ts src/password-network-tokens.ts
    cp /tmp/pw717-auth.ts src/auth.ts
    cp /tmp/pw717-server.ts src/server.ts
    if [[ "$rc" == 0 ]] || ! grep -q 'expect(received)' /tmp/password717-red.log; then cat /tmp/password717-red.log; echo "MUTATION_INVALID $backend $case_name"; exit 1; fi
    echo "MUTATION_ASSERTION_RED $backend $case_name"
  fi
}
for case_name in green owner scope strict atomic; do run_case sqlite "$case_name"; done
echo 'RESULT sqlite PASS'
pg_bin=$(find /usr/lib/postgresql -name initdb -printf '%h\n' | sort -V | tail -1)
pg_root=$(mktemp -d /tmp/password717-pg.XXXXXX)
chmod 755 "$pg_root"
pg_data="$pg_root/data"; pg_socket="$pg_root/socket"
install -d -o postgres -g postgres "$pg_data" "$pg_socket"
trap 'runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -m immediate stop >/dev/null 2>&1 || true' EXIT
runuser -u postgres -- "$pg_bin/initdb" -D "$pg_data" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -l "$pg_socket/log" -o "-p 25717 -k $pg_socket -c listen_addresses=127.0.0.1" -w start >/dev/null
fixture_password="fixture-$(od -An -tx8 -N8 /dev/urandom | tr -d ' ')"
runuser -u postgres -- "$pg_bin/psql" -h "$pg_socket" -p 25717 -c "CREATE ROLE session_tester LOGIN PASSWORD '$fixture_password'" >/dev/null
for case_name in green owner scope strict atomic; do run_case pg "$case_name"; done
echo 'RESULT postgres PASS'

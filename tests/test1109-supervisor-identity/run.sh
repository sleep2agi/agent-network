#!/usr/bin/env bash
set -euo pipefail
cd /work/server
test -f /.dockerenv
unset DATABASE_URL COMMHUB_TEST_PG_URL
echo "source_commit=$SOURCE_COMMIT"
run_case() {
  local backend="$1" suite="$2" fixture_dir db_name rc=0
  fixture_dir=$(mktemp -d /tmp/supervisor1109.XXXXXX)
  if [[ "$backend" == pg ]]; then
    db_name="anet_1109_${suite}_test"
    runuser -u postgres -- "$pg_bin/createdb" -h "$pg_socket" -p 25109 -O session_tester "$db_name"
    export COMMHUB_TEST_PG_URL="postgres://session_tester:$fixture_password@127.0.0.1:25109/$db_name"
  fi
  echo "CASE $backend $suite"
  case "$suite" in
    identity|token_red|heartbeat_red)
      env NODE_ENV=test HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 bun run /work/tests/test1109-supervisor-identity/seed-legacy.ts ;;
  esac
  case "$suite" in
    identity) file=src/host-supervisor-identity-http.test.ts ;;
    legacy) file=src/list-host-supervisors.test.ts ;;
    caller) file=src/node-caller-identity-http.test.ts ;;
    daemon) file=src/daemon-token-owner-http.test.ts ;;
    ambiguous_red)
      env HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 MUTATION_CASE=ambiguous bun run /work/tests/test678-daemon-token-owner/mutations.ts
      return ;;
    token_red|heartbeat_red)
      file=src/host-supervisor-identity-http.test.ts
      cp src/host-supervisor-identity.ts /tmp/supervisor1109-green.ts
      python3 - "$suite" <<'MUT'
from pathlib import Path
import sys
p=Path('src/host-supervisor-identity.ts');s=p.read_text()
if sys.argv[1]=='token_red':
    token_anchor='if (caller.ok && caller.kind === "node") credentialed.add(caller.nodeId);'
    assert s.count(token_anchor)==1
    p.write_text(s.replace(token_anchor,'for (const n of nodes) { if (n.network_id === t.network_id && n.alias === t.name.slice(5)) credentialed.add(n.node_id); }'))
else:
    heartbeat_anchor='node = byId.get(s.node_id);'
    assert s.count(heartbeat_anchor)==1
    p.write_text(s.replace(heartbeat_anchor,'node = (byAlias.get(key(s.network_id ?? "", s.alias)) ?? [])[0];'))
MUT
      if [[ "$suite" == token_red ]]; then pattern='same-name foreign binding'; else pattern='sibling heartbeat'; fi
      env HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 bun test "$file" -t "$pattern" >/tmp/supervisor1109-red.log 2>&1 || rc=$?
      cp /tmp/supervisor1109-green.ts src/host-supervisor-identity.ts
      if [[ "$rc" == 0 ]] || ! grep -q 'expect(received)' /tmp/supervisor1109-red.log; then cat /tmp/supervisor1109-red.log; echo "MUTATION_INVALID $backend $suite"; exit 1; fi
      echo "MUTATION_ASSERTION_RED $backend $suite"
      return ;;
  esac
  env HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/hub.db" COMMHUB_PG_EXPERIMENTAL=1 bun test "$file"
}
for suite in identity legacy caller daemon token_red heartbeat_red ambiguous_red; do run_case sqlite "$suite"; done
echo 'RESULT sqlite PASS'
pg_bin=$(find /usr/lib/postgresql -name initdb -printf '%h\n' | sort -V | tail -1)
pg_root=$(mktemp -d /tmp/supervisor1109-pg.XXXXXX)
chmod 755 "$pg_root"
pg_data="$pg_root/data"; pg_socket="$pg_root/socket"
install -d -o postgres -g postgres "$pg_data" "$pg_socket"
trap 'runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -m immediate stop >/dev/null 2>&1 || true' EXIT
runuser -u postgres -- "$pg_bin/initdb" -D "$pg_data" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
runuser -u postgres -- "$pg_bin/pg_ctl" -D "$pg_data" -l "$pg_socket/log" -o "-p 25109 -k $pg_socket -c listen_addresses=127.0.0.1" -w start >/dev/null
fixture_password="fixture-$(od -An -tx8 -N8 /dev/urandom | tr -d ' ')"
runuser -u postgres -- "$pg_bin/psql" -h "$pg_socket" -p 25109 -c "CREATE ROLE session_tester LOGIN PASSWORD '$fixture_password'" >/dev/null
for suite in identity legacy caller daemon token_red heartbeat_red ambiguous_red; do run_case pg "$suite"; done
echo 'RESULT postgres PASS'

#!/usr/bin/env bash
set -euo pipefail

cd /work
echo "source_commit=$TEST637_SOURCE_COMMIT"
port=25435
probe_dir="$(mktemp -d /tmp/test637-probe.XXXXXX)"
ready="$probe_dir/ready"
accepted="$probe_dir/accepted"

bun tests/test637-database-url-guard/tcp-listener.ts "$port" "$ready" "$accepted" &
listener_pid=$!
for _ in $(seq 1 100); do
  test -e "$ready" && break
  kill -0 "$listener_pid" 2>/dev/null || { echo "listener exited" >&2; exit 1; }
  sleep 0.02
done
test -e "$ready"

run_probe() {
  local module_path="$1" prefix="$2"
  set +e
  env -u COMMHUB_DB \
    NODE_ENV=test \
    DATABASE_URL="postgres://user:pw@127.0.0.1:${port}/commhub?connect_timeout=1" \
    DB_ADAPTER_MODULE="$module_path" \
    timeout 10 strace -f -e trace=connect -o "$prefix.strace" \
      bun tests/test637-database-url-guard/probe.ts \
      >"$prefix.stdout" 2>"$prefix.stderr"
  probe_rc=$?
  set -e
  test "$probe_rc" -ne 0
}

if [ "${TEST637_EXPECT_RED:-0}" = 1 ]; then
  run_probe /work/server/src/db-adapter.ts "$probe_dir/base"
  grep -q 'database: PostgreSQL' "$probe_dir/base.stdout"
  grep -Eq "sin_port=htons\(${port}\)" "$probe_dir/base.strace"
  test -s "$accepted"
  ! grep -q 'REFUSING to honor inherited DATABASE_URL' "$probe_dir/base.stderr"
  echo "WITNESSED_RED: current main attempted a real TCP connect before its test guard"
  kill "$listener_pid" 2>/dev/null || true
  wait "$listener_pid" 2>/dev/null || true
  echo "RESULT: EXPECTED RED"
  exit 0
fi

echo "L0 pure guard and target-selection tests"
bun test server/src/db-adapter-guard.test.ts

echo "L1 real subprocess syscall gate"
run_probe /work/server/src/db-adapter.ts "$probe_dir/green"
grep -q 'REFUSING to honor inherited DATABASE_URL' "$probe_dir/green.stderr"
! grep -q 'database: PostgreSQL' "$probe_dir/green.stdout"
! grep -Eq "sin_port=htons\(${port}\)" "$probe_dir/green.strace"
test ! -e "$accepted"

echo "L2 delete-guard mutation"
mutation_dir="$(mktemp -d /tmp/test637-mutation.XXXXXX)"
cp server/src/db-adapter.ts "$mutation_dir/db-adapter.ts"
sed -i '/assertSafeTestDatabaseEnv(process.env);/d' "$mutation_dir/db-adapter.ts"
run_probe "$mutation_dir/db-adapter.ts" "$probe_dir/mutation"
grep -q 'database: PostgreSQL' "$probe_dir/mutation.stdout"
grep -Eq "sin_port=htons\(${port}\)" "$probe_dir/mutation.strace"
test -s "$accepted"
! grep -q 'REFUSING to honor inherited DATABASE_URL' "$probe_dir/mutation.stderr"
echo "MUTATION_RED: deleting the earliest guard produced a real connect"

kill "$listener_pid" 2>/dev/null || true
wait "$listener_pid" 2>/dev/null || true
echo "RESULT: PASS"

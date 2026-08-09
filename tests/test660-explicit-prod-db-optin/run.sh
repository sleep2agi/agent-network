#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/repo
ART=/artifacts
PASS=0
FAIL=0
mkdir -p "$ART"

ok(){ PASS=$((PASS+1)); printf 'PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }
expect_red(){
  local name="$1"; shift
  if "$@" >"$ART/$name.log" 2>&1; then bad "mutation $name stayed green"; else ok "mutation $name witnessed red"; fi
}

wait_health(){
  local port="$1"
  for _ in $(seq 1 100); do
    if PORT_TO_CHECK="$port" bun -e 'const r=await fetch(`http://127.0.0.1:${process.env.PORT_TO_CHECK}/health`).catch(()=>null); process.exit(r?.ok?0:1)' >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}

printf 'source_commit=%s\n' "${TEST660_SOURCE_COMMIT:-unknown}"
cd "$ROOT"

bun test server/src/db-adapter-guard.test.ts
ok "pure default-path capability contract"

probe_home=$(mktemp -d /tmp/test660-probe-home.XXXXXX)
set +e
env -u COMMHUB_DB -u DATABASE_URL -u COMMHUB_SERVER HOME="$probe_home" \
  bun -e 'const {createAdapter}=await import("./server/src/db-adapter.ts"); createAdapter()' \
  >"$ART/unflagged.stdout" 2>"$ART/unflagged.stderr"
probe_rc=$?
set -e
test "$probe_rc" -ne 0
grep -F 'REFUSING to open the default production SQLite database' "$ART/unflagged.stderr" >/dev/null
test ! -e "$probe_home/.commhub/commhub.db"
ok "real bun -e fails before creating the production-default DB"

explicit_db=$(mktemp /tmp/test660-explicit.XXXXXX.db)
env -u DATABASE_URL -u COMMHUB_SERVER COMMHUB_DB="$explicit_db" \
  bun -e 'const {createAdapter}=await import("./server/src/db-adapter.ts"); const db=createAdapter(); db.close()'
test -s "$explicit_db"
ok "explicit SQLite path remains available to scripts"

index_home=$(mktemp -d /tmp/test660-index-home.XXXXXX)
env -u COMMHUB_DB -u DATABASE_URL -u COMMHUB_SERVER \
  HOME="$index_home" PORT=25660 HOST=127.0.0.1 COMMHUB_DEV_OPEN=1 \
  bun run server/src/index.ts >"$ART/index.log" 2>&1 &
index_pid=$!
wait_health 25660
test -s "$index_home/.commhub/commhub.db"
kill "$index_pid"
wait "$index_pid" 2>/dev/null || true
ok "canonical src/index.ts opts into the default DB before import"

bin_home=$(mktemp -d /tmp/test660-bin-home.XXXXXX)
env -u COMMHUB_DB -u DATABASE_URL -u COMMHUB_SERVER \
  HOME="$bin_home" bun server/bin/commhub.ts --port 25661 --host 127.0.0.1 --dev-open \
  >"$ART/bin.log" 2>&1 &
bin_pid=$!
wait_health 25661
test -s "$bin_home/.commhub/commhub.db"
kill "$bin_pid"
wait "$bin_pid" 2>/dev/null || true
ok "packaged commhub bin opts into the default DB before import"

cp server/src/db-adapter.ts /tmp/test660-db-adapter.orig
sed -i 's/if (!env.COMMHUB_DB && env.COMMHUB_SERVER !== "1") {/if (false) {/' server/src/db-adapter.ts
grep -F 'if (false) {' server/src/db-adapter.ts >/dev/null
expect_red remove-default-path-guard bash -c '
  mutation_home=$(mktemp -d /tmp/test660-mutation-home.XXXXXX)
  env -u COMMHUB_DB -u DATABASE_URL -u COMMHUB_SERVER HOME="$mutation_home" \
    bun -e '\''const {createAdapter}=await import("./server/src/db-adapter.ts"); const db=createAdapter(); db.close()'\'' >/dev/null 2>&1
  test ! -e "$mutation_home/.commhub/commhub.db"
'
cp /tmp/test660-db-adapter.orig server/src/db-adapter.ts

cp server/src/index.ts /tmp/test660-index.orig
sed -i 's/process.env.COMMHUB_SERVER = "1";/\/\/ mutation: server capability removed/' server/src/index.ts
expect_red remove-index-optin bash -c '
  mutation_home=$(mktemp -d /tmp/test660-index-mutation.XXXXXX)
  env -u COMMHUB_DB -u DATABASE_URL -u COMMHUB_SERVER HOME="$mutation_home" PORT=25662 HOST=127.0.0.1 COMMHUB_DEV_OPEN=1 \
    bun run server/src/index.ts > /tmp/test660-index-mutation.log 2>&1 &
  mutation_pid=$!
  for _ in $(seq 1 60); do
    kill -0 "$mutation_pid" 2>/dev/null || exit 1
    if PORT_TO_CHECK=25662 bun -e '\''const r=await fetch(`http://127.0.0.1:${process.env.PORT_TO_CHECK}/health`).catch(()=>null); process.exit(r?.ok?0:1)'\'' >/dev/null 2>&1; then
      kill "$mutation_pid"; wait "$mutation_pid" 2>/dev/null || true; exit 0
    fi
    sleep 0.05
  done
  kill "$mutation_pid" 2>/dev/null || true
  wait "$mutation_pid" 2>/dev/null || true
  exit 1
'
cp /tmp/test660-index.orig server/src/index.ts

cp server/bin/commhub.ts /tmp/test660-bin.orig
sed -i 's/process.env.COMMHUB_SERVER = "1";/\/\/ mutation: server capability removed/' server/bin/commhub.ts
expect_red remove-bin-optin bash -c '
  mutation_home=$(mktemp -d /tmp/test660-bin-mutation.XXXXXX)
  env -u COMMHUB_DB -u DATABASE_URL -u COMMHUB_SERVER HOME="$mutation_home" \
    bun server/bin/commhub.ts --port 25663 --host 127.0.0.1 --dev-open > /tmp/test660-bin-mutation.log 2>&1 &
  mutation_pid=$!
  for _ in $(seq 1 60); do
    kill -0 "$mutation_pid" 2>/dev/null || exit 1
    if PORT_TO_CHECK=25663 bun -e '\''const r=await fetch(`http://127.0.0.1:${process.env.PORT_TO_CHECK}/health`).catch(()=>null); process.exit(r?.ok?0:1)'\'' >/dev/null 2>&1; then
      kill "$mutation_pid"; wait "$mutation_pid" 2>/dev/null || true; exit 0
    fi
    sleep 0.05
  done
  kill "$mutation_pid" 2>/dev/null || true
  wait "$mutation_pid" 2>/dev/null || true
  exit 1
'
cp /tmp/test660-bin.orig server/bin/commhub.ts

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]

#!/usr/bin/env bash
set -euo pipefail

source /workspace/tests/lib/safe-rm.sh

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test649-token-cli.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1
cd /workspace

echo "# test649 — token CLI argument and audit output"
echo "source_commit=${TEST649_SOURCE_COMMIT:-unknown}"
echo "bun=$(bun --version)"
echo "date=$(date -Is)"

build_cli() {
  safe_rm_rf /tmp/test649-dist
  bun build agent-network/bin/cli.ts \
    --outdir /tmp/test649-dist \
    --entry-naming cli.js \
    --target node \
    --external @sleep2agi/commhub-server \
    --external bun:sqlite \
    --external '../../server/*' >/tmp/test649-build.log
  test -s /tmp/test649-dist/cli.js
}

WORK=$(mktemp -d /tmp/test649-home.XXXXXX)
trap 'kill "${hub_pid:-}" 2>/dev/null || true; safe_rm_rf "$WORK"' EXIT
mkdir -p "$WORK/.anet" "$WORK/cwd"
chmod 0700 "$WORK/.anet"
cat > "$WORK/.anet/config.json" <<'JSON'
{"hub":"http://127.0.0.1:19149","token":"utok_test649_local"}
JSON
chmod 0600 "$WORK/.anet/config.json"

: > /tmp/test649-hub.log
MOCK_LOG=/tmp/test649-hub.log bun tests/test649-token-cli/mock-hub.mjs >/tmp/test649-hub.stdout 2>&1 &
hub_pid=$!
for _ in $(seq 1 30); do
  grep -q '^READY ' /tmp/test649-hub.stdout 2>/dev/null && break
  sleep 0.1
done
grep -q '^READY 19149' /tmp/test649-hub.stdout

run_cli() {
  env -i PATH="$PATH" HOME="$WORK" LANG=C.UTF-8 \
    node /tmp/test649-dist/cli.js "$@"
}

echo "L0: pure parser contract"
cd /workspace/agent-network
bun test src/token-cli.test.ts
cd /workspace

echo "L1: production CLI build"
build_cli

echo "L2: real CLI create/list/help behavior"
: > /tmp/test649-hub.log
run_cli token create --name flag-name >/tmp/test649-create-flag.out
grep -Fq '"body":{"name":"flag-name"}' /tmp/test649-hub.log

run_cli token create --name=equals-name >/tmp/test649-create-equals.out
grep -Fq '"body":{"name":"equals-name"}' /tmp/test649-hub.log

run_cli token create legacy-name >/tmp/test649-create-positional.out
grep -Fq '"body":{"name":"legacy-name"}' /tmp/test649-hub.log

before=$(wc -l < /tmp/test649-hub.log)
for invalid in noargs missing unknown extra; do
  set +e
  case "$invalid" in
    noargs) run_cli token create >/tmp/test649-invalid.out 2>&1 ;;
    missing) run_cli token create --name >/tmp/test649-invalid.out 2>&1 ;;
    unknown) run_cli token create --role admin >/tmp/test649-invalid.out 2>&1 ;;
    extra) run_cli token create one two >/tmp/test649-invalid.out 2>&1 ;;
  esac
  rc=$?
  set -e
  test "$rc" -ne 0
  grep -Fq 'Usage: anet token create --name <name>' /tmp/test649-invalid.out
done
after=$(wc -l < /tmp/test649-hub.log)
test "$after" -eq "$before"

run_cli token ls >/tmp/test649-list.out
grep -Fq 'CREATED' /tmp/test649-list.out
grep -Fq '2026-08-09T01:02:03.000Z' /tmp/test649-list.out
grep -Fq '2026-08-09T04:05:06.000Z' /tmp/test649-list.out

before=$(wc -l < /tmp/test649-hub.log)
run_cli token help >/tmp/test649-help.out
grep -Fq 'create --name <name>' /tmp/test649-help.out
after=$(wc -l < /tmp/test649-hub.log)
test "$after" -eq "$before"

echo "L3 witnessed-red: restore silent no-argument default"
cp agent-network/src/token-cli.ts /tmp/test649-token-cli.ts
sed -i 's/return { ok: false, error: "token name is required" };/return { ok: true, name: "api-token" };/' agent-network/src/token-cli.ts
grep -Fq 'return { ok: true, name: "api-token" };' agent-network/src/token-cli.ts
set +e
cd /workspace/agent-network
bun test src/token-cli.test.ts >/tmp/test649-default-mutation.log 2>&1
default_rc=$?
cd /workspace
set -e
test "$default_rc" -ne 0
echo "MUTATION_RED: silent-default rc=$default_rc"
cp /tmp/test649-token-cli.ts agent-network/src/token-cli.ts

echo "L4 witnessed-red: bypass parsed flag name at the POST call site"
cp agent-network/bin/cli.ts /tmp/test649-cli.ts
sed -i 's/const name = createName!\.name;/const name = args[2] || "api-token";/' agent-network/bin/cli.ts
grep -Fq 'const name = args[2] || "api-token";' agent-network/bin/cli.ts
build_cli
: > /tmp/test649-hub.log
run_cli token create --name mutation-name >/tmp/test649-name-mutation.out
set +e
grep -Fq '"body":{"name":"mutation-name"}' /tmp/test649-hub.log
name_rc=$?
set -e
test "$name_rc" -ne 0
echo "MUTATION_RED: parsed-name-bypassed rc=$name_rc"
cp /tmp/test649-cli.ts agent-network/bin/cli.ts

echo "L5 witnessed-red: omit created_at from rendered list"
sed -i 's/(t.created_at || "?")\.padEnd(24)/"".padEnd(24)/' agent-network/bin/cli.ts
grep -Fq '"".padEnd(24)' agent-network/bin/cli.ts
build_cli
run_cli token ls >/tmp/test649-created-mutation.out
set +e
grep -Fq '2026-08-09T01:02:03.000Z' /tmp/test649-created-mutation.out
created_rc=$?
set -e
test "$created_rc" -ne 0
echo "MUTATION_RED: created-at-omitted rc=$created_rc"
cp /tmp/test649-cli.ts agent-network/bin/cli.ts

echo "L6 restored green"
cd /workspace/agent-network
bun test src/token-cli.test.ts
cd /workspace
build_cli
: > /tmp/test649-hub.log
run_cli token create --name restored-name >/tmp/test649-restored-create.out
grep -Fq '"body":{"name":"restored-name"}' /tmp/test649-hub.log
run_cli token ls >/tmp/test649-restored-list.out
grep -Fq '2026-08-09T01:02:03.000Z' /tmp/test649-restored-list.out

echo "RESULT: PASS"

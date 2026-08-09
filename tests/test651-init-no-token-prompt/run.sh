#!/usr/bin/env bash
set -euo pipefail

source /workspace/tests/lib/safe-rm.sh

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test651-init-no-token-prompt.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1
cd /workspace

echo "# test651 — anet init has no implicit legacy token prompt"
echo "source_commit=${TEST651_SOURCE_COMMIT:-unknown}"
echo "bun=$(bun --version)"
echo "date=$(date -Is)"

build_cli() {
  safe_rm_rf /tmp/test651-dist
  bun build agent-network/bin/cli.ts \
    --outdir /tmp/test651-dist \
    --entry-naming cli.js \
    --target node \
    --external @sleep2agi/commhub-server \
    --external bun:sqlite \
    --external '../../server/*' >/tmp/test651-build.log
  test -s /tmp/test651-dist/cli.js
}

WORK=$(mktemp -d /tmp/test651-home.XXXXXX)
trap 'kill "${hub_pid:-}" 2>/dev/null || true; safe_rm_rf "$WORK"' EXIT
mkdir -p "$WORK/default" "$WORK/explicit"

: > /tmp/test651-hub.log
MOCK_LOG=/tmp/test651-hub.log bun tests/test651-init-no-token-prompt/mock-hub.mjs >/tmp/test651-hub.stdout 2>&1 &
hub_pid=$!
for _ in $(seq 1 30); do
  grep -q '^READY 19151' /tmp/test651-hub.stdout 2>/dev/null && break
  sleep 0.1
done
grep -q '^READY 19151' /tmp/test651-hub.stdout

run_cli() {
  local home=$1
  shift
  env -i PATH="$PATH" HOME="$home" LANG=C.UTF-8 \
    node /tmp/test651-dist/cli.js "$@"
}

assert_default_no_prompt() {
  safe_rm_rf "$WORK/default"
  mkdir -p "$WORK/default"
  : > /tmp/test651-hub.log
  printf '\n' | run_cli "$WORK/default" init --hub http://127.0.0.1:19151 \
    >/tmp/test651-default.out 2>&1
  if grep -Fq 'Auth token' /tmp/test651-default.out; then
    echo "FAIL: default init still prompted for a legacy token"
    return 1
  fi
  grep -Fq '"authorization":null' /tmp/test651-hub.log
  test -s "$WORK/default/.anet/config.json"
  bun -e 'const c=JSON.parse(await Bun.file(process.argv[1]).text()); if(c.token!==undefined) process.exit(1)' \
    "$WORK/default/.anet/config.json"
}

assert_explicit_token_works() {
  safe_rm_rf "$WORK/explicit"
  mkdir -p "$WORK/explicit"
  : > /tmp/test651-hub.log
  run_cli "$WORK/explicit" init --hub http://127.0.0.1:19151 --token test651_legacy_secret \
    >/tmp/test651-explicit.out 2>&1
  grep -Fq '"authorization":"Bearer test651_legacy_secret"' /tmp/test651-hub.log
  bun -e 'const c=JSON.parse(await Bun.file(process.argv[1]).text()); if(c.token!=="test651_legacy_secret") process.exit(1)' \
    "$WORK/explicit/.anet/config.json"
}

echo "L0: production CLI build"
build_cli

echo "L1: default init makes one unauthenticated health request without prompting"
assert_default_no_prompt

echo "L2: explicit legacy --token remains supported"
assert_explicit_token_works

echo "L3 witnessed-red: restore the implicit token prompt"
cp agent-network/bin/cli.ts /tmp/test651-cli.ts
sed -i 's/const token = opts.token || "";/let token = opts.token || ""; if (!token) token = await ask("Auth token (legacy)");/' agent-network/bin/cli.ts
grep -Fq 'if (!token) token = await ask("Auth token (legacy)")' agent-network/bin/cli.ts
build_cli
set +e
assert_default_no_prompt >/tmp/test651-prompt-mutation.log 2>&1
prompt_rc=$?
set -e
test "$prompt_rc" -ne 0
echo "MUTATION_RED: implicit-token-prompt rc=$prompt_rc"
cp /tmp/test651-cli.ts agent-network/bin/cli.ts

echo "L4 witnessed-red: discard the explicit --token path"
sed -i 's/const token = opts.token || "";/const token = "";/' agent-network/bin/cli.ts
grep -Fq 'const token = "";' agent-network/bin/cli.ts
build_cli
set +e
assert_explicit_token_works >/tmp/test651-token-mutation.log 2>&1
token_rc=$?
set -e
test "$token_rc" -ne 0
echo "MUTATION_RED: explicit-token-discarded rc=$token_rc"
cp /tmp/test651-cli.ts agent-network/bin/cli.ts

echo "L5 restored green"
build_cli
assert_default_no_prompt
assert_explicit_token_works

echo "RESULT: PASS"

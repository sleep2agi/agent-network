#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test653-batch-workdir.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1
cd /workspace

echo "# test653 — batch workdir normalization"
echo "source_commit=${TEST653_SOURCE_COMMIT:-unknown}"
echo "bun=$(bun --version)"
echo "date=$(date -Is)"

run_tests() {
  bun test agent-network/src/batch-workdir.test.ts agent-network/src/batch-workdir-wiring.test.ts
}

build_cli() {
  cd /workspace/agent-network
  bun build bin/cli.ts --target node --outfile /tmp/test653-cli.js \
    --external @sleep2agi/commhub-server --external bun:sqlite --external '../../server/*'
  test -s /tmp/test653-cli.js
  cd /workspace
}

prepare_case() {
  local case_root=$1
  mkdir -p "$case_root/home/.anet" "$case_root/start"
  chmod 0700 "$case_root/home/.anet"
  printf '%s\n' '{"hub":"http://127.0.0.1:19178","token":"utok_test653","user":{"user_id":"u_test653","username":"tester","role":"admin"},"network_id":"net_test653","network_name":"test653"}' > "$case_root/home/.anet/config.json"
  chmod 0600 "$case_root/home/.anet/config.json"
  : > "$case_root/tmux-cwds"
}

run_create_case() {
  local case_root=$1
  prepare_case "$case_root"
  (
    cd "$case_root/start"
    HOME="$case_root/home" \
    PATH="/test653:$PATH" \
    TEST653_TMUX_CWDS="$case_root/tmux-cwds" \
      bun /tmp/test653-cli.js create --batch \
        --preset claude-sonnet-4-6 --api-key fake-test-key \
        --workdir '~/design' --workdir-mode separate \
        --prefix worker --count 2 --description test653
  )
  test -f "$case_root/home/design/node1/.anet/nodes/worker1号/config.json" \
    && test -f "$case_root/home/design/node2/.anet/nodes/worker2号/config.json" \
    && test ! -e "$case_root/start/~" \
    && test "$(sed -n '1p' "$case_root/tmux-cwds")" = "$case_root/home/design/node1" \
    && test "$(sed -n '2p' "$case_root/tmux-cwds")" = "$case_root/home/design/node2"
}

run_cleanup_case() {
  local case_root=$1
  prepare_case "$case_root"
  mkdir -p "$case_root/home/design/node1"
  printf '%s\n' keep-until-cleanup > "$case_root/home/design/node1/marker"
  (
    cd "$case_root/start"
    HOME="$case_root/home" \
    PATH="/test653:$PATH" \
    TEST653_TMUX_CWDS="$case_root/tmux-cwds" \
      bun /tmp/test653-cli.js batch cleanup worker --workdir '~/design'
  )
  test ! -e "$case_root/home/design" \
    && test ! -e "$case_root/start/~"
}

echo "L0: production CLI build"
build_cli

echo "L1: tilde, relative, absolute, invalid shorthand, and production wiring"
run_tests

echo "L1b: real CLI batch create anchors two nodes under one expanded home"
bun /test653/fake-hub.ts >/tmp/test653-fake-hub.log 2>&1 &
hub_pid=$!
trap 'kill "$hub_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  if grep -Fq 'fake-hub=' /tmp/test653-fake-hub.log; then break; fi
  sleep 0.1
done
grep -Fq 'fake-hub=' /tmp/test653-fake-hub.log
run_create_case /tmp/test653-live

echo "L1c: real CLI cleanup targets the same expanded home"
run_cleanup_case /tmp/test653-cleanup-live

cp agent-network/bin/cli.ts /tmp/test653-cli.ts

echo "L2 witnessed-red: remove createBatch normalization"
sed -i '/opts = { \.\.\.opts, workdir: normalizeBatchWorkdir(opts.workdir) };/d' agent-network/bin/cli.ts
if cmp -s agent-network/bin/cli.ts /tmp/test653-cli.ts; then
  echo "mutation did not change cli.ts" >&2
  exit 1
fi
build_cli
set +e
run_create_case /tmp/test653-create-mutation >/tmp/test653-create-mutation.log 2>&1
create_rc=$?
set -e
test "$create_rc" -ne 0
test -d '/tmp/test653-create-mutation/start/~/design/node1'
echo "MUTATION_RED: create-normalization-removed rc=$create_rc"
cp /tmp/test653-cli.ts agent-network/bin/cli.ts

echo "L3 witnessed-red: remove cleanup normalization"
sed -i 's/const dir = normalizeBatchWorkdir(workdir);/const dir = workdir;/' agent-network/bin/cli.ts
grep -Fq 'const dir = workdir;' agent-network/bin/cli.ts
build_cli
set +e
run_cleanup_case /tmp/test653-cleanup-mutation >/tmp/test653-cleanup-mutation.log 2>&1
cleanup_rc=$?
set -e
test "$cleanup_rc" -ne 0
test -f /tmp/test653-cleanup-mutation/home/design/node1/marker
echo "MUTATION_RED: cleanup-normalization-removed rc=$cleanup_rc"
cp /tmp/test653-cli.ts agent-network/bin/cli.ts

echo "L4 restored green"
build_cli
run_tests
run_create_case /tmp/test653-restored
run_cleanup_case /tmp/test653-cleanup-restored

echo "RESULT: PASS"

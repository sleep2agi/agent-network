#!/usr/bin/env bash
# Board #612. The container is started with --memory (see docker-run.args).
# The probe calls the real gate, which must read the cgroup: /proc/meminfo
# still shows the host. After the wait, only one start may be in flight.
# Changing that cap back to the normal concurrency limit must turn this red.
set -euo pipefail

[[ "${TEST612_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST612_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST612_SOURCE_COMMIT"

GATE=/agent-node-src/src/runtime/codex-app-server/start-resource-gate.ts
ANCHOR='const cap = timedOut ? START_GATE_SINGLE_LANE_CONCURRENT : maxConcurrent;'
REPL='const cap = maxConcurrent;'

run_probe() {
  bun /test612/probe.mjs
}

echo '== green: real cgroup, single-lane after the wait =='
run_probe

count=$(grep -F -c "$ANCHOR" "$GATE" || true)
if [[ "$count" != "1" ]]; then
  echo "FAIL: mutation anchor count=$count"
  exit 1
fi
cp "$GATE" /tmp/gate.bak
bun -e '
  const fs = require("fs");
  const path = process.argv[1];
  const anchor = process.argv[2];
  const repl = process.argv[3];
  const text = fs.readFileSync(path, "utf8");
  const n = text.split(anchor).length - 1;
  if (n !== 1) {
    console.error("MUTATION_NOT_APPLIED: anchor count=" + n);
    process.exit(1);
  }
  fs.writeFileSync(path, text.replace(anchor, repl));
' "$GATE" "$ANCHOR" "$REPL"
if grep -F -q "$ANCHOR" "$GATE"; then
  echo 'FAIL: mutation anchor still present'
  exit 1
fi

# A second bun process must see the edited source, not a transpile cache.
rm -rf /root/.bun/install/cache /tmp/bun-* "${HOME:-/root}/.bun/install/cache" 2>/dev/null || true

echo '== red: timeout releases the whole batch =='
set +e
run_probe > /tmp/test612-mut.txt 2>&1
rc=$?
set -e
cat /tmp/test612-mut.txt
cp /tmp/gate.bak "$GATE"
if [[ "$rc" -eq 0 ]]; then
  echo 'FAIL: batch-release mutation stayed green'
  exit 1
fi
if ! grep -F -q 'FAIL: maxStarting=' /tmp/test612-mut.txt; then
  echo 'FAIL: mutation died for a reason other than maxStarting'
  exit 1
fi
echo 'mutation red as required'

echo '== green: four processes contend for one slot =='
timeout 90 bun /test612/race.mjs

LOCK_ANCHOR='const LOCK_PUBLISH_ATOMIC = true;'
LOCK_REPL='const LOCK_PUBLISH_ATOMIC = false;'
lock_count=$(grep -F -c "$LOCK_ANCHOR" "$GATE" || true)
if [[ "$lock_count" != "1" ]]; then
  echo "FAIL: lock mutation anchor count=$lock_count"
  exit 1
fi
cp "$GATE" /tmp/gate.lock.bak
bun -e '
  const fs = require("fs");
  const path = process.argv[1];
  const anchor = process.argv[2];
  const repl = process.argv[3];
  const text = fs.readFileSync(path, "utf8");
  const n = text.split(anchor).length - 1;
  if (n !== 1) {
    console.error("MUTATION_NOT_APPLIED: anchor count=" + n);
    process.exit(1);
  }
  fs.writeFileSync(path, text.replace(anchor, repl));
' "$GATE" "$LOCK_ANCHOR" "$LOCK_REPL"
if grep -F -q "$LOCK_ANCHOR" "$GATE"; then
  echo 'FAIL: lock mutation anchor still present'
  exit 1
fi
rm -rf /root/.bun/install/cache /tmp/bun-* "${HOME:-/root}/.bun/install/cache" 2>/dev/null || true

echo '== red: empty lock can be stolen =='
set +e
timeout 90 bun /test612/race.mjs > /tmp/test612-race.txt 2>&1
rc=$?
set -e
cat /tmp/test612-race.txt
cp /tmp/gate.lock.bak "$GATE"
if ! cmp -s /tmp/gate.lock.bak "$GATE"; then
  echo 'FAIL: gate source was not restored after the lock mutation'
  exit 1
fi
if [[ "$rc" -eq 0 ]]; then
  echo 'FAIL: lock mutation stayed green'
  exit 1
fi
if ! grep -E -q 'OVERLAPS=[1-9]' /tmp/test612-race.txt; then
  echo 'FAIL: lock mutation died without an overlap'
  exit 1
fi
echo 'lock mutation red as required'

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
ANET_GATE=/agent-network-src/src/start-resource-gate.ts
ANCHOR='const cap = timedOut ? START_GATE_SINGLE_LANE_CONCURRENT : maxConcurrent;'
REPL='const cap = maxConcurrent;'

run_probe() {
  bun /test612/probe.mjs
}

echo '== green: mirrored implementations are byte-identical =='
cmp -s "$GATE" "$ANET_GATE" || {
  echo 'FAIL: agent-node and agent-network start gates differ' >&2
  exit 1
}

echo '== green: 4x policy and resource-specific statuses =='
bun /test612/policy.mjs

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

policy_mutation() {
  local label="$1" anchor="$2" repl="$3" witness="$4"
  echo "== red: $label =="
  mutate "$anchor" "$repl"
  set +e
  bun /test612/policy.mjs > /tmp/test612-policy-mut.txt 2>&1
  rc=$?
  set -e
  cat /tmp/test612-policy-mut.txt
  restore_mut
  if [[ "$rc" -eq 0 ]]; then
    echo "FAIL: $label mutation stayed green"
    exit 1
  fi
  grep -F -q "$witness" /tmp/test612-policy-mut.txt || {
    echo "FAIL: $label mutation died without its assertion witness"
    exit 1
  }
}

echo '== green: sixteen processes, a new node id each round =='
timeout 150 bun /test612/race.mjs

echo '== green: sixteen processes, the same node id each round =='
timeout 150 env RACE_SAME_NODE=1 bun /test612/race.mjs

echo '== green: a stall during the count keeps one holder =='
timeout 30 bun /test612/recheck.mjs

echo '== green: reentry after a busy release keeps the slot =='
timeout 30 bun /test612/reentry.mjs

mutate() {
  local anchor="$1" repl="$2"
  local n
  n=$(grep -F -c "$anchor" "$GATE" || true)
  if [[ "$n" != "1" ]]; then
    echo "FAIL: mutation anchor count=$n for [$anchor]"
    exit 1
  fi
  cp "$GATE" /tmp/gate.mut.bak
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
  ' "$GATE" "$anchor" "$repl"
  if grep -F -q "$anchor" "$GATE"; then
    echo "FAIL: mutation anchor still present: $anchor"
    exit 1
  fi
  rm -rf /root/.bun/install/cache /tmp/bun-* "${HOME:-/root}/.bun/install/cache" 2>/dev/null || true
}

restore_mut() {
  cp /tmp/gate.mut.bak "$GATE"
  if ! cmp -s /tmp/gate.mut.bak "$GATE"; then
    echo 'FAIL: gate source was not restored after the mutation'
    exit 1
  fi
}

policy_mutation 'restoring the 2x load default blocks the CI shape' \
  'export const START_GATE_DEFAULT_MAX_LOAD_PER_CPU = 4;' \
  'export const START_GATE_DEFAULT_MAX_LOAD_PER_CPU = 2;' \
  'default load multiplier is not 4'
policy_mutation 'deleting the memory shortage check admits low memory' \
  'if (s.memAvailableMb < minMemMb) {' \
  'if (false) {' \
  'low memory was admitted'
policy_mutation 'reporting load shortage as memory hides the cause' \
  'if (loadHigh) return START_GATE_WAITING_LOAD_STATUS;' \
  'if (loadHigh) return START_GATE_WAITING_MEMORY_STATUS;' \
  'load status mismatch'
policy_mutation 'restoring only memory wait leaves load-blocked nodes stuck' \
  'return typeof task === "string" && START_GATE_BLOCKED_STATUSES.has(task);' \
  'return task === START_GATE_WAITING_MEMORY_STATUS;' \
  'restore does not recognize gate status'

RECHECK_ANCHOR='const still = () => lockStillOurs(dir, holderPid, selfStart, token); // before the lease is written'
RECHECK_REPL='const still = () => true; // before the lease is written'
echo '== red: deleting the admit recheck leaves two holders =='
mutate "$RECHECK_ANCHOR" "$RECHECK_REPL"
set +e
timeout 30 bun /test612/recheck.mjs > /tmp/test612-recheck.txt 2>&1
rc=$?
set -e
cat /tmp/test612-recheck.txt
restore_mut
if [[ "$rc" -eq 0 ]]; then
  echo 'FAIL: recheck mutation stayed green'
  exit 1
fi
if ! grep -F -q 'FAIL: stalled holder still has a lease' /tmp/test612-recheck.txt; then
  echo 'FAIL: recheck mutation died without two holders'
  exit 1
fi
echo 'recheck mutation red as required'

REENTRY_ANCHOR='if (cancelPendingDrop(dir, key)) {'
REENTRY_REPL='if (false && cancelPendingDrop(dir, key)) {'
echo '== red: deleting the reentry cancel lets a third party in =='
mutate "$REENTRY_ANCHOR" "$REENTRY_REPL"
set +e
timeout 30 bun /test612/reentry.mjs > /tmp/test612-reentry.txt 2>&1
rc=$?
set -e
cat /tmp/test612-reentry.txt
restore_mut
if [[ "$rc" -eq 0 ]]; then
  echo 'FAIL: reentry mutation stayed green'
  exit 1
fi
if ! grep -F -q 'FAIL: a third party entered while the restarted node was still up' /tmp/test612-reentry.txt; then
  echo 'FAIL: reentry mutation died without a third party'
  exit 1
fi
echo 'reentry mutation red as required'

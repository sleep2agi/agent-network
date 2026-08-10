#!/usr/bin/env bash
set -euo pipefail
source /workspace/tests/lib/safe-rm.sh
echo "# test689 — owner schedule agent local apply"
echo "source_commit=${TEST689_SOURCE_COMMIT:-unknown}"

echo "L0 shared Hub/agent parser byte identity"
cmp -s server/src/shared/external-schedule-contract.ts agent-node/src/shared/external-schedule-contract.ts

echo "L1 managed cron apply/journal/rollback + process-gated consumer"
bun test \
  agent-node/src/owner-schedule-control.test.ts \
  agent-node/src/owner-schedule-consumer.test.ts \
  agent-node/src/external-schedules.test.ts \
  agent-node/src/owner-schedule-wiring.test.ts

echo "L2 production agent-node bundle"
(cd agent-node && bun run build)

echo "L2b real container crontab read/install/readback"
bun test agent-node/src/owner-schedule-system-crontab.test.ts

echo "L3 witnessed-red mutations"
MUT_ROOT="$(mktemp -d)"
trap 'safe_rm_rf "$MUT_ROOT"' EXIT
cp -a agent-node "$MUT_ROOT/agent-node"
cp -a agent-network "$MUT_ROOT/agent-network"
cp -a server "$MUT_ROOT/server"

expect_red() {
  local name="$1"; shift
  local log="$MUT_ROOT/$name.log"
  if "$@" >"$log" 2>&1; then
    echo "mutation unexpectedly green: $name" >&2
    exit 1
  fi
  test -s "$log"
  echo "  witnessed-red: $name"
}

assert_changed() {
  local path="$1"
  local before="$2"
  local after
  after="$(sha256sum "$path" | cut -d' ' -f1)"
  if [[ "$after" == "$before" ]]; then
    echo "mutation was byte-identical: $path" >&2
    exit 1
  fi
}

CONTROL="$MUT_ROOT/agent-node/src/owner-schedule-control.ts"
CONSUMER="$MUT_ROOT/agent-node/src/owner-schedule-consumer.ts"
ORIG_CONTROL="$(sha256sum "$CONTROL" | cut -d' ' -f1)"
sed -i 's/if (sha256(match\[2\]) !== commandSha256)/if (false)/' "$CONTROL"
assert_changed "$CONTROL" "$ORIG_CONTROL"
expect_red command-fingerprint bash -lc "cd '$MUT_ROOT' && bun test agent-node/src/owner-schedule-control.test.ts"

cp agent-node/src/owner-schedule-control.ts "$CONTROL"
ORIG_CONTROL="$(sha256sum "$CONTROL" | cut -d' ' -f1)"
sed -i 's/if (entry.revision !== intent.base_revision)/if (false)/' "$CONTROL"
assert_changed "$CONTROL" "$ORIG_CONTROL"
expect_red revision-cas bash -lc "cd '$MUT_ROOT' && bun test agent-node/src/owner-schedule-control.test.ts"

cp agent-node/src/owner-schedule-control.ts "$CONTROL"
ORIG_CONTROL="$(sha256sum "$CONTROL" | cut -d' ' -f1)"
sed -i 's/if (nodeId !== expectedNodeId)/if (false)/' "$CONTROL"
assert_changed "$CONTROL" "$ORIG_CONTROL"
expect_red exact-node-marker bash -lc "cd '$MUT_ROOT' && bun test agent-node/src/owner-schedule-control.test.ts"

cp agent-node/src/owner-schedule-control.ts "$CONTROL"
ORIG_CONTROL="$(sha256sum "$CONTROL" | cut -d' ' -f1)"
sed -i '0,/adapter.install(before);/s//\/\/ rollback removed/' "$CONTROL"
assert_changed "$CONTROL" "$ORIG_CONTROL"
expect_red exact-rollback bash -lc "cd '$MUT_ROOT' && bun test agent-node/src/owner-schedule-control.test.ts"

cp agent-node/src/owner-schedule-control.ts "$CONTROL"
ORIG_CONTROL="$(sha256sum "$CONTROL" | cut -d' ' -f1)"
sed -i 's/if (currentHash === existingJournal.after_sha256)/if (false)/' "$CONTROL"
assert_changed "$CONTROL" "$ORIG_CONTROL"
expect_red lost-ack-idempotency bash -lc "cd '$MUT_ROOT' && bun test agent-node/src/owner-schedule-control.test.ts"

cp agent-node/src/shared/external-schedule-contract.ts "$MUT_ROOT/agent-node/src/shared/external-schedule-contract.ts"
ORIG_CONTRACT="$(sha256sum "$MUT_ROOT/agent-node/src/shared/external-schedule-contract.ts" | cut -d' ' -f1)"
sed -i 's/if (fields.length !== 5)/if (raw.trim() === "@reboot") return "@reboot"; if (fields.length !== 5)/' "$MUT_ROOT/agent-node/src/shared/external-schedule-contract.ts"
assert_changed "$MUT_ROOT/agent-node/src/shared/external-schedule-contract.ts" "$ORIG_CONTRACT"
expect_red cron-alias-gate bash -lc "cd '$MUT_ROOT' && bun test agent-node/src/owner-schedule-control.test.ts"

cp agent-node/src/owner-schedule-consumer.ts "$CONSUMER"
ORIG_CONSUMER="$(sha256sum "$CONSUMER" | cut -d' ' -f1)"
sed -i 's/if (!options.enabled) return/if (false) return/' "$CONSUMER"
assert_changed "$CONSUMER" "$ORIG_CONSUMER"
expect_red process-level-gate bash -lc "cd '$MUT_ROOT' && bun test agent-node/src/owner-schedule-consumer.test.ts"

cp agent-node/src/shared/external-schedule-contract.ts "$MUT_ROOT/agent-node/src/shared/external-schedule-contract.ts"
ORIG_CONTRACT="$(sha256sum "$MUT_ROOT/agent-node/src/shared/external-schedule-contract.ts" | cut -d' ' -f1)"
printf '\n// drift mutation\n' >> "$MUT_ROOT/agent-node/src/shared/external-schedule-contract.ts"
assert_changed "$MUT_ROOT/agent-node/src/shared/external-schedule-contract.ts" "$ORIG_CONTRACT"
expect_red shared-parser-drift bash -lc "cmp -s '$MUT_ROOT/server/src/shared/external-schedule-contract.ts' '$MUT_ROOT/agent-node/src/shared/external-schedule-contract.ts' || { echo parser-drift-detected >&2; exit 1; }"

echo "L4 restored green"
bun test \
  agent-node/src/owner-schedule-control.test.ts \
  agent-node/src/owner-schedule-consumer.test.ts \
  agent-node/src/external-schedules.test.ts \
  agent-node/src/owner-schedule-wiring.test.ts

echo "RESULT: PASS"

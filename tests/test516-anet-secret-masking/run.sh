#!/usr/bin/env bash
# test516 — anet never prints a full secret; errors are plain language (#516 part 1).
#
# L0 runs agent-network/src/cli-secret-masking.test.ts: the real CLI (bin/cli.ts)
#    against a temp HOME + an in-process fake hub on a random port, with fixture
#    configs that hold known fake tokens. Every row asserts the full token never
#    appears in stdout/stderr.
# L1–L4 are witnessed reds: each one removes one masking point and the same
#    test file must go red. A mutation that does not apply is a failure too
#    (MUTATION_NOOP), so a refactor that moves the anchor cannot turn this green.
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test516-anet-secret-masking.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test516 — anet secret masking + plain-language errors"
echo "source_commit=${TEST516_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

cd /workspace/agent-network
TEST=src/cli-secret-masking.test.ts

run_tests() {
  HOME=$(mktemp -d) bun test "$TEST"
}

echo "L0 green: real CLI x fixture config x fake hub"
run_tests > /tmp/test516-green.log 2>&1 || { cat /tmp/test516-green.log; echo "FAIL: L0 not green"; exit 1; }
grep -Eq '^[[:space:]]*0 fail$' /tmp/test516-green.log || { cat /tmp/test516-green.log; echo "FAIL: L0 summary missing"; exit 1; }
pass=$(grep -Eo '^[[:space:]]*[0-9]+ pass$' /tmp/test516-green.log | grep -Eo '[0-9]+')
echo "L0 pass=$pass"
[ "${pass:-0}" -ge 20 ] || { echo "FAIL: only ${pass:-0} tests ran (expected >= 20)"; exit 1; }

# Each mutation is one literal sed line (scripts/check-mutation-pins.py reads
# the anchors). check_red: the file must have changed (else MUTATION_NOOP),
# the test must go red (else MUTATION_FALSE_GREEN), then the file is restored.
check_red() {
  local label=$1 file=$2 backup=$3
  if cmp -s "$file" "$backup"; then
    echo "MUTATION_NOOP: $label (anchor not found in $file)"
    exit 1
  fi
  local rc=0
  run_tests > "/tmp/test516-$label.log" 2>&1 || rc=$?
  cp "$backup" "$file"
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    exit 1
  fi
  echo "MUTATION_RED: $label rc=$rc ($(grep '^(fail)' "/tmp/test516-$label.log" | sort -u | wc -l) failing test(s))"
}

cp src/cli-errors.ts /tmp/test516-errors.ts
cp bin/cli.ts /tmp/test516-cli.ts

echo "L1 witnessed-red: maskSecret returns the value"
sed -i 's/return `${prefix}…${rest\.slice(-4)}`;/return value;/' src/cli-errors.ts
check_red mask-identity src/cli-errors.ts /tmp/test516-errors.ts

echo "L2 witnessed-red: anet config json prints the raw config"
sed -i 's/JSON\.stringify(redactSecretFields(gc), null, 2)/JSON.stringify(gc, null, 2)/' bin/cli.ts
check_red config-json-raw bin/cli.ts /tmp/test516-cli.ts

echo "L3 witnessed-red: anet node create echoes the --env secret"
sed -i 's/env\.${key} → ${refName} = ${maskSecret(value)}/env.${key} → ${refName} = ${value}/' bin/cli.ts
check_red create-echo bin/cli.ts /tmp/test516-cli.ts

echo "L4 witnessed-red: redactSecrets passes text through"
sed -i 's/^  if (!text) return text;$/  return text;/' src/cli-errors.ts
check_red redact-identity src/cli-errors.ts /tmp/test516-errors.ts

echo "L5 restored green"
run_tests > /tmp/test516-restored.log 2>&1 || { cat /tmp/test516-restored.log; echo "FAIL: restore not green"; exit 1; }

echo "RESULT: PASS"

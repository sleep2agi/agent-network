#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace
SOURCE_COMMIT=${TEST745_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: SOURCE_COMMIT must be one full lowercase Git SHA" >&2
  exit 1
}

echo "# test745 — complete agent-network unit domain"
echo "source_commit=$SOURCE_COMMIT"
echo "bun=$(bun --version) node=$(node --version) git=$(git --version) uid=$(id -u node)"

test_files=$(find "$ROOT/agent-network/src" -type f -name '*.test.ts' | wc -l | tr -d ' ')
[[ "$test_files" =~ ^[1-9][0-9]*$ ]] || {
  echo "FAIL: agent-network test-file denominator is empty" >&2
  exit 1
}
echo "test_files=$test_files"

echo "[L0] full agent-network/src unit suite as non-root"
runuser -u node -- env HOME=/home/node \
  bash -lc 'cd /workspace/agent-network && bun test src/' \
  2>&1 | tee /tmp/test745-green.log

grep -Eq '^[[:space:]]*[1-9][0-9]* pass$' /tmp/test745-green.log || {
  echo "FAIL: non-empty pass denominator missing" >&2
  exit 1
}
grep -Eq '^[[:space:]]*0 fail$' /tmp/test745-green.log || {
  echo "FAIL: aggregate suite did not finish with zero failures" >&2
  exit 1
}
grep -Eq 'Ran [1-9][0-9]* tests across [1-9][0-9]* files\.' /tmp/test745-green.log || {
  echo "FAIL: aggregate test/file summary missing" >&2
  exit 1
}

echo "[L1] witnessed-red: top-level config help must match the implemented parser"
TARGET='  anet config [path|json]       Show config summary, path, or raw JSON'
MUTATED='  anet config get|set          Inspect or edit config'
before=$(sha256sum "$ROOT/agent-network/bin/cli.ts" | cut -d' ' -f1)
python3 - "$ROOT/agent-network/bin/cli.ts" "$TARGET" "$MUTATED" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
target, replacement = sys.argv[2], sys.argv[3]
if source.count(target) != 1:
    raise SystemExit("mutation target count changed")
path.write_text(source.replace(target, replacement, 1))
PY
after=$(sha256sum "$ROOT/agent-network/bin/cli.ts" | cut -d' ' -f1)
[[ "$before" != "$after" ]] || {
  echo "FAIL: mutation was a byte no-op" >&2
  exit 1
}

set +e
runuser -u node -- env HOME=/home/node \
  bash -lc 'cd /workspace/agent-network && bun test src/top-level-help-contract.test.ts' \
  >/tmp/test745-mutation.log 2>&1
mutation_rc=$?
set -e
[[ "$mutation_rc" -ne 0 ]] || {
  cat /tmp/test745-mutation.log
  echo "FAIL: stale config-help mutation survived" >&2
  exit 1
}
grep -Fq 'Expected to contain: "anet config [path|json]"' /tmp/test745-mutation.log || {
  cat /tmp/test745-mutation.log
  echo "FAIL: mutation red did not reach the named help-contract assertion" >&2
  exit 1
}

grep -F 'Expected to contain: "anet config [path|json]"' /tmp/test745-mutation.log
echo "MUTATION_RED stale-config-help rc=$mutation_rc"
echo "RESULT: PASS"

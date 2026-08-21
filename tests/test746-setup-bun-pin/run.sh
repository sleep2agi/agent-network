#!/usr/bin/env bash
set -euo pipefail

EXPECTED_VERSION=1.3.14
ROOT=/app
WORKFLOWS="$ROOT/.github/workflows"

[[ "${TEST746_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST746_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}

assert_setup_bun_pins() {
  local workflows="$1" log="$2"
  WORKFLOWS="$workflows" EXPECTED_VERSION="$EXPECTED_VERSION" /usr/bin/python3 - <<'PY' >"$log" 2>&1
import glob
import os
import sys
import yaml

root = os.environ["WORKFLOWS"]
expected = os.environ["EXPECTED_VERSION"]
found = []
bad = []

# Match the ACTION, not one particular ref of it. This used to compare against
# the literal "oven-sh/setup-bun@v2", so SHA-pinning the action (a separate,
# desirable change) made this find zero occurrences and fail — the guard could
# not tell "the pin was removed" from "the pin was written differently".
#
# It failing closed on zero was right; matching on the ref was not. This guard
# owns ONE fact: every setup-bun invocation carries the expected bun-version.
# Whether the action itself is SHA-pinned is a different fact, owned by
# .github/scripts/check-action-pins.py. One guard, one fact — two guards on the
# same fact drift apart, and then one of them is wrong and still green.
SETUP_BUN = "oven-sh/setup-bun@"

def walk(value, path):
    if isinstance(value, dict):
        uses = value.get("uses")
        if isinstance(uses, str) and uses.startswith(SETUP_BUN):
            version = (value.get("with") or {}).get("bun-version")
            found.append((path, version))
            if str(version) != expected:
                bad.append((path, version))
        for key, child in value.items():
            walk(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            walk(child, f"{path}[{index}]")

for filename in sorted(glob.glob(os.path.join(root, "*.yml")) + glob.glob(os.path.join(root, "*.yaml"))):
    with open(filename, "r", encoding="utf-8") as handle:
        walk(yaml.safe_load(handle), os.path.basename(filename))

print(f"setup_bun_occurrences={len(found)} expected_version={expected}")
for path, version in found:
    print(f"{path} bun-version={version}")

if len(found) != 4:
    print(f"FAIL: expected exactly 4 setup-bun occurrences, found {len(found)}", file=sys.stderr)
    sys.exit(1)
if bad:
    for path, version in bad:
        print(f"FAIL: {path} bun-version={version!r}, expected {expected}", file=sys.stderr)
    sys.exit(1)
PY
}

BASELINE_LOG=/tmp/test746-baseline.log
assert_setup_bun_pins "$WORKFLOWS" "$BASELINE_LOG"
cat "$BASELINE_LOG"
grep -Fxq 'setup_bun_occurrences=4 expected_version=1.3.14' "$BASELINE_LOG"
echo 'L1 SETUP_BUN_PIN_PASS'

MUTANT_ROOT=/tmp/test746-mutant
mkdir -p "$MUTANT_ROOT"
cp -R "$WORKFLOWS" "$MUTANT_ROOT/workflows"
TARGET="$MUTANT_ROOT/workflows/release.yml"
before="$(sha256sum "$TARGET" | cut -d' ' -f1)"
/usr/bin/python3 - "$TARGET" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
target = "        with:\n          bun-version: 1.3.14\n"
if text.count(target) != 1:
    raise SystemExit("mutation target count changed")
path.write_text(text.replace(target, "", 1))
PY
after="$(sha256sum "$TARGET" | cut -d' ' -f1)"
[[ "$before" != "$after" ]] || { echo 'MUTATION_NOOP release-pin-removed'; exit 1; }

MUTATION_LOG=/tmp/test746-mutation.log
if assert_setup_bun_pins "$MUTANT_ROOT/workflows" "$MUTATION_LOG" 2>&1; then
  echo 'MUTATION_SURVIVED release-pin-removed'
  exit 1
fi
grep -Fq 'release.yml' "$MUTATION_LOG"
grep -Fq 'bun-version=None, expected 1.3.14' "$MUTATION_LOG"
echo 'MUTATION_RED release-pin-removed'
echo 'RESULT: PASS'

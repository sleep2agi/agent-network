#!/usr/bin/env bash
set -euo pipefail

SCRIPT="scripts/sync-pinned-versions.sh"
TARGET="2.3.0-preview.45"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

baseline_out="$(mktemp)"
if ! bash "$SCRIPT" @sleep2agi/agent-network "$TARGET" >"$baseline_out" 2>&1; then
  cat "$baseline_out" >&2
  fail "a normal dry-run with a version diff exits zero"
fi
grep -q 'agent-network/src/opencode-agent-node-pair.ts' "$baseline_out" \
  || fail "the changed live-version target is enumerated"
grep -q 'dry-run 完成' "$baseline_out" \
  || fail "the dry-run reaches its final summary"
grep -q '加 --apply 实跑' "$baseline_out" \
  || fail "the summary retains the actionable apply command"
pass "normal version differences do not abort the dry-run"
pass "every registered target is followed by the final summary"

# Witnessed red: reconstruct the old pipeline in a disposable copy. It sees
# the same real version difference, returns diff's expected rc=1 through
# pipefail, and exits before the summary.
mutant="$(mktemp)"
cp "$SCRIPT" "$mutant"
node - "$mutant" <<'NODE'
const fs = require('fs');
const path = process.argv[2];
let source = fs.readFileSync(path, 'utf8');
const start = source.indexOf('    # `diff` uses rc=1');
const endMarker = '    printf \'%s\\n\' "$diff_output" | sed -n \'1,40{s/^/    /;p;}\'';
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('mutation target not found');
const after = end + endMarker.length;
source = source.slice(0, start)
  + '    diff -u <(printf \'%s\' "$before") <(printf \'%s\' "$after") | sed \'s/^/    /\' | head -40'
  + source.slice(after);
fs.writeFileSync(path, source);
NODE
chmod +x "$mutant"
mutant_out="$(mktemp)"
if bash "$mutant" @sleep2agi/agent-network "$TARGET" >"$mutant_out" 2>&1; then
  fail "witnessed-red old pipefail pipeline unexpectedly stayed green"
fi
if grep -q 'dry-run 完成' "$mutant_out"; then
  fail "witnessed-red old pipeline unexpectedly reached the summary"
fi
pass "WITNESSED_RED: the old diff pipeline exits early and loses the summary"

# A genuine diff execution error remains fatal. This distinguishes the
# expected rc=1 from rc>1 instead of papering over every diff failure.
fakebin="$(mktemp -d)"
cat >"$fakebin/diff" <<'SH'
#!/usr/bin/env sh
exit 2
SH
chmod +x "$fakebin/diff"
error_out="$(mktemp)"
if PATH="$fakebin:$PATH" bash "$SCRIPT" @sleep2agi/agent-network "$TARGET" >"$error_out" 2>&1; then
  fail "a real diff error was incorrectly accepted"
fi
grep -q 'ERROR: diff failed.*rc=2' "$error_out" \
  || fail "the real diff error is reported with its exit status"
pass "real diff failures remain nonzero and visible"

echo "SOURCE_COMMIT=${SOURCE_COMMIT}"
echo "RESULT: PASS"

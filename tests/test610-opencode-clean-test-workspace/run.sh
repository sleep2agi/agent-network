#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test610-opencode-clean-test-workspace.txt"
WORKSPACE_PARENT=/workspace/opencode-test-workspaces
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test610 — OpenCode Git-state test workspace isolation"
echo "source_commit=${TEST610_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

run_target() {
  OPENCODE_TEST_WORKSPACE_ROOT="$WORKSPACE_PARENT" \
    bun test agent-network/src/opencode-runtime-binding.test.ts
}

echo "L0 typecheck"
cd /workspace/agent-network
bun run typecheck
cd /workspace

echo "L1 hostile system temp ancestor"
mkdir -p /tmp/.git
test -d /tmp/.git
run_target
test -d /tmp/.git
if find "$WORKSPACE_PARENT" -mindepth 1 -print -quit | grep -q .; then
  echo "FAIL: test-owned workspace child was not cleaned"
  exit 1
fi

echo "L2 fail-closed override whose ancestor contains Git metadata"
set +e
OPENCODE_TEST_WORKSPACE_ROOT=/tmp/opencode-test-workspaces \
  bun test agent-network/src/opencode-runtime-binding.test.ts \
  >/tmp/test610-dirty-override.log 2>&1
dirty_override_rc=$?
set -e
test "$dirty_override_rc" -ne 0
grep -Fq 'OpenCode test workspace has Git metadata in its ancestor chain: /tmp' \
  /tmp/test610-dirty-override.log
test ! -e /tmp/opencode-test-workspaces

echo "L3 witnessed-red: restore the old tmpdir-based fixture"
cp agent-network/src/opencode-runtime-binding.test.ts /tmp/test610-binding.test.ts
sed -i \
  's/root = createIsolatedGitStateTestRoot();/root = mkdtempSync(join(tmpdir(), "opencode-git-state-"));/' \
  agent-network/src/opencode-runtime-binding.test.ts
grep -Fq 'root = mkdtempSync(join(tmpdir(), "opencode-git-state-"));' \
  agent-network/src/opencode-runtime-binding.test.ts
set +e
run_target >/tmp/test610-mutation.log 2>&1
mutation_rc=$?
set -e
if [ "$mutation_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: tmpdir-ancestor-isolation"
  exit 1
fi
grep -Fq 'Git repository metadata is invalid' /tmp/test610-mutation.log
echo "MUTATION_RED: tmpdir-ancestor-isolation rc=$mutation_rc"
cp /tmp/test610-binding.test.ts agent-network/src/opencode-runtime-binding.test.ts

echo "L4 restored green"
run_target

echo "RESULT: PASS"

#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test608-claude-cli-dependency.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test608 — claude-code-cli dependency preflight"
echo "source_commit=${TEST608_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

source /workspace/tests/lib/safe-rm.sh

run_contract() {
  bun test agent-network/src/claude-code-cli-dependency-preflight.test.ts
}

write_fixture() {
  local root="$1"
  mkdir -p "$root/.anet/nodes/n_test608"
  cat >"$root/.anet/nodes/n_test608/config.json" <<'JSON'
{
  "anet_version": "2.5.0",
  "node_id": "n_test608",
  "node_name": "missing-claude",
  "alias": "missing-claude",
  "runtime": "claude-code-cli",
  "token": "ntok_test608",
  "channels": ["server:commhub"],
  "env": {},
  "flags": {}
}
JSON
}

run_missing_binary() {
  local cli="$1"
  local root="$2"
  local log="$3"
  safe_rm_rf "$root"
  mkdir -p "$root/home" "$root/bin"
  write_fixture "$root"
  set +e
  (
    cd "$root"
    HOME="$root/home" PATH="$root/bin:/usr/local/bin:/usr/bin:/bin" \
      bun "$cli" node start missing-claude
  ) >"$log" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: missing claude returned success"
    cat "$log"
    exit 1
  fi
  grep -Fq 'Cannot start: claude-code-cli requires the Claude Code CLI' "$log"
  grep -Fq 'npm install -g @anthropic-ai/claude-code' "$log"
  grep -Fq 'claude auth login' "$log"
  grep -Fq -- '--runtime claude-agent-sdk' "$log"
  if grep -Fq 'requires an interactive TTY' "$log"; then
    echo "FAIL: launch advanced past the dependency preflight"
    cat "$log"
    exit 1
  fi
  test ! -e "$root/.mcp.json"
  test ! -e "$root/.anet/nodes/n_test608/.pid"
}

echo "L0 typecheck + source contract"
cd /workspace/agent-network
bun run typecheck
cd /workspace
run_contract

echo "L1 real source CLI, missing binary"
run_missing_binary /workspace/agent-network/bin/cli.ts /tmp/test608-source /tmp/test608-source.log

echo "L2 packaged CLI, missing binary"
cd /workspace/agent-network
bun run build
cd /workspace
run_missing_binary /workspace/agent-network/dist/bin/cli.js /tmp/test608-packed /tmp/test608-packed.log

echo "L3 positive control: an installed claude passes this gate"
safe_rm_rf /tmp/test608-positive
mkdir -p /tmp/test608-positive/home /tmp/test608-positive/bin
write_fixture /tmp/test608-positive
cat >/tmp/test608-positive/bin/claude <<'SH'
#!/usr/bin/env sh
exit 0
SH
chmod 0755 /tmp/test608-positive/bin/claude
set +e
(
  cd /tmp/test608-positive
  HOME=/tmp/test608-positive/home PATH="/tmp/test608-positive/bin:/usr/local/bin:/usr/bin:/bin" \
    bun /workspace/agent-network/bin/cli.ts node start missing-claude
) >/tmp/test608-positive.log 2>&1
positive_rc=$?
set -e
test "$positive_rc" -ne 0
grep -Fq 'requires an interactive TTY' /tmp/test608-positive.log
if grep -Fq 'was not found in PATH' /tmp/test608-positive.log; then
  echo "FAIL: installed claude was treated as missing"
  exit 1
fi

echo "L4 witnessed-red: disabling the start dependency gate"
cp agent-network/bin/cli.ts /tmp/test608-cli.ts
sed -i 's/if (!claudeInstalled && phase === "start")/if (false)/' agent-network/bin/cli.ts
grep -Fq 'if (false)' agent-network/bin/cli.ts
set +e
run_missing_binary /workspace/agent-network/bin/cli.ts /tmp/test608-mutated /tmp/test608-mutated.log \
  >/tmp/test608-mutation.log 2>&1
mutation_rc=$?
set -e
if [ "$mutation_rc" -eq 0 ]; then
  echo "MUTATION_FALSE_GREEN: missing-claude-start-gate"
  exit 1
fi
echo "MUTATION_RED: missing-claude-start-gate rc=$mutation_rc"
cp /tmp/test608-cli.ts agent-network/bin/cli.ts

echo "L5 restored green"
run_contract
run_missing_binary /workspace/agent-network/bin/cli.ts /tmp/test608-restored /tmp/test608-restored.log

echo "RESULT: PASS"

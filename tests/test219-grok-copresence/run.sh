#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-$ARTIFACT_DIR/report-test219.txt}"
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"
chmod 600 "$REPORT"

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

SOURCE_COMMIT=${TEST219_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
  || fail "SOURCE_COMMIT must bind this gate to one full lowercase Git SHA"

log "# test219 — Grok co-presence TUI runtime"
log "date: $(date -Is)"
log "source_commit=$SOURCE_COMMIT"

log "[L0] isolated environment"
[ ! -e "$ROOT/.git" ] || fail "Docker image contains host .git"
[ ! -e "$ROOT/.anet" ] || fail "Docker image contains host .anet"
command -v flock >>"$REPORT" || fail "flock missing"
node --version >>"$REPORT"
bun --version >>"$REPORT"
cd "$ROOT/agent-node"
node -e 'require("node-pty"); process.stdout.write("node-pty ok\n")' >>"$REPORT" 2>&1 \
  || fail "node-pty native module unavailable"
pass "environment + native PTY dependency"

log "[L1] pure reducers and attach protocol"
bun test \
  src/runtime/grok-child-env.test.ts \
  src/runtime/grok-build-cli.test.ts \
  src/runtime/grok-build-cli-home.test.ts \
  src/credential-redaction.test.ts \
  src/private-log.test.ts \
  src/reply-reliability.test.ts \
  src/goals/store.test.ts \
  src/runtime/grok-copresence/state.test.ts \
  src/runtime/grok-copresence/jsonl.test.ts \
  src/runtime/grok-copresence/attach.test.ts \
  ../agent-network/src/grok-attach-client.test.ts \
  ../agent-network/src/grok-copresence-profile.test.ts \
  ../agent-network/src/normalize-runtime.test.ts \
  >>"$REPORT" 2>&1 || fail "state/jsonl/attach tests"
pass "state machine + JSONL reducer + local attach protocol"

log "[L2] single-PTY runtime integration"
bun test src/runtime/grok-copresence/runtime.test.ts >>"$REPORT" 2>&1 \
  || fail "runtime integration tests"
pass "FIFO/human arbitration + final reply + approval + reconnect + single bridge"

log "[L3] package build and CLI integration"
npm run build >>"$REPORT" 2>&1 || fail "agent-node build"
cd "$ROOT/agent-network"
npm run typecheck >>"$REPORT" 2>&1 || fail "agent-network typecheck"
bun build bin/cli.ts --outfile /tmp/anet-cli.js --target node >>"$REPORT" 2>&1 \
  || fail "agent-network CLI build"
pass "agent-node + anet CLI builds"

PASSED=$(awk '$2 == "pass" { total += $1 } END { print total + 0 }' "$REPORT")
FAILED=$(awk '$2 == "fail" { total += $1 } END { print total + 0 }' "$REPORT")
log "Summary: PASS ($PASSED tests, $FAILED failures; all validation ran inside Docker)"

#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-$ARTIFACT_DIR/report-test575.txt}"
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"
chmod 600 "$REPORT"

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

SOURCE_COMMIT="${TEST575_SOURCE_COMMIT:-}"
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "SOURCE_COMMIT must be a full lowercase Git SHA"

log "# test575 — OpenCode shared-turn reply ownership"
log "date: $(date -Is)"
log "source_commit=$SOURCE_COMMIT"
log "[L0] isolated Docker environment"
[ ! -e /workspace/.git ] || fail "image contains repository metadata"
[ ! -e /root/.opencode ] || fail "image contains host OpenCode state"
[ ! -e /root/.anet ] || fail "image contains host Agent Network state"
pass "isolated environment"

log "[L1] idle-to-submit race reply correlation and stable Runner teardown"
cd /workspace/agent-node
bun test src/runtime/opencode-copresence/runtime.test.ts \
  -t "(refuses a reply owned by a human turn|waits past OpenCode's status-idle)" \
  >>"$REPORT" 2>&1 \
  || fail "network reply ownership regression"
pass "only the exact network message may own its reply after stable Runner teardown"

log "Summary: PASS"

#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-$ARTIFACT_DIR/report-test224.txt}"
WORK=/tmp/test224
RAW="$WORK/raw"
PACKS="$WORK/packs"
EXTRACTED="$WORK/extracted"

rm -rf "$WORK"
mkdir -p "$ARTIFACT_DIR" "$RAW" "$PACKS" "$EXTRACTED"
: >"$REPORT"
chmod 600 "$REPORT"

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

# Assemble synthetic values at runtime.  No real auth/config file is read and
# no complete marker is stored in the suite source or Docker build layers.
RUN_ID="$(date +%s)-$$"
export DATABASE_URL="postgresql://preview_user:preview_password@db.invalid/test224-${RUN_ID}"
export AWS_ACCESS_KEY_ID="AKIA$(printf '%016d' "${RUN_ID%%-*}")"
export AWS_SECRET_ACCESS_KEY="test224-aws-secret-${RUN_ID}"
export AWS_SESSION_TOKEN="test224-aws-session-${RUN_ID}"
export AWS_PREVIEW_MATERIAL="test224-aws-arbitrary-${RUN_ID}"
export ARBITRARY_TOKEN="test224-arbitrary-token-${RUN_ID}"
export ARBITRARY_SECRET="test224-arbitrary-secret-${RUN_ID}"
export ARBITRARY_KEY="test224-arbitrary-key-${RUN_ID}"
export ntok="ntok_test224_${RUN_ID//-/x}"
export utok="utok_test224_${RUN_ID//-/x}"

marker_values() {
  printf '%s\n' \
    "$DATABASE_URL" \
    "$AWS_ACCESS_KEY_ID" \
    "$AWS_SECRET_ACCESS_KEY" \
    "$AWS_SESSION_TOKEN" \
    "$AWS_PREVIEW_MATERIAL" \
    "$ARBITRARY_TOKEN" \
    "$ARBITRARY_SECRET" \
    "$ARBITRARY_KEY" \
    "$ntok" \
    "$utok"
}

scan_file_for_markers() {
  local path="$1" label="$2" marker
  while IFS= read -r marker; do
    if LC_ALL=C grep -aFq -- "$marker" "$path"; then
      fail "$label retained a synthetic credential marker"
    fi
  done < <(marker_values)
}

scan_tree_for_markers() {
  local path="$1" label="$2" marker
  while IFS= read -r marker; do
    if LC_ALL=C grep -aFrq --exclude='report-test224.txt' -- "$marker" "$path"; then
      fail "$label retained a synthetic credential marker"
    fi
  done < <(marker_values)
}

log "# test224 — Grok preview credential and package gate"
log "date: $(date -Is)"
log "network: disabled by runner"
log "source_commit=${TEST224_SOURCE_COMMIT:-uncommitted}"

log "[L0] isolated, synthetic-only environment"
[ ! -e "$ROOT/.git" ] || fail "image contains repository metadata"
[ ! -e /root/.grok ] || fail "image contains a Grok home"
[ ! -e /root/.anet ] || fail "image contains an anet home"
pass "targeted Docker context contains no host auth/config state"

log "[L1] exact child environment + durable text boundaries"
cd "$ROOT"
if ! bun test tests/test224-grok-preview-security/security-gate.test.ts >"$RAW/security-tests.log" 2>&1; then
  fail "security gate unit/integration tests failed"
fi
scan_file_for_markers "$RAW/security-tests.log" "security test output"
pass "real child env equals the reviewed set; text boundaries redact; config/session dirs are 0700 and files are 0600"

log "[L2] build candidate package payloads without network"
cd "$ROOT/agent-node"
if ! bun run build >"$RAW/agent-node-build.log" 2>&1; then
  fail "agent-node candidate build failed"
fi
cd "$ROOT/agent-network"
if ! bun run build >"$RAW/agent-network-build.log" 2>&1; then
  fail "agent-network candidate build failed"
fi

cd "$ROOT/agent-node"
if ! npm pack --ignore-scripts --json --pack-destination "$PACKS" >"$RAW/agent-node-pack.json" 2>"$RAW/agent-node-pack.err"; then
  fail "agent-node npm pack failed"
fi
cd "$ROOT/agent-network"
if ! npm pack --ignore-scripts --json --pack-destination "$PACKS" >"$RAW/agent-network-pack.json" 2>"$RAW/agent-network-pack.err"; then
  fail "agent-network npm pack failed"
fi

NODE_TGZ="$(find "$PACKS" -maxdepth 1 -type f -name 'sleep2agi-agent-node-*.tgz' -print -quit)"
NETWORK_TGZ="$(find "$PACKS" -maxdepth 1 -type f -name 'sleep2agi-agent-network-*.tgz' -print -quit)"
[ -n "$NODE_TGZ" ] || fail "agent-node candidate tarball missing"
[ -n "$NETWORK_TGZ" ] || fail "agent-network candidate tarball missing"
[ "$(find "$PACKS" -maxdepth 1 -type f -name '*.tgz' | wc -l)" -eq 2 ] \
  || fail "candidate pack directory contains an unexpected tarball count"

tar -xzf "$NODE_TGZ" -C "$EXTRACTED" --one-top-level=agent-node
tar -xzf "$NETWORK_TGZ" -C "$EXTRACTED" --one-top-level=agent-network
[ -f "$EXTRACTED/agent-node/package/dist/cli.js" ] || fail "agent-node tarball lacks dist/cli.js"
[ -f "$EXTRACTED/agent-network/package/dist/bin/cli.js" ] || fail "agent-network tarball lacks dist/bin/cli.js"
node -e '
  for (const path of process.argv.slice(1)) {
    const pkg = require(path);
    if (!/-preview\./.test(pkg.version) || pkg.publishConfig?.tag !== "preview") process.exit(1);
  }
' \
  "$EXTRACTED/agent-node/package/package.json" \
  "$EXTRACTED/agent-network/package/package.json" \
  || fail "candidate package metadata does not force the preview dist-tag"
grep -aFq 'grok-build-cli' "$EXTRACTED/agent-node/package/dist/cli.js" \
  || fail "agent-node candidate lacks grok-build-cli runtime"
grep -aFq 'grok-build-cli preview currently refuses Feishu channels' \
  "$EXTRACTED/agent-node/package/dist/cli.js" \
  || fail "agent-node candidate lacks the Grok-preview Feishu fail-closed gate"
grep -aFq 'grok-build-cli' "$EXTRACTED/agent-network/package/dist/bin/cli.js" \
  || fail "agent-network candidate lacks grok-build-cli CLI wiring"

if find "$EXTRACTED" -type f \( \
  -name '.env' -o -name 'auth.json' -o -name 'pending-replies.json' -o -name '*.pem' \
  \) -print -quit | grep -q .; then
  fail "candidate tarball contains a credential/state filename"
fi
pass "candidate tarballs contain runnable entrypoints and force publishConfig.tag=preview"

log "[L3] synthetic credential leakage scan"
scan_file_for_markers "$NODE_TGZ" "agent-node tarball"
scan_file_for_markers "$NETWORK_TGZ" "agent-network tarball"
scan_tree_for_markers "$EXTRACTED" "extracted package payload"
scan_tree_for_markers "$RAW" "build/pack/test output"
scan_file_for_markers "$REPORT" "test report"
pass "tarballs, extracted payloads, build output, test output, and report contain zero synthetic marker bytes"

log "candidate_tarball_sha256=$(sha256sum "$NODE_TGZ" | awk '{print $1}') file=$(basename "$NODE_TGZ")"
log "candidate_tarball_sha256=$(sha256sum "$NETWORK_TGZ" | awk '{print $1}') file=$(basename "$NETWORK_TGZ")"
log "Summary: PASS (Docker-only; runtime executed with network disabled; no real credential was read)"

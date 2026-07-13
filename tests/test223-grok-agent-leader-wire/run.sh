#!/usr/bin/env bash
set -euo pipefail

SUITE=/workspace/tests/test223-grok-agent-leader-wire
RAW_DIR="${RAW_DIR:-/capture-raw}"
SAFE_DIR=/tmp/test223-safe
MUTANT_DIR="$RAW_DIR/scanner-mutant"
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-$ARTIFACT_DIR/report-test223.txt}"
RAW_FIXTURES=(harness-canary.raw.ndjson)
RUN_LIVE_NATIVE="${RUN_LIVE_NATIVE:-0}"
RUN_LIVE_FRAME_AWARE="${RUN_LIVE_FRAME_AWARE:-0}"
RUN_LIVE_APPROVAL_OWNER="${RUN_LIVE_APPROVAL_OWNER:-0}"
export RAW_DIR

cleanup() {
  set +e
  rm -rf "$RAW_DIR"/* "$SAFE_DIR"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p "$RAW_DIR" "$SAFE_DIR" "$MUTANT_DIR" "$ARTIFACT_DIR"
chmod 0700 "$RAW_DIR" "$SAFE_DIR" "$MUTANT_DIR"

RAW_FS=$(findmnt -n -o FSTYPE --target "$RAW_DIR" 2>/dev/null || true)
[ "$RAW_FS" = tmpfs ] || fail "RAW_DIR must be an explicit tmpfs (got ${RAW_FS:-none})"
[ "$(stat -c %a "$RAW_DIR")" = 700 ] || fail "RAW_DIR must be mode 0700"
case "$ARTIFACT_DIR" in
  "$RAW_DIR"|"$RAW_DIR"/*) fail "artifact directory must not be inside raw tmpfs" ;;
esac

: >"$REPORT"
printf '%s\n' '# test223 — Grok agent leader wire capture harness' >>"$REPORT"
if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  printf 'date: %s\n' "$(date -u +%FT%TZ)" >>"$REPORT"
else
  printf 'date: %s\n' "$(date -u -d "@${SOURCE_DATE_EPOCH:-0}" +%FT%TZ)" >>"$REPORT"
fi
if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  printf '%s\n' 'scope: synthetic harness + owner live native capture pending independent review' >>"$REPORT"
else
  printf '%s\n' 'scope: synthetic harness validation only' >>"$REPORT"
fi
printf '%s\n' 'protocolFreeze: false' >>"$REPORT"

node "$SUITE/scripts/selftest-capture.mjs" \
  "$RAW_DIR/${RAW_FIXTURES[0]}"
printf '%s\n' 'PASS L0: recorder wrote unredacted canaries only to tmpfs' >>"$REPORT"
if node "$SUITE/scripts/selftest-capture.mjs" /tmp/test223-raw-escape.ndjson >/dev/null 2>&1; then
  fail "recorder accepted an unredacted output path outside RAW_DIR"
fi
printf '%s\n' 'PASS L0-negative: recorder rejected output outside RAW_DIR' >>"$REPORT"

if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  [ -n "${GROK_BINARY:-}" ] || fail "RUN_LIVE_NATIVE requires GROK_BINARY"
  LIVE_HOME=/tmp/test223-live-home
  LIVE_CWD=/tmp/test223-live-cwd
  rm -rf "$LIVE_HOME" "$LIVE_CWD"
  install -d -m 0700 "$LIVE_HOME" "$LIVE_CWD"
  export HOME="$LIVE_HOME" GROK_HOME="$LIVE_HOME" PROOF_CWD="$LIVE_CWD"
  if [ -f /host-grok/agent_id ]; then
    ln -s /host-grok/agent_id "$LIVE_HOME/agent_id"
  fi
  export RAW_OUTPUT="$RAW_DIR/leader-native-tui.raw.ndjson"
  if ! node "$SUITE/scripts/live-native-capture.mjs" \
    >"$RAW_DIR/leader-native-tui.summary.json"; then
    printf 'LIVE-FAIL: %s\n' \
      "$(jq -c . "$RAW_DIR/leader-native-tui.summary.json" 2>/dev/null || printf '{"ok":false,"stage":"no-summary"}')" \
      >>"$REPORT"
    fail "owner live native scenario process failed"
  fi
  jq -e '
    .schema == "test223-live-native-summary/v1"
    and .ok == true
    and .protocolFreeze == false
    and .zeroTuiStdin == true
    and .realTuiRendered == true
    and .completionSeen == true
    and .permissionRequests == 0
  ' "$RAW_DIR/leader-native-tui.summary.json" >/dev/null \
    || fail "owner live native scenario did not pass"
  RAW_FIXTURES+=(leader-native-tui.raw.ndjson)
  printf '%s\n' 'PASS L0-live-owner: pinned Leader + two native proxy listeners + real TUI rendered ACP turn' >>"$REPORT"
fi

if [ "$RUN_LIVE_FRAME_AWARE" = "1" ]; then
  [ "$RUN_LIVE_NATIVE" = "1" ] || fail "RUN_LIVE_FRAME_AWARE requires RUN_LIVE_NATIVE=1"
  export RAW_OUTPUT="$RAW_DIR/frame-aware-admission.raw.ndjson"
  if ! node "$SUITE/scripts/live-frame-aware-admission-capture.mjs" \
    >"$RAW_DIR/frame-aware-admission.summary.json"; then
    printf 'FRAME-AWARE-FAIL: %s\n' \
      "$(jq -c . "$RAW_DIR/frame-aware-admission.summary.json" 2>/dev/null || printf '{"ok":false}')" \
      >>"$REPORT"
    fail "frame-aware admission scenario process failed"
  fi
  jq -e '
    .ok == true
    and .protocolFreeze == false
    and .rejection.independentLeaderTapWindowDelta.frames == 0
    and .rejection.independentLeaderTapWindowDelta.bytes == 0
    and .tuiRecovery.originalRequestCompleted == true
    and .allowed.sessionPromptFramesForwarded == 1
    and .allowed.answerRenderedInTrueTui == true
    and .gatewayMetrics.gatewayAllFourWritersBalanced == true
    and .gatewayMetrics.liveSplitCounter > 0
    and .gatewayMetrics.liveCoalescedCounter > 0
  ' "$RAW_DIR/frame-aware-admission.summary.json" >/dev/null \
    || fail "frame-aware admission summary did not pass"
  RAW_FIXTURES+=(frame-aware-admission.raw.ndjson)
  printf '%s\n' 'PASS L0-frame-aware-owner: independent Leader tap + Busy recovery + ACP live render' >>"$REPORT"
fi

if [ "$RUN_LIVE_APPROVAL_OWNER" = "1" ]; then
  [ "$RUN_LIVE_NATIVE" = "1" ] || fail "RUN_LIVE_APPROVAL_OWNER requires RUN_LIVE_NATIVE=1"
  export RAW_OUTPUT="$RAW_DIR/live-approval-owner-matrix.raw.ndjson"
  if ! node "$SUITE/scripts/live-approval-owner-matrix-capture.mjs" \
    >"$RAW_DIR/live-approval-owner-matrix.summary.json"; then
    printf 'APPROVAL-OWNER-FAIL: %s\n' \
      "$(jq -c . "$RAW_DIR/live-approval-owner-matrix.summary.json" 2>/dev/null || printf '{"ok":false}')" \
      >>"$REPORT"
    fail "approval-owner scenario process failed"
  fi
  jq -e '
    .ok == true
    and .protocolFreeze == false
    and .primary.centralResponsesSent == 1
    and .primary.realTuiResponsesForwarded == 0
    and .ownerDisconnect.centralResponsesSent == 0
    and .safety.allowResponsesSent == 0
    and .safety.tuiInputBytesWritten == 0
  ' "$RAW_DIR/live-approval-owner-matrix.summary.json" >/dev/null \
    || fail "approval-owner summary did not pass"
  RAW_FIXTURES+=(live-approval-owner-matrix.raw.ndjson)
  printf '%s\n' 'PASS L0-approval-owner: permission fanout + reject_once + owner-loss fail-closed' >>"$REPORT"
fi

for fixture in "${RAW_FIXTURES[@]}"; do
  safe_name=${fixture/.raw.ndjson/.bytes.ndjson}
  projection_name=${fixture/.raw.ndjson/.projection.ndjson}
  node "$SUITE/scripts/sanitize.mjs" \
    "$RAW_DIR/$fixture" "$SAFE_DIR/$safe_name" "$RAW_DIR/redaction-map.json"
  node "$SUITE/scripts/project.mjs" \
    "$SAFE_DIR/$safe_name" "$SAFE_DIR/$projection_name"
done
if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  install -m 0600 "$RAW_DIR/leader-native-tui.summary.json" \
    "$SAFE_DIR/leader-native-tui.summary.json"
fi
if [ "$RUN_LIVE_FRAME_AWARE" = "1" ]; then
  install -m 0600 "$RAW_DIR/frame-aware-admission.summary.json" \
    "$SAFE_DIR/frame-aware-admission.summary.json"
fi
if [ "$RUN_LIVE_APPROVAL_OWNER" = "1" ]; then
  install -m 0600 "$RAW_DIR/live-approval-owner-matrix.summary.json" \
    "$SAFE_DIR/live-approval-owner-matrix.summary.json"
fi
printf '%s\n' 'PASS L1: stream-aware scrub produced sanitized byte records' >>"$REPORT"
printf '%s\n' 'PASS L2: independent projector rebuilt complete/truncated frames' >>"$REPORT"

node "$SUITE/scripts/verify.mjs" "$SAFE_DIR" "$SUITE"
cp "$SAFE_DIR"/* "$MUTANT_DIR"/
node "$SUITE/scripts/mutate-artifact.mjs" "$MUTANT_DIR/harness-canary.bytes.ndjson"
if node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" >/dev/null 2>&1; then
  fail "decoded-byte canary mutation did not turn the scanner red"
fi
rm -rf "$MUTANT_DIR"/*
printf '%s\n' 'PASS L3: independent decoded-byte/PII/canary scanner passed' >>"$REPORT"
printf '%s\n' 'PASS L3-negative: decoded-byte canary mutation turned scanner red' >>"$REPORT"

if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  CAPTURE_SCENARIO=live-native node "$SUITE/scripts/manifest.mjs" "$SAFE_DIR" "$SUITE"
  if [ "${PRESERVE_SAFE_CANDIDATE:-0}" = "1" ]; then
    cp "$SAFE_DIR"/* "$ARTIFACT_DIR"/
  fi
  node "$SUITE/scripts/verify-live-native.mjs" \
    "$SAFE_DIR/leader-native-tui.bytes.ndjson" \
    "$SAFE_DIR/leader-native-tui.projection.ndjson" \
    "$SAFE_DIR/leader-native-tui.summary.json" \
    "$SAFE_DIR/manifest.json" >/dev/null
  if [ "$RUN_LIVE_FRAME_AWARE" = "1" ]; then
    node "$SUITE/scripts/verify-live-frame-aware.mjs" \
      "$SAFE_DIR/frame-aware-admission.bytes.ndjson" \
      "$SAFE_DIR/frame-aware-admission.projection.ndjson" \
      "$SAFE_DIR/frame-aware-admission.summary.json" \
      "$SAFE_DIR/manifest.json" "$SUITE" >/dev/null
    printf '%s\n' 'PASS L4-frame-aware-owner: script/binary/artifact-bound Busy evidence verified' >>"$REPORT"
  fi
  if [ "$RUN_LIVE_APPROVAL_OWNER" = "1" ]; then
    node "$SUITE/scripts/verify-live-approval-owner.mjs" \
      "$SAFE_DIR/live-approval-owner-matrix.bytes.ndjson" \
      "$SAFE_DIR/live-approval-owner-matrix.projection.ndjson" \
      "$SAFE_DIR/live-approval-owner-matrix.summary.json" \
      "$SAFE_DIR/manifest.json" "$SUITE" >/dev/null
    printf '%s\n' 'PASS L4-approval-owner: permission wire fixture is source/binary/artifact-bound' >>"$REPORT"
  fi
  printf '%s\n' 'PASS L4-live-owner: sanitized live bytes/projection/summary passed structural verifier' >>"$REPORT"
else
  node "$SUITE/scripts/manifest.mjs" "$SAFE_DIR" "$SUITE"
fi
node "$SUITE/scripts/verify.mjs" "$SAFE_DIR" "$SUITE"
printf '%s\n' 'PASS L4: manifest hashes and optional pinned-binary metadata verified' >>"$REPORT"

# Evidence-binding negative control: mutate a parseable native ACP payload and
# re-sign the owner manifest while deliberately leaving the saved projection
# stale. In live mode this targets the real leader-native-tui fixture.
cp "$SAFE_DIR"/* "$MUTANT_DIR"/
if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  BINDING_STEM=leader-native-tui
else
  BINDING_STEM=harness-canary
fi
node "$SUITE/scripts/mutate-binding-artifact.mjs" native-binding \
  "$MUTANT_DIR/$BINDING_STEM.bytes.ndjson" "$MUTANT_DIR/manifest.json"
if node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" >/dev/null 2>&1; then
  fail "self-signed bytes mutation with stale projection did not turn verifier red"
fi
rm -rf "$MUTANT_DIR"/*
printf '%s\n' 'PASS L4-negative: self-signed bytes mutation with stale projection turned red' >>"$REPORT"

# Exact protocol-set controls are coherent owner fixtures: mutate sanitized
# native bytes, independently rebuild the projection, re-sign both hashes, and
# still require the verifier's external trust root to reject the artifact.
for protocol_mutation in native-binding field-name correlation-numeric correlation-label; do
  cp "$SAFE_DIR"/* "$MUTANT_DIR"/
  node "$SUITE/scripts/mutate-binding-artifact.mjs" "$protocol_mutation" \
    "$MUTANT_DIR/harness-canary.bytes.ndjson" "$MUTANT_DIR/manifest.json"
  node "$SUITE/scripts/project.mjs" \
    "$MUTANT_DIR/harness-canary.bytes.ndjson" \
    "$MUTANT_DIR/harness-canary.projection.ndjson"
  node "$SUITE/scripts/mutate-binding-artifact.mjs" resign-files \
    "$MUTANT_DIR/manifest.json" "$MUTANT_DIR/harness-canary.projection.ndjson"
  if node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" >/dev/null 2>&1; then
    fail "coherent protocol mutation did not turn verifier red: $protocol_mutation"
  fi
  rm -rf "$MUTANT_DIR"/*
done
printf '%s\n' 'PASS L4-negative: method/field/correlation coherent mutations turned red' >>"$REPORT"

cp "$SAFE_DIR"/* "$MUTANT_DIR"/
node "$SUITE/scripts/mutate-binding-artifact.mjs" metadata-unknown \
  "$MUTANT_DIR/harness-canary.bytes.ndjson" "$MUTANT_DIR/manifest.json"
if node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" >/dev/null 2>&1; then
  fail "coherent unknown metadata mutation did not turn verifier red"
fi
rm -rf "$MUTANT_DIR"/*
printf '%s\n' 'PASS L4-negative: coherent unknown metadata field turned red' >>"$REPORT"

if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  cp "$SAFE_DIR"/* "$MUTANT_DIR"/
  node "$SUITE/scripts/mutate-binding-artifact.mjs" env-coherent \
    "$MUTANT_DIR/leader-native-tui.summary.json" "$MUTANT_DIR/manifest.json"
  if node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" >/dev/null 2>&1; then
    fail "coherently re-signed forbidden child env mutation did not turn verifier red"
  fi
  rm -rf "$MUTANT_DIR"/*
  printf '%s\n' 'PASS L4-negative: coherent forbidden child env mutation turned red' >>"$REPORT"
fi

if [ "$RUN_LIVE_FRAME_AWARE" = "1" ]; then
  for frame_summary_mutation in \
    frame-summary-raw-count \
    frame-summary-writer-frame \
    frame-summary-writer-segment \
    frame-summary-writer-original-bytes; do
    cp "$SAFE_DIR"/* "$MUTANT_DIR"/
    node "$SUITE/scripts/mutate-binding-artifact.mjs" "$frame_summary_mutation" \
      "$MUTANT_DIR/frame-aware-admission.summary.json" "$MUTANT_DIR/manifest.json"
    if node "$SUITE/scripts/verify-live-frame-aware.mjs" \
      "$MUTANT_DIR/frame-aware-admission.bytes.ndjson" \
      "$MUTANT_DIR/frame-aware-admission.projection.ndjson" \
      "$MUTANT_DIR/frame-aware-admission.summary.json" \
      "$MUTANT_DIR/manifest.json" "$SUITE" >/dev/null 2>&1; then
      fail "coherent frame summary mutation did not turn red: $frame_summary_mutation"
    fi
    rm -rf "$MUTANT_DIR"/*
  done
  cp "$SAFE_DIR"/* "$MUTANT_DIR"/
  node "$SUITE/scripts/mutate-binding-artifact.mjs" frame-bytes-connection \
    "$MUTANT_DIR/frame-aware-admission.bytes.ndjson" "$MUTANT_DIR/manifest.json"
  node "$SUITE/scripts/project.mjs" \
    "$MUTANT_DIR/frame-aware-admission.bytes.ndjson" \
    "$MUTANT_DIR/frame-aware-admission.projection.ndjson"
  node "$SUITE/scripts/mutate-binding-artifact.mjs" resign-files \
    "$MUTANT_DIR/manifest.json" "$MUTANT_DIR/frame-aware-admission.projection.ndjson"
  node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" >/dev/null \
    || fail "frame tuple mutation was not coherently re-signed"
  if node "$SUITE/scripts/verify-live-frame-aware.mjs" \
    "$MUTANT_DIR/frame-aware-admission.bytes.ndjson" \
    "$MUTANT_DIR/frame-aware-admission.projection.ndjson" \
    "$MUTANT_DIR/frame-aware-admission.summary.json" \
    "$MUTANT_DIR/manifest.json" "$SUITE" >/dev/null 2>&1; then
    fail "coherent frame writer tuple mutation did not turn red"
  fi
  rm -rf "$MUTANT_DIR"/*
  printf '%s\n' 'PASS L4-negative: frame raw/writer/tuple binding mutations turned red' >>"$REPORT"
fi

if [ "$RUN_LIVE_APPROVAL_OWNER" = "1" ]; then
  cp "$SAFE_DIR"/* "$MUTANT_DIR"/
  node "$SUITE/scripts/mutate-binding-artifact.mjs" permission-method \
    "$MUTANT_DIR/live-approval-owner-matrix.bytes.ndjson" "$MUTANT_DIR/manifest.json"
  node "$SUITE/scripts/project.mjs" \
    "$MUTANT_DIR/live-approval-owner-matrix.bytes.ndjson" \
    "$MUTANT_DIR/live-approval-owner-matrix.projection.ndjson"
  node "$SUITE/scripts/mutate-binding-artifact.mjs" resign-files \
    "$MUTANT_DIR/manifest.json" "$MUTANT_DIR/live-approval-owner-matrix.projection.ndjson"
  node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" >/dev/null \
    || fail "permission method mutation was not coherently re-signed"
  if node "$SUITE/scripts/verify-live-approval-owner.mjs" \
    "$MUTANT_DIR/live-approval-owner-matrix.bytes.ndjson" \
    "$MUTANT_DIR/live-approval-owner-matrix.projection.ndjson" \
    "$MUTANT_DIR/live-approval-owner-matrix.summary.json" \
    "$MUTANT_DIR/manifest.json" "$SUITE" >/dev/null 2>&1; then
    fail "coherent permission method mutation did not turn red"
  fi
  rm -rf "$MUTANT_DIR"/*
  cp "$SAFE_DIR"/* "$MUTANT_DIR"/
  node "$SUITE/scripts/mutate-binding-artifact.mjs" approval-summary-tui-count \
    "$MUTANT_DIR/live-approval-owner-matrix.summary.json" "$MUTANT_DIR/manifest.json"
  if node "$SUITE/scripts/verify-live-approval-owner.mjs" \
    "$MUTANT_DIR/live-approval-owner-matrix.bytes.ndjson" \
    "$MUTANT_DIR/live-approval-owner-matrix.projection.ndjson" \
    "$MUTANT_DIR/live-approval-owner-matrix.summary.json" \
    "$MUTANT_DIR/manifest.json" "$SUITE" >/dev/null 2>&1; then
    fail "coherent approval summary TUI count mutation did not turn red"
  fi
  rm -rf "$MUTANT_DIR"/*
  printf '%s\n' 'PASS L4-negative: permission method/summary-count mutations turned red' >>"$REPORT"
fi

find "$ARTIFACT_DIR" -mindepth 1 -maxdepth 1 \
  ! -name 'report-test223.txt' ! -name 'README.md' -delete
install -m 0644 "$SAFE_DIR"/* "$ARTIFACT_DIR"/
node "$SUITE/scripts/verify.mjs" "$ARTIFACT_DIR" "$SUITE"

# The raw tmpfs is destroyed by the EXIT trap. No protocol freeze is self-signed.
if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  printf '%s\n' 'OWNER LIVE CAPTURE PASS: fixture awaits independent review; protocol freeze remains false' >>"$REPORT"
  printf '%s\n' 'Summary: PASS (owner live native capture; independent review pending; protocol freeze false)'
else
  printf '%s\n' 'HARNESS PASS: artifact boundary works; real Grok P0 fixtures are not captured yet' >>"$REPORT"
  printf '%s\n' 'Summary: PASS (harness only; protocol freeze remains false)'
fi

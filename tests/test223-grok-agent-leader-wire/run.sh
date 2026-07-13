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
RUN_LIVE_EXACT_TRANSPORT="${RUN_LIVE_EXACT_TRANSPORT:-0}"
REQUIRE_FULL_PHASE0="${REQUIRE_FULL_PHASE0:-0}"
export RAW_DIR
# Owner capture runs are always candidate-scoped. Accepted mode stays closed
# until a protected v3 structural attestation exists; ambient legacy digest
# parameters must not silently change this harness's trust mode.
export TEST223_LIVE_EXACT_MODE=candidate
unset TEST223_ACCEPTED_INDEX_SHA256 TEST223_ACCEPTED_SHAPES_SHA256

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

for flag_name in \
  RUN_LIVE_NATIVE RUN_LIVE_FRAME_AWARE RUN_LIVE_APPROVAL_OWNER \
  RUN_LIVE_EXACT_TRANSPORT REQUIRE_FULL_PHASE0; do
  flag_value=${!flag_name}
  case "$flag_value" in 0|1) ;; *) fail "$flag_name must be 0 or 1" ;; esac
done
FULL_PHASE0=0
if [ "$RUN_LIVE_NATIVE" = "1" ] \
  && [ "$RUN_LIVE_FRAME_AWARE" = "1" ] \
  && [ "$RUN_LIVE_APPROVAL_OWNER" = "1" ] \
  && [ "$RUN_LIVE_EXACT_TRANSPORT" = "1" ]; then
  FULL_PHASE0=1
fi
if [ "$REQUIRE_FULL_PHASE0" = "1" ] && [ "$FULL_PHASE0" != "1" ]; then
  printf '%s\n' 'FAIL: REQUIRE_FULL_PHASE0 requires all four RUN_LIVE_* flags' >&2
  exit 1
fi

cleanup() {
  set +e
  rm -rf "$RAW_DIR"/* "$SAFE_DIR"
}
trap cleanup EXIT

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
if [ "$FULL_PHASE0" = "1" ]; then
  printf '%s\n' 'scope: full owner Phase0 candidate pending independent review' >>"$REPORT"
elif [ "$RUN_LIVE_NATIVE" = "1" ]; then
  printf '%s\n' 'scope: synthetic harness + owner live native capture pending independent review' >>"$REPORT"
else
  printf '%s\n' 'scope: synthetic harness validation only' >>"$REPORT"
fi
printf 'captureProfile: native=%s frameAware=%s approvalOwner=%s exactTransport=%s full=%s\n' \
  "$RUN_LIVE_NATIVE" "$RUN_LIVE_FRAME_AWARE" "$RUN_LIVE_APPROVAL_OWNER" \
  "$RUN_LIVE_EXACT_TRANSPORT" "$FULL_PHASE0" >>"$REPORT"
printf '%s\n' 'protocolFreeze: false' >>"$REPORT"

node "$SUITE/scripts/selftest-capture.mjs" \
  "$RAW_DIR/${RAW_FIXTURES[0]}"
printf '%s\n' 'PASS L0: recorder wrote unredacted canaries only to tmpfs' >>"$REPORT"
node "$SUITE/scripts/selftest-rpc-order.mjs" >/dev/null
printf '%s\n' 'PASS L0-RPC-order: typed IDs and coalesced frame ordering fail closed' >>"$REPORT"
node "$SUITE/scripts/selftest-frame-aware-lifecycle.mjs" >/dev/null
printf '%s\n' \
  'PASS L0-frame-lifecycle: write/close/partial-tail paths fail boundedly without retry' \
  >>"$REPORT"
node "$SUITE/scripts/selftest-raw-protocol-negative-pipeline.mjs" >/dev/null
printf '%s\n' \
  'PASS L0-raw-pipeline: positive/full-chain and sanitizer-closed mutation driver selftest passed' \
  >>"$REPORT"
node "$SUITE/scripts/selftest-compile-accepted-live-exact-shapes.mjs" >/dev/null
node "$SUITE/scripts/selftest-derive-candidate-live-exact-scopes.mjs" >/dev/null
node "$SUITE/scripts/selftest-live-exact-policy.mjs" >/dev/null
printf '%s\n' \
  'PASS L0-exact-trust: candidate selector scoping passed; accepted mode closed pending protected v3 attestation' \
  >>"$REPORT"
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
  set +e
  timeout --signal=TERM --kill-after=10s 300s \
    node "$SUITE/scripts/live-frame-aware-admission-capture.mjs" \
    >"$RAW_DIR/frame-aware-admission.summary.json"
  FRAME_AWARE_RC=$?
  set -e
  if [ "$FRAME_AWARE_RC" -ne 0 ]; then
    printf 'FRAME-AWARE-FAIL: %s\n' \
      "$(jq -c . "$RAW_DIR/frame-aware-admission.summary.json" 2>/dev/null || printf '{"ok":false}')" \
      >>"$REPORT"
    if [ "$FRAME_AWARE_RC" -eq 124 ] || [ "$FRAME_AWARE_RC" -eq 137 ]; then
      fail "frame-aware admission scenario exceeded its one-shot lifecycle bound"
    fi
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
  printf '%s\n' \
    'PASS L0-approval-candidate: permission fanout + reject_once + owner-lease control EOF closed; ACP-child/human owner remain open' \
    >>"$REPORT"
fi

if [ "$RUN_LIVE_EXACT_TRANSPORT" = "1" ]; then
  [ "$RUN_LIVE_NATIVE" = "1" ] || fail "RUN_LIVE_EXACT_TRANSPORT requires RUN_LIVE_NATIVE=1"
  EXACT_RAW_DIR="$RAW_DIR/exact-transport"
  install -d -m 0700 "$EXACT_RAW_DIR"
  EXACT_SUMMARY="$SAFE_DIR/transport-exact-one-byte.summary.json"
  if ! RAW_DIR="$EXACT_RAW_DIR" RUN_POST_GREEN_CONTAINMENT=0 PRESERVE_RAW_FOR_HARNESS=1 \
    node "$SUITE/scripts/live-bounded-frame-transport-capture.mjs" >"$EXACT_SUMMARY"; then
    printf 'EXACT-TRANSPORT-FAIL: %s\n' \
      "$(jq -c . "$EXACT_SUMMARY" 2>/dev/null || printf '{"ok":false}')" \
      >>"$REPORT"
    fail "exact one-byte buffered transport scenario process failed"
  fi
  jq -e '
    .ok == true
    and .protocolFreeze == false
    and .exactOneByteBufferedGateway.requestedTrials == 100
    and .exactOneByteBufferedGateway.passedTrials == 100
    and .exactOneByteBufferedGateway.failedTrials == 0
    and .exactOneByteBufferedGateway.requestedSegmentsPerTrial
      == .exactOneByteBufferedGateway.requestedBytesPerTrial
    and .exactOneByteBufferedGateway.interSegmentDelayMs == 1
    and .exactOneByteBufferedGateway.aggregate.totals.admittedFrames == 200
    and .exactOneByteBufferedGateway.aggregate.totals.upstreamWriteCallbacks == 200
    and .containment.requested == false
    and .rawCapture.persistedOutsideTmpfs == false
    and .rawCapture.destroyedByHarnessCleanup == true
  ' "$EXACT_SUMMARY" >/dev/null || fail "exact one-byte buffered transport summary did not pass"
  RAW_DIR="$EXACT_RAW_DIR" node "$SUITE/scripts/extract-exact-transport-sample.mjs" \
    "$EXACT_RAW_DIR/bounded-frame-transport.raw.ndjson" \
    "$EXACT_SUMMARY" \
    "$EXACT_RAW_DIR/transport-exact-one-byte.raw.ndjson" \
    "$SAFE_DIR/transport-exact-trials.summary.json" \
    >"$SAFE_DIR/transport-extract.summary.json"
  mv "$EXACT_RAW_DIR/transport-exact-one-byte.raw.ndjson" \
    "$RAW_DIR/transport-exact-one-byte.raw.ndjson"
  rm -rf "$EXACT_RAW_DIR"
  RAW_FIXTURES+=(transport-exact-one-byte.raw.ndjson)
  printf '%s\n' 'PASS L0-exact-transport-owner: buffered gateway passed exact 1-byte+1ms register+initialize 100/100' >>"$REPORT"
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
if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  # Use the same driver for the positive fixture and every raw protocol
  # mutation.  A negative is accepted only when that shared pipeline closes at
  # the sanitizer boundary; if it reaches project/manifest/verify, the driver
  # itself fails.  Neither mutable raw bytes nor its map leave tmpfs.
  RAW_PIPELINE_COMMON=(
    --raw-fixture "$RAW_DIR/leader-native-tui.raw.ndjson"
    --baseline-safe-dir "$SAFE_DIR"
    --suite-dir "$SUITE"
    --fixture-stem leader-native-tui
    --policy-mode suite
    --capture-scenario live-native
  )
  RAW_PIPELINE_POSITIVE=$(node \
    "$SUITE/scripts/run-raw-protocol-negative-pipeline.mjs" \
    "${RAW_PIPELINE_COMMON[@]}" --mutation none)
  jq -e '
    .ok == true
    and .expected == "verify-pass"
    and .verifierAccepted == true
    and ([.stages[].stage] == ["mutate","sanitize","project","manifest","verify"])
  ' <<<"$RAW_PIPELINE_POSITIVE" >/dev/null \
    || fail "raw protocol positive control did not traverse the complete pipeline"
  for raw_protocol_mutation in \
    method-unknown enum-unknown enum-cross-context enum-wrong-type; do
    RAW_PIPELINE_NEGATIVE=$(node \
      "$SUITE/scripts/run-raw-protocol-negative-pipeline.mjs" \
      "${RAW_PIPELINE_COMMON[@]}" --mutation "$raw_protocol_mutation")
    jq -e '
      .ok == true
      and .expected == "sanitize-closed"
      and .failedStage == "sanitize"
      and .verifierAccepted == false
      and ([.stages[].stage] == ["mutate","sanitize"])
      and .candidateArtifactsPersisted == false
    ' <<<"$RAW_PIPELINE_NEGATIVE" >/dev/null \
      || fail "raw protocol mutation did not close in the shared pipeline: $raw_protocol_mutation"
  done
  printf '%s\n' \
    'PASS L2-negative: raw exact-set mutations closed in the bound full-chain driver' \
    >>"$REPORT"
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
    printf '%s\n' \
      'PASS L4-approval-candidate: policy-control EOF evidence is source/binary/artifact-bound; human owner remains open' \
      >>"$REPORT"
  fi
  if [ "$RUN_LIVE_EXACT_TRANSPORT" = "1" ]; then
    node "$SUITE/scripts/verify-live-exact-transport.mjs" \
      "$SAFE_DIR/transport-exact-one-byte.bytes.ndjson" \
      "$SAFE_DIR/transport-exact-one-byte.projection.ndjson" \
      "$SAFE_DIR/transport-exact-one-byte.summary.json" \
      "$SAFE_DIR/transport-extract.summary.json" \
      "$SAFE_DIR/transport-exact-trials.summary.json" \
      "$SAFE_DIR/manifest.json" "$SUITE" >/dev/null
    printf '%s\n' 'PASS L4-exact-transport-owner: exact 100/100 transport evidence is script/binary/artifact-bound' >>"$REPORT"
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
BEFORE_BINDING_BYTES=$(sha256sum "$MUTANT_DIR/$BINDING_STEM.bytes.ndjson" | cut -d' ' -f1)
BEFORE_BINDING_PROJECTION=$(sha256sum "$MUTANT_DIR/$BINDING_STEM.projection.ndjson" | cut -d' ' -f1)
node "$SUITE/scripts/mutate-binding-artifact.mjs" native-binding \
  "$MUTANT_DIR/$BINDING_STEM.bytes.ndjson" "$MUTANT_DIR/manifest.json"
AFTER_BINDING_BYTES=$(sha256sum "$MUTANT_DIR/$BINDING_STEM.bytes.ndjson" | cut -d' ' -f1)
AFTER_BINDING_PROJECTION=$(sha256sum "$MUTANT_DIR/$BINDING_STEM.projection.ndjson" | cut -d' ' -f1)
[ "$BEFORE_BINDING_BYTES" != "$AFTER_BINDING_BYTES" ] \
  || fail "binding mutation did not change sanitized native bytes"
[ "$BEFORE_BINDING_PROJECTION" = "$AFTER_BINDING_PROJECTION" ] \
  || fail "binding mutation unexpectedly changed saved projection"
[ "$(jq -r --arg path "$BINDING_STEM.bytes.ndjson" \
  '.fixtureFiles[] | select(.path == $path) | .sha256' "$MUTANT_DIR/manifest.json")" \
  = "$AFTER_BINDING_BYTES" ] || fail "binding mutation manifest hash does not match mutated bytes"
node "$SUITE/scripts/project.mjs" \
  "$MUTANT_DIR/$BINDING_STEM.bytes.ndjson" \
  "$MUTANT_DIR/$BINDING_STEM.fresh.projection.ndjson"
if cmp -s "$MUTANT_DIR/$BINDING_STEM.fresh.projection.ndjson" \
  "$MUTANT_DIR/$BINDING_STEM.projection.ndjson"; then
  fail "binding mutation did not make the saved projection stale"
fi
rm "$MUTANT_DIR/$BINDING_STEM.fresh.projection.ndjson"
set +e
node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" \
  >/dev/null 2>"$MUTANT_DIR/binding.stderr"
BINDING_RC=$?
set -e
[ "$BINDING_RC" -ne 0 ] || fail "self-signed bytes mutation with stale projection stayed green"
grep -F "saved projection is not byte-bound to sanitized fixture: $BINDING_STEM" \
  "$MUTANT_DIR/binding.stderr" >/dev/null \
  || fail "binding mutation failed for an unrelated reason"
rm -rf "$MUTANT_DIR"/*
printf '%s\n' 'PASS L4-negative: self-signed bytes mutation with stale projection turned red' >>"$REPORT"

# Exact protocol-set controls are coherent owner fixtures: mutate sanitized
# native bytes, independently rebuild the projection, re-sign both hashes, and
# still require the verifier's external trust root to reject the artifact.
PROTOCOL_MUTATIONS=(
  method-unknown
  field-name
  enum-unknown
  enum-cross-context
  enum-wrong-type
  correlation-numeric
  correlation-label
  method-generic-placeholder
)
if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  PROTOCOL_MUTATIONS+=(field-cross-context client-type-wrong-label)
fi
for protocol_mutation in "${PROTOCOL_MUTATIONS[@]}"; do
  cp "$SAFE_DIR"/* "$MUTANT_DIR"/
  node "$SUITE/scripts/mutate-binding-artifact.mjs" "$protocol_mutation" \
    "$MUTANT_DIR/$BINDING_STEM.bytes.ndjson" "$MUTANT_DIR/manifest.json"
  node "$SUITE/scripts/project.mjs" \
    "$MUTANT_DIR/$BINDING_STEM.bytes.ndjson" \
    "$MUTANT_DIR/$BINDING_STEM.projection.ndjson"
  node "$SUITE/scripts/mutate-binding-artifact.mjs" resign-files \
    "$MUTANT_DIR/manifest.json" "$MUTANT_DIR/$BINDING_STEM.projection.ndjson"
  if node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" >/dev/null 2>&1; then
    fail "coherent protocol mutation did not turn verifier red: $protocol_mutation"
  fi
  rm -rf "$MUTANT_DIR"/*
done
printf '%s\n' \
  'PASS L4-negative: method/field/path-enum/client-type/correlation coherent mutations turned red' \
  >>"$REPORT"

if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  # A legal capture name cannot move a live fixture into the synthetic policy
  # context. The combined mutation also uses the old generic method placeholder
  # form so either missing guard would make this coherent artifact stay green.
  cp "$SAFE_DIR"/* "$MUTANT_DIR"/
  node "$SUITE/scripts/mutate-binding-artifact.mjs" capture-cross-context-method \
    "$MUTANT_DIR/leader-native-tui.bytes.ndjson" "$MUTANT_DIR/manifest.json"
  node "$SUITE/scripts/project.mjs" \
    "$MUTANT_DIR/leader-native-tui.bytes.ndjson" \
    "$MUTANT_DIR/leader-native-tui.projection.ndjson"
  node "$SUITE/scripts/mutate-binding-artifact.mjs" resign-files \
    "$MUTANT_DIR/manifest.json" "$MUTANT_DIR/leader-native-tui.projection.ndjson"
  set +e
  node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" \
    >/dev/null 2>"$MUTANT_DIR/capture-cross-context.stderr"
  CAPTURE_CONTEXT_RC=$?
  set -e
  [ "$CAPTURE_CONTEXT_RC" -ne 0 ] \
    || fail "capture cross-context + generic method mutation stayed green"
  grep -F 'capture differs from reviewed fixture binding' \
    "$MUTANT_DIR/capture-cross-context.stderr" >/dev/null \
    || fail "capture cross-context mutation failed for an unrelated reason"
  rm -rf "$MUTANT_DIR"/*

  # The synthetic context itself must reject a method-shaped generic
  # placeholder, independently of the fixture/capture binding above.
  cp "$SAFE_DIR"/* "$MUTANT_DIR"/
  node "$SUITE/scripts/mutate-binding-artifact.mjs" method-generic-placeholder \
    "$MUTANT_DIR/harness-canary.bytes.ndjson" "$MUTANT_DIR/manifest.json"
  node "$SUITE/scripts/project.mjs" \
    "$MUTANT_DIR/harness-canary.bytes.ndjson" \
    "$MUTANT_DIR/harness-canary.projection.ndjson"
  node "$SUITE/scripts/mutate-binding-artifact.mjs" resign-files \
    "$MUTANT_DIR/manifest.json" "$MUTANT_DIR/harness-canary.projection.ndjson"
  set +e
  node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" \
    >/dev/null 2>"$MUTANT_DIR/harness-method.stderr"
  HARNESS_METHOD_RC=$?
  set -e
  [ "$HARNESS_METHOD_RC" -ne 0 ] || fail "synthetic generic method mutation stayed green"
  grep -F 'method is outside reviewed exact set' \
    "$MUTANT_DIR/harness-method.stderr" >/dev/null \
    || fail "synthetic generic method mutation failed for an unrelated reason"
  rm -rf "$MUTANT_DIR"/*
  printf '%s\n' \
    'PASS L4-negative: fixture/capture cross-context and synthetic generic method mutations turned red' \
    >>"$REPORT"
fi

for metadata_mutation in metadata-unknown metadata-value-unknown; do
  cp "$SAFE_DIR"/* "$MUTANT_DIR"/
  node "$SUITE/scripts/mutate-binding-artifact.mjs" "$metadata_mutation" \
    "$MUTANT_DIR/$BINDING_STEM.bytes.ndjson" "$MUTANT_DIR/manifest.json"
  if node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" >/dev/null 2>&1; then
    fail "coherent metadata mutation did not turn verifier red: $metadata_mutation"
  fi
  rm -rf "$MUTANT_DIR"/*
done
printf '%s\n' 'PASS L4-negative: coherent unknown metadata key/value turned red' >>"$REPORT"

cp "$SAFE_DIR"/* "$MUTANT_DIR"/
node "$SUITE/scripts/mutate-binding-artifact.mjs" manifest-capture-profile \
  "$MUTANT_DIR/manifest.json"
set +e
node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" \
  >/dev/null 2>"$MUTANT_DIR/capture-profile.stderr"
CAPTURE_PROFILE_RC=$?
set -e
[ "$CAPTURE_PROFILE_RC" -ne 0 ] || fail "manifest capture profile mutation stayed green"
grep -F 'manifest capture profile is not artifact-derived' \
  "$MUTANT_DIR/capture-profile.stderr" >/dev/null \
  || fail "manifest capture profile mutation failed for an unrelated reason"
rm -rf "$MUTANT_DIR"/*
printf '%s\n' 'PASS L4-negative: manifest capture profile mutation turned red' >>"$REPORT"

if [ "$RUN_LIVE_NATIVE" = "1" ]; then
  for forbidden_env_key in \
    DATABASE_URL COMMHUB_ENDPOINT AWS_REGION CUSTOMER_TOKEN CUSTOMER_SECRET CUSTOMER_KEY; do
    cp "$SAFE_DIR"/* "$MUTANT_DIR"/
    node "$SUITE/scripts/mutate-binding-artifact.mjs" env-coherent \
      "$MUTANT_DIR/leader-native-tui.summary.json" "$MUTANT_DIR/manifest.json" \
      "$forbidden_env_key"
    set +e
    node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" \
      >/dev/null 2>"$MUTANT_DIR/env.stderr"
    ENV_RC=$?
    set -e
    [ "$ENV_RC" -ne 0 ] || fail "coherent child env mutation stayed green: $forbidden_env_key"
    grep -F 'manifest env evidence contains a forbidden child key' \
      "$MUTANT_DIR/env.stderr" >/dev/null \
      || fail "child env mutation failed for an unrelated reason: $forbidden_env_key"
    rm -rf "$MUTANT_DIR"/*
  done
  printf '%s\n' 'PASS L4-negative: six coherent forbidden child env classes turned red' >>"$REPORT"
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
  set +e
  node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" \
    >/dev/null 2>"$MUTANT_DIR/permission-generic.stderr"
  PERMISSION_GENERIC_RC=$?
  set -e
  [ "$PERMISSION_GENERIC_RC" -ne 0 ] \
    || fail "permission method mutation stayed green in exact context verifier"
  grep -E 'selector is outside exact live policy|shape/scalar is outside exact live policy' \
    "$MUTANT_DIR/permission-generic.stderr" >/dev/null \
    || fail "permission method mutation failed generic verification for an unrelated reason"
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
  for approval_safe_binding_mutation in \
    approval-raw-byte-metadata-injection \
    approval-tap-crosslane-metadata; do
    cp "$SAFE_DIR"/* "$MUTANT_DIR"/
    node "$SUITE/scripts/mutate-binding-artifact.mjs" "$approval_safe_binding_mutation" \
      "$MUTANT_DIR/live-approval-owner-matrix.bytes.ndjson" \
      "$MUTANT_DIR/manifest.json"
    node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" >/dev/null \
      || fail "approval safe binding mutation broke generic evidence binding: $approval_safe_binding_mutation"
    set +e
    node "$SUITE/scripts/verify-live-approval-owner.mjs" \
      "$MUTANT_DIR/live-approval-owner-matrix.bytes.ndjson" \
      "$MUTANT_DIR/live-approval-owner-matrix.projection.ndjson" \
      "$MUTANT_DIR/live-approval-owner-matrix.summary.json" \
      "$MUTANT_DIR/manifest.json" "$SUITE" \
      >/dev/null 2>"$MUTANT_DIR/approval-safe-binding.stderr"
    APPROVAL_SAFE_BINDING_RC=$?
    set -e
    [ "$APPROVAL_SAFE_BINDING_RC" -ne 0 ] \
      || fail "approval safe binding mutation stayed green: $approval_safe_binding_mutation"
    case "$approval_safe_binding_mutation" in
      approval-raw-byte-metadata-injection)
        grep -F 'approval safe fixture contains unverifiable raw-byte metadata' \
          "$MUTANT_DIR/approval-safe-binding.stderr" >/dev/null \
          || fail "approval raw-byte metadata mutation failed for an unrelated reason"
        ;;
      approval-tap-crosslane-metadata)
        grep -F 'approval tap byte tuple is outside reviewed topology' \
          "$MUTANT_DIR/approval-safe-binding.stderr" >/dev/null \
          || fail "approval tap tuple mutation failed for an unrelated reason"
        ;;
    esac
    rm -rf "$MUTANT_DIR"/*
  done
  for approval_policy_mutation in \
    passive-forwarded \
    stale-forwarded \
    duplicate-forwarded \
    ownerlost-forwarded \
    nonowner-consumes-pending \
    post-eof-central-response \
    tui-attempt-forwarded \
    passive-cancelled-forwarded \
    passive-error-forwarded \
    passive-selected-crossed \
    stale-selected-crossed \
    duplicate-selected-crossed \
    ownerlost-selected-crossed \
    late-selected-after-window; do
    cp "$SAFE_DIR"/* "$MUTANT_DIR"/
    node "$SUITE/scripts/mutate-approval-policy-artifact.mjs" \
      "$approval_policy_mutation" \
      "$MUTANT_DIR/live-approval-owner-matrix.bytes.ndjson" \
      "$MUTANT_DIR/live-approval-owner-matrix.projection.ndjson" \
      "$MUTANT_DIR/manifest.json" \
      "$MUTANT_DIR/live-approval-owner-matrix.summary.json"
    node "$SUITE/scripts/project.mjs" \
      "$MUTANT_DIR/live-approval-owner-matrix.bytes.ndjson" \
      "$MUTANT_DIR/live-approval-owner-matrix.projection.ndjson"
    node "$SUITE/scripts/mutate-binding-artifact.mjs" resign-files \
      "$MUTANT_DIR/manifest.json" \
      "$MUTANT_DIR/live-approval-owner-matrix.projection.ndjson"
    case "$approval_policy_mutation" in
      passive-cancelled-forwarded|passive-error-forwarded)
        set +e
        node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" \
          >/dev/null 2>"$MUTANT_DIR/approval-generic.stderr"
        APPROVAL_GENERIC_RC=$?
        set -e
        [ "$APPROVAL_GENERIC_RC" -ne 0 ] \
          || fail "unobserved permission response shape passed exact protocol policy: $approval_policy_mutation"
        grep -F 'shape/scalar is outside exact live policy' \
          "$MUTANT_DIR/approval-generic.stderr" >/dev/null \
          || fail "unobserved permission response failed generic verification for an unrelated reason: $approval_policy_mutation"
        ;;
      *)
        node "$SUITE/scripts/verify.mjs" "$MUTANT_DIR" "$SUITE" >/dev/null \
          || fail "approval policy mutation broke generic evidence binding: $approval_policy_mutation"
        ;;
    esac
    set +e
    node "$SUITE/scripts/verify-live-approval-owner.mjs" \
      "$MUTANT_DIR/live-approval-owner-matrix.bytes.ndjson" \
      "$MUTANT_DIR/live-approval-owner-matrix.projection.ndjson" \
      "$MUTANT_DIR/live-approval-owner-matrix.summary.json" \
      "$MUTANT_DIR/manifest.json" "$SUITE" \
      >/dev/null 2>"$MUTANT_DIR/approval-policy.stderr"
    APPROVAL_POLICY_RC=$?
    set -e
    [ "$APPROVAL_POLICY_RC" -ne 0 ] \
      || fail "approval policy mutation stayed green: $approval_policy_mutation"
    case "$approval_policy_mutation" in
      late-selected-after-window)
        grep -F 'approval correlated Leader-facing response exists outside its policy window' \
          "$MUTANT_DIR/approval-policy.stderr" >/dev/null \
          || fail "approval late response mutation failed for an unrelated reason"
        ;;
      post-eof-central-response|tui-attempt-forwarded|passive-cancelled-forwarded|passive-error-forwarded|*-selected-crossed)
        grep -F 'policy decision window differs from independent Leader-facing tap delta' \
          "$MUTANT_DIR/approval-policy.stderr" >/dev/null \
          || fail "approval policy mutation failed for an unrelated reason: $approval_policy_mutation"
        ;;
      *)
        grep -F 'policy replay decision mismatch' \
          "$MUTANT_DIR/approval-policy.stderr" >/dev/null \
          || fail "approval policy mutation failed for an unrelated reason: $approval_policy_mutation"
        ;;
    esac
    rm -rf "$MUTANT_DIR"/*
  done
  printf '%s\n' \
    'PASS L4-negative: permission method/summary plus fourteen Leader-boundary admission/tap mutations turned red' \
    >>"$REPORT"
fi

if [ "$RUN_LIVE_EXACT_TRANSPORT" = "1" ]; then
  cp "$SAFE_DIR"/* "$MUTANT_DIR"/
  node "$SUITE/scripts/mutate-binding-artifact.mjs" exact-transport-summary-count \
    "$MUTANT_DIR/transport-exact-one-byte.summary.json" "$MUTANT_DIR/manifest.json"
  if node "$SUITE/scripts/verify-live-exact-transport.mjs" \
    "$MUTANT_DIR/transport-exact-one-byte.bytes.ndjson" \
    "$MUTANT_DIR/transport-exact-one-byte.projection.ndjson" \
    "$MUTANT_DIR/transport-exact-one-byte.summary.json" \
    "$MUTANT_DIR/transport-extract.summary.json" \
    "$MUTANT_DIR/transport-exact-trials.summary.json" \
    "$MUTANT_DIR/manifest.json" "$SUITE" >/dev/null 2>&1; then
    fail "coherent exact transport summary mutation did not turn red"
  fi
  rm -rf "$MUTANT_DIR"/*
  cp "$SAFE_DIR"/* "$MUTANT_DIR"/
  node "$SUITE/scripts/mutate-binding-artifact.mjs" exact-transport-ledger-count \
    "$MUTANT_DIR/transport-exact-trials.summary.json" "$MUTANT_DIR/manifest.json"
  if node "$SUITE/scripts/verify-live-exact-transport.mjs" \
    "$MUTANT_DIR/transport-exact-one-byte.bytes.ndjson" \
    "$MUTANT_DIR/transport-exact-one-byte.projection.ndjson" \
    "$MUTANT_DIR/transport-exact-one-byte.summary.json" \
    "$MUTANT_DIR/transport-extract.summary.json" \
    "$MUTANT_DIR/transport-exact-trials.summary.json" \
    "$MUTANT_DIR/manifest.json" "$SUITE" >/dev/null 2>&1; then
    fail "coherent exact transport trial-ledger mutation did not turn red"
  fi
  rm -rf "$MUTANT_DIR"/*
  printf '%s\n' 'PASS L4-negative: coherent exact transport summary/ledger mutations turned red' >>"$REPORT"
fi

find "$ARTIFACT_DIR" -mindepth 1 -maxdepth 1 \
  ! -name 'report-test223.txt' ! -name 'README.md' -delete
install -m 0644 "$SAFE_DIR"/* "$ARTIFACT_DIR"/
node "$SUITE/scripts/verify.mjs" "$ARTIFACT_DIR" "$SUITE"

# The raw tmpfs is destroyed by the EXIT trap. No protocol freeze is self-signed.
if [ "$FULL_PHASE0" = "1" ]; then
  printf '%s\n' 'OWNER FULL PHASE0 CANDIDATE PASS: independent review pending; protocol freeze remains false' >>"$REPORT"
  printf '%s\n' 'Summary: PASS (full owner Phase0 candidate; independent review pending; protocol freeze false)'
elif [ "$RUN_LIVE_NATIVE" = "1" ]; then
  printf '%s\n' 'OWNER PARTIAL LIVE CAPTURE PASS: not a full Phase0 candidate; independent review pending; protocol freeze false' >>"$REPORT"
  printf '%s\n' 'Summary: PASS (partial owner live capture only; independent review pending; protocol freeze false)'
else
  printf '%s\n' 'HARNESS PASS: artifact boundary works; real Grok P0 fixtures are not captured yet' >>"$REPORT"
  printf '%s\n' 'Summary: PASS (harness only; protocol freeze remains false)'
fi

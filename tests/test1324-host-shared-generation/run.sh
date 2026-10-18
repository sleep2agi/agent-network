#!/usr/bin/env bash
# test1324 / #1324 — bind a REAL host-shared serve process to a PROVEN generation.
#
# Isolated suite: the run phase uses `--network none` (loopback still works), no
# credentials, no daemon, no lifecycle change. The build phase installs the real
# accepted V2 package (and a real V1 one for the negative).
set -euo pipefail
unset TMUX TMUX_PANE
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
export ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
mkdir -p "$ARTIFACT_DIR"
exec > >(tee "$ARTIFACT_DIR/report-test1324-runtime.txt") 2>&1
echo "test1324 host-shared generation binding source=${SOURCE_COMMIT:-unset} date=$(date -Is)"
if [[ -n "${EXPECTED_SOURCE_COMMIT:-}" ]]; then test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"; fi

cd /opt/node_modules/@sleep2agi/agent-node
echo 'L0: unit controls for every reason (injected /proc + attestation)'
bun test src/runtime/opencode-host-shared-generation.test.ts

echo 'guard: the adapter must not reach for credentials, a registry, or the daemon path'
strip_comments() { awk '{ sub(/\/\/.*/, "") } { print }' "$1"; }
if strip_comments src/runtime/opencode-host-shared-generation.ts \
   | grep -nE "passwordFile|opencode-shared-server\.json|create-node-daemon|clientBinDir"; then
  echo 'FAIL: adapter reaches outside the documented binding surface' >&2
  exit 1
fi
if ! strip_comments src/runtime/opencode-host-shared-generation.ts | grep -q "resolvePinnedOpencodeBinaryAttestation"; then
  echo 'FAIL: adapter must reuse the existing package/file attestation' >&2
  exit 1
fi
if ! strip_comments src/runtime/opencode-host-shared-generation.ts | grep -q "revalidatePinnedOpencodeBinary"; then
  echo 'FAIL: adapter must re-validate before returning' >&2
  exit 1
fi

echo 'real evidence: a REAL V2 serve must bind; look-alikes must not'
bun /test1324/integration.ts

echo 'PASS: host-shared generation binding suite'

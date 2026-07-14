#!/usr/bin/env bash
# Layer 5: exact real Codex 0.144.0 on exact Node 20.20, after 384-387.

set -euo pipefail

REPORT="${REPORT:-/repo/docs/tests/report-test388.txt}"
PREREQ_REPORT_DIR="${PREREQ_REPORT_DIR:-/repo/docs/tests}"
mkdir -p "$(dirname "$REPORT")"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test388-rfc030-real-codex-node20"
echo
echo "date: $(date -Iseconds)"
echo "node: $(node --version)"
echo "script: $(script --version | head -1)"
echo "layer: 5 (run only after test384 -> test385 -> test386 -> test387 pass)"
echo

echo "## S0 prerequisite reports (strict order)"
for n in 384 385 386 387; do
  prerequisite="${PREREQ_REPORT_DIR}/report-test${n}.txt"
  if [[ ! -f "$prerequisite" ]]; then
    echo "FAIL: prerequisite report missing: $prerequisite"
    exit 1
  fi
  if ! grep -qx 'OVERALL: PASS' "$prerequisite"; then
    echo "FAIL: prerequisite test${n} has no exact OVERALL: PASS marker"
    exit 1
  fi
  echo "test${n}: PASS evidence present"
done

echo
echo "## S1 exact container/runtime/package versions"
if [[ "$(node --version)" != "v20.20.0" ]]; then
  echo "FAIL: expected exact Node v20.20.0"
  exit 1
fi
codex_package_version="$(node -p "require('/opt/rfc030-real-codex/node_modules/@openai/codex/package.json').version")"
if [[ "$codex_package_version" != "0.144.0" ]]; then
  echo "FAIL: expected exact @openai/codex package 0.144.0, got $codex_package_version"
  exit 1
fi
codex_version="$($RFC030_CODEX_BIN --version)"
if [[ "$codex_version" != "codex-cli 0.144.0" ]]; then
  echo "FAIL: expected exact codex-cli 0.144.0, got $codex_version"
  exit 1
fi
echo "@openai/codex package: $codex_package_version (exact)"
echo "codex binary: $codex_version (exact)"

echo
echo "## S2 production dual baseline gate"
node /repo/tests/test388-rfc030-real-codex-node20/baseline-probe.mjs

echo
echo "## S3 real PTY/Upgrade/bearer/account-read bootstrap + env mutation-red"
cd /repo/agent-node
smoke_evidence="$(mktemp /tmp/rfc030-real-codex-smoke.XXXXXX)"
trap 'rm -f "$smoke_evidence"' EXIT
node scripts/rfc030-real-cli-e2e.mjs | tee "$smoke_evidence"
grep -q '^  ok  child env exact-set (probed under PTY' "$smoke_evidence"
grep -q '^  ok  mutation red: COMMHUB_TOKEN refused by buildAllowlistEnv$' "$smoke_evidence"
grep -q '^  ok  Codex first authorizer call is exactly account/read$' "$smoke_evidence"
grep -q '^real CLI bootstrap smoke PASS: 12/12$' "$smoke_evidence"
echo "real PTY + HTTP Upgrade + bearer acceptance: PASS (account/read reached the authorizer)"
rm -f "$smoke_evidence"
trap - EXIT

echo
echo "OVERALL: PASS"

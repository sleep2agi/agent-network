#!/usr/bin/env bash
set -euo pipefail
cd /workspace
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:?}"
echo "TEST ONLY source=$SOURCE_COMMIT"
if [[ "${1:-}" == docs ]]; then
  python3 scripts/check-doc-version-claims.py --selftest
  for spec in agent-network:2.3.0-preview.162 agent-node:2.5.0-preview.128 commhub-server:0.9.0-preview.120; do
    python3 scripts/check-doc-version-claims.py --package "${spec%%:*}" --version "${spec#*:}" --verify-latest-from-npm
  done
  exit 0
fi
command -v bun >/dev/null
command -v node >/dev/null
command -v git >/dev/null
test "$(node agent-network/dist/bin/anet.cjs --version | sed -n '1p')" = 'anet v2.3.0-preview.162'
node agent-node/dist/cli.js --help > /tmp/test539-runtime-help.txt
grep -q 'opencode-cli' /tmp/test539-runtime-help.txt
echo 'PASS compiled CLI version and runtime help'
for spec in 0.9.0-preview.120 2.5.0-preview.128 2.3.0-preview.162; do
  file="docs/tests/release-v$spec.md"
  grep -qx '## Install' "$file"
  grep -qx '## Upgrade' "$file"
  awk '/^## Install$/{inside=1;next} /^## /{inside=0} inside' "$file" | grep -Fq "@$spec"
done
echo 'PASS release-note Install/Upgrade/version shape'

# Test the claimed random bootstrap password with the actual compiled CLI.
# Only the loopback Hub is a fixture; no real credentials leave the container.
case_dir=$(mktemp -d /tmp/test539-bootstrap.XXXXXX)
mkdir -m 700 "$case_dir/home"
bun tests/test661-explicit-bootstrap-db/db-tool.ts seed "$case_dir/hub.db"
TEST661_PORT=25661 TEST661_READY_FILE="$case_dir/ready" \
  bun tests/test661-explicit-bootstrap-db/fixture-server.ts >"$case_dir/hub.log" 2>&1 &
fixture_pid=$!
trap 'kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do [[ -s "$case_dir/ready" ]] && break; sleep 0.1; done
test -s "$case_dir/ready"
HOME="$case_dir/home" COMMHUB_DB="$case_dir/hub.db" \
  timeout 25 node agent-network/dist/bin/anet.cjs hub start --port 25661 \
  >"$case_dir/cli.log" 2>&1
grep -Eq 'password:.*anet-[0-9a-f]{22}([[:space:]]|$)' "$case_dir/cli.log"
echo 'PASS compiled CLI random-bootstrap-password shape (credential not printed)'
echo 'PASS candidate smoke; not native V2, release artifact or production acceptance'

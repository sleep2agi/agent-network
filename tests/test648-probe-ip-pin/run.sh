#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test648-probe-ip-pin.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1
cd /workspace

echo "# test648 — pre-validated DNS IP pin"
echo "source_commit=${TEST648_SOURCE_COMMIT:-unknown}"
echo "node=$(node --version)"
echo "bun=$(bun --version)"
echo "date=$(date -Is)"

echo "L0: production agent-node build"
cd /workspace/agent-node
npm run build
test -s dist/cli.js
cd /workspace

echo "L1: lookup callback contract + existing SSRF unit suite"
cd /workspace/agent-node
bun test src/runtime/probe-daemon.test.ts
cd /workspace

echo "L2: stage split-horizon TLS targets"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout /tmp/test648-key.pem -out /tmp/test648-cert.pem \
  -subj "/CN=api.anthropic.com" \
  -addext "subjectAltName=DNS:api.anthropic.com" >/dev/null 2>&1
cp /tmp/test648-cert.pem /usr/local/share/ca-certificates/test648.crt
update-ca-certificates >/dev/null 2>&1
echo "127.0.0.2 api.anthropic.com" >> /etc/hosts
MOCK_BIND=127.0.0.1 MOCK_STATUS=200 MOCK_LOG=/tmp/test648-pinned.log \
  node tests/test648-probe-ip-pin/mock-vendor.mjs >/tmp/test648-pinned.stdout 2>&1 &
pinned_pid=$!
MOCK_BIND=127.0.0.2 MOCK_STATUS=418 MOCK_LOG=/tmp/test648-rebound.log \
  node tests/test648-probe-ip-pin/mock-vendor.mjs >/tmp/test648-rebound.stdout 2>&1 &
rebound_pid=$!
trap 'kill "$pinned_pid" "$rebound_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  grep -q 'listening' /tmp/test648-pinned.log 2>/dev/null \
    && grep -q 'listening' /tmp/test648-rebound.log 2>/dev/null \
    && break
  sleep 0.1
done
grep -q 'listening' /tmp/test648-pinned.log
grep -q 'listening' /tmp/test648-rebound.log

echo "L3a: Node 20 real TLS socket uses pre-validated IP"
bun build tests/test648-probe-ip-pin/runtime-probe.ts --target node --outfile /tmp/test648-runtime-probe.js
NODE_EXTRA_CA_CERTS=/tmp/test648-cert.pem node /tmp/test648-runtime-probe.js

echo "L3b: Bun real TLS socket uses pre-validated IP"
NODE_EXTRA_CA_CERTS=/tmp/test648-cert.pem bun tests/test648-probe-ip-pin/runtime-probe.ts

test "$(grep -c 'request .*status=200 .*sni=api.anthropic.com' /tmp/test648-pinned.log)" -eq 2
test "$(grep -c 'request ' /tmp/test648-rebound.log || true)" -eq 0
echo "PASS: node+bun pinned=2 rebound=0 SNI=api.anthropic.com"

echo "L4 witnessed-red: remove connector lookup"
cp agent-node/src/runtime/probe-daemon.ts /tmp/test648-probe-daemon.ts
sed -i '/lookup: createPinnedLookup(u.hostname, addrs),/d' agent-node/src/runtime/probe-daemon.ts
if grep -Fq 'lookup: createPinnedLookup(u.hostname, addrs),' agent-node/src/runtime/probe-daemon.ts; then
  echo "MUTATION_NOT_APPLIED"
  exit 1
fi
bun build tests/test648-probe-ip-pin/runtime-probe.ts --target node --outfile /tmp/test648-mut-runtime-probe.js
set +e
NODE_EXTRA_CA_CERTS=/tmp/test648-cert.pem node /tmp/test648-mut-runtime-probe.js >/tmp/test648-mutation.log 2>&1
mutation_rc=$?
set -e
cp /tmp/test648-probe-daemon.ts agent-node/src/runtime/probe-daemon.ts
test "$mutation_rc" -ne 0
grep -Fq 'PIN_FAIL' /tmp/test648-mutation.log
grep -q 'request .*status=418 .*sni=api.anthropic.com' /tmp/test648-rebound.log
echo "MUTATION_RED: connector-pin-removed rc=$mutation_rc rebound-hit=1"

echo "L5 restored Node+Bun green"
bun build tests/test648-probe-ip-pin/runtime-probe.ts --target node --outfile /tmp/test648-restored.js
NODE_EXTRA_CA_CERTS=/tmp/test648-cert.pem node /tmp/test648-restored.js
NODE_EXTRA_CA_CERTS=/tmp/test648-cert.pem bun tests/test648-probe-ip-pin/runtime-probe.ts

echo "RESULT: PASS"

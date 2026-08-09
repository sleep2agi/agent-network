#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test625-explicit-env-crlf.txt"
HELPER=/workspace/agent-network/src/claude-vendor-env.ts
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test625 — explicit --env CRLF rejection"
echo "source_commit=${TEST625_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

echo "L0 typecheck + helper contracts + production build"
cd /workspace/agent-network
bun run typecheck
bun test src/claude-vendor-env.test.ts
bun run build >/tmp/test625-build.log
cd /workspace

echo "L1 real Hub + built CLI rejects before profile write"
export HOME=/tmp/test625-home
export COMMHUB_DB=/tmp/test625-hub.db
export PORT=9625
mkdir -p "$HOME" /tmp/test625-project /tmp/test625-bin
cp tests/test625-explicit-env-crlf/fake-agent-node.sh /tmp/test625-bin/agent-node
chmod 0755 /tmp/test625-bin/agent-node
PATH="/tmp/test625-bin:$PATH" bun run server/src/index.ts >/tmp/test625-hub.log 2>&1 &
hub_pid=$!
trap 'kill "$hub_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  if curl -fsS http://127.0.0.1:9625/health >/dev/null; then break; fi
  sleep 0.1
done
curl -fsS http://127.0.0.1:9625/health | grep -Fq '"ok":true'
curl -fsS -X POST http://127.0.0.1:9625/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"anethub"}' | grep -Fq '"ok":true'

ANET=(bun /workspace/agent-network/dist/bin/cli.js)
"${ANET[@]}" login --hub http://127.0.0.1:9625 --username admin --password anethub \
  >/tmp/test625-login.log
cd /tmp/test625-project
unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY
INJECTED_ENV=$'ANTHROPIC_API_KEY=test625-safe\nINJECTED=test625-bad'

set +e
PATH="/tmp/test625-bin:$PATH" "${ANET[@]}" node create rejected-node \
  --runtime claude-agent-sdk --env "$INJECTED_ENV" >/tmp/test625-rejected.log 2>&1
reject_rc=$?
set -e
test "$reject_rc" -ne 0
grep -Fq -- '--env entries cannot contain line breaks' /tmp/test625-rejected.log
! grep -Fq 'test625-bad' /tmp/test625-rejected.log
test ! -e .anet/nodes/rejected-node/config.json
test ! -e .anet/nodes/rejected-node/.env

echo "L2 safe explicit value still creates one env assignment"
PATH="/tmp/test625-bin:$PATH" "${ANET[@]}" node create safe-node \
  --runtime claude-agent-sdk --env 'ANTHROPIC_API_KEY=test625-safe' >/tmp/test625-safe.log
SAFE_ENV=.anet/nodes/safe-node/.env
test -f "$SAFE_ENV"
test "$(stat -c %a "$SAFE_ENV")" = 600
grep -Eq '^ANTHROPIC_API_KEY_[A-Z0-9_]+=test625-safe$' "$SAFE_ENV"
! grep -Fq 'INJECTED=' "$SAFE_ENV"

echo "L3 witnessed-red: removing validation injects a second dotenv line"
cp "$HELPER" /tmp/test625-helper.ts
sed -i 's/if (\/\[\\r\\n\]\/\.test(entry))/if (false \&\& \/[\\r\\n]\/\.test(entry))/' "$HELPER"
grep -Fq 'if (false && /[\r\n]/.test(entry))' "$HELPER"
cd /workspace/agent-network
bun run build >/tmp/test625-mutant-build.log
cd /tmp/test625-project
set +e
PATH="/tmp/test625-bin:$PATH" "${ANET[@]}" node create mutation-node \
  --runtime claude-agent-sdk --env "$INJECTED_ENV" >/tmp/test625-mutant.log 2>&1
mutant_rc=$?
set -e
if [[ "$mutant_rc" -ne 0 ]] || ! grep -Fxq 'INJECTED=test625-bad' .anet/nodes/mutation-node/.env; then
  echo "MUTATION_FALSE_GREEN: explicit-env-crlf"
  sed -n '1,160p' /tmp/test625-mutant.log
  exit 1
fi
echo "MUTATION_RED: explicit-env-crlf rc=1 (injected dotenv line witnessed)"

echo "L4 restored green"
cp /tmp/test625-helper.ts "$HELPER"
cd /workspace/agent-network
bun run build >/tmp/test625-restored-build.log
cd /tmp/test625-project
set +e
PATH="/tmp/test625-bin:$PATH" "${ANET[@]}" node create restored-node \
  --runtime claude-agent-sdk --env "$INJECTED_ENV" >/tmp/test625-restored.log 2>&1
restored_rc=$?
set -e
test "$restored_rc" -ne 0
grep -Fq -- '--env entries cannot contain line breaks' /tmp/test625-restored.log
test ! -e .anet/nodes/restored-node/config.json
test ! -e .anet/nodes/restored-node/.env

echo "RESULT: PASS"

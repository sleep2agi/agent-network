#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test618-claude-vendor-env.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test618 — explicit claude-agent-sdk vendor env persistence"
echo "source_commit=${TEST618_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

echo "L0 typecheck + helper contracts"
cd /workspace/agent-network
bun run typecheck
bun test src/claude-vendor-env.test.ts src/claude-vendor-env-wiring.test.ts
bun run build >/tmp/test618-build.log
cd /workspace

echo "L1 isolated real Hub + built CLI create"
export HOME=/tmp/test618-home
export COMMHUB_DB=/tmp/test618-hub.db
export PORT=9618
mkdir -p "$HOME" /tmp/test618-project /tmp/test618-bin
cp tests/test618-claude-vendor-env/fake-agent-node.sh /tmp/test618-bin/agent-node
chmod 0755 /tmp/test618-bin/agent-node
PATH="/tmp/test618-bin:$PATH" bun run server/src/index.ts >/tmp/test618-hub.log 2>&1 &
hub_pid=$!
trap 'kill "$hub_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  if curl -fsS http://127.0.0.1:9618/health >/dev/null; then break; fi
  sleep 0.1
done
curl -fsS http://127.0.0.1:9618/health | grep -Fq '"ok":true'
curl -fsS -X POST http://127.0.0.1:9618/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"anethub"}' | grep -Fq '"ok":true'

ANET=(bun /workspace/agent-network/dist/bin/cli.js)
"${ANET[@]}" login --hub http://127.0.0.1:9618 --username admin --password anethub \
  >/tmp/test618-login.log
cd /tmp/test618-project
export ANTHROPIC_BASE_URL=https://vendor.invalid/anthropic
export ANTHROPIC_AUTH_TOKEN=test618-not-a-real-secret
PATH="/tmp/test618-bin:$PATH" "${ANET[@]}" node create vendor-node \
  --runtime claude-agent-sdk --model vendor-model >/tmp/test618-create.log

echo "L2 config/envRef/permissions"
CONFIG=.anet/nodes/vendor-node/config.json
DOTENV=.anet/nodes/vendor-node/.env
test -f "$CONFIG"
test -f "$DOTENV"
test "$(stat -c %a "$DOTENV")" = 600
bun -e '
  const c = await Bun.file(process.argv[1]).json();
  if (c.runtime !== "claude-agent-sdk" || c.model !== "vendor-model") process.exit(1);
  if (c.env?.ANTHROPIC_BASE_URL !== "https://vendor.invalid/anthropic") process.exit(2);
  const ref = c.env?.ANTHROPIC_AUTH_TOKEN?._envRef;
  if (typeof ref !== "string" || !ref.startsWith("ANTHROPIC_AUTH_TOKEN_")) process.exit(3);
  if (JSON.stringify(c).includes("test618-not-a-real-secret")) process.exit(4);
' "$CONFIG"
grep -Fq 'test618-not-a-real-secret' "$DOTENV"

echo "L3 fresh-shell start auto-loads vendor env"
unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY
export TEST618_CAPTURE=/tmp/test618-agent-capture
PATH="/tmp/test618-bin:$PATH" "${ANET[@]}" node start vendor-node >/tmp/test618-start.log
grep -Fxq 'vendor-env-loaded' "$TEST618_CAPTURE"

echo "L4 witnessed-red: disconnect create wiring"
cp /workspace/agent-network/bin/cli.ts /tmp/test618-cli.ts
sed -i 's/opts\._envs = collectClaudeVendorEnvForCreate({/const disconnectedVendorEnv = collectClaudeVendorEnvForCreate({/' \
  /workspace/agent-network/bin/cli.ts
grep -Fq 'const disconnectedVendorEnv = collectClaudeVendorEnvForCreate({' \
  /workspace/agent-network/bin/cli.ts
set +e
bun test /workspace/agent-network/src/claude-vendor-env-wiring.test.ts \
  >/tmp/test618-wiring-red.log 2>&1
wiring_rc=$?
set -e
if [[ "$wiring_rc" -eq 0 ]]; then
  echo "MUTATION_FALSE_GREEN: create-vendor-env-wiring"
  exit 1
fi
grep -Fq 'node create captures vendor shell env before profile construction' \
  /tmp/test618-wiring-red.log
echo "MUTATION_RED: create-vendor-env-wiring rc=$wiring_rc"
cp /tmp/test618-cli.ts /workspace/agent-network/bin/cli.ts

echo "L5 restored helper contracts"
bun test /workspace/agent-network/src/claude-vendor-env.test.ts \
  /workspace/agent-network/src/claude-vendor-env-wiring.test.ts

echo "RESULT: PASS"

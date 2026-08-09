#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/repo
TEST="$ROOT/tests/test656-claude-sdk-tool-aliases"
ART=/artifacts
PORT=19400
PASS=0
FAIL=0
mkdir -p "$ART"

ok(){ PASS=$((PASS+1)); printf 'PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }
expect_red(){
  local name="$1"; shift
  if "$@" >"$ART/$name.log" 2>&1; then bad "mutation $name stayed green"; else ok "mutation $name witnessed red"; fi
}

printf 'source_commit=%s\n' "${TEST656_SOURCE_COMMIT:-unknown}"

bun "$TEST/mock-services.ts" >"$ART/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.1; done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null

cd "$ROOT/agent-node"
SDK_VERSION=$(bun -e 'console.log((await Bun.file("node_modules/@anthropic-ai/claude-agent-sdk/package.json").json()).version)')
[[ "$SDK_VERSION" == 0.3.226 ]] && ok "clean install resolved claude-agent-sdk 0.3.226" || bad "unexpected SDK $SDK_VERSION"
bun test src/claude-tool-aliases.test.ts
ok "exact alias unit contract"
./node_modules/.bin/tsc --noEmit --skipLibCheck --moduleResolution bundler --module preserve --target ES2022 "$TEST/sdk-type-probe.ts"
ok "SDK 0.3.226 publishes Options.toolAliases"
bun run build >/dev/null
ok "agent-node bundle builds against SDK 0.3.226"

export ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT"
export ANTHROPIC_API_KEY=test656-fake-key
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
curl -fsS "$ANTHROPIC_BASE_URL/reset" >/dev/null
bun "$TEST/harness.ts" >"$ART/runtime-green.log" 2>&1
ok "real SDK query resolves short alias and executes CommHub send_task"

cp src/claude-tool-aliases.ts /tmp/test656-aliases.orig
sed -i 's/return hasInProcessCommhubServer ? { \.\.\.CLAUDE_COMMHUB_TOOL_ALIASES } : undefined;/return undefined;/' src/claude-tool-aliases.ts
curl -fsS "$ANTHROPIC_BASE_URL/reset" >/dev/null
expect_red alias-injection bun "$TEST/harness.ts"
cp /tmp/test656-aliases.orig src/claude-tool-aliases.ts

cp package.json /tmp/test656-package.orig
bun add --no-save @anthropic-ai/claude-agent-sdk@0.2.141 >/dev/null
OLD_VERSION=$(bun -e 'console.log((await Bun.file("node_modules/@anthropic-ai/claude-agent-sdk/package.json").json()).version)')
[[ "$OLD_VERSION" == 0.2.141 ]] || bad "downgrade mutation did not install 0.2.141"
curl -fsS "$ANTHROPIC_BASE_URL/reset" >/dev/null
expect_red sdk-type-contract ./node_modules/.bin/tsc --noEmit --skipLibCheck --moduleResolution bundler --module preserve --target ES2022 "$TEST/sdk-type-probe.ts"
cp /tmp/test656-package.orig package.json

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]

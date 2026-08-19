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
TYPE_PROBE=.test656-sdk-type-probe.ts
cp "$TEST/sdk-type-probe.ts" "$TYPE_PROBE"
SDK_VERSION=$(bun -e 'console.log((await Bun.file("node_modules/@anthropic-ai/claude-agent-sdk/package.json").json()).version)')
# 🔴 这里原本是**逐字相等** `== 0.3.226`。agent-node/package.json 写的是 `^0.3.226`
#    (caret 范围)，而本套件的 Dockerfile 只拷 package.json、**不拷 package-lock.json**
#    ⇒ `bun install` 每次解析到当时最新的 0.3.x。上游发到 0.3.235 之后这条就红了，
#    而红的原因是**依赖正常前进**，不是契约破了。实测 2026-08-19：FAIL unexpected SDK 0.3.235，
#    其余 7 条(含两条见证红)全绿。
#
#    改成**地板**。放宽它不丢覆盖，因为真正验契约的是下面第 34 行的 tsc 类型探针
#    (`Options.toolAliases` 在不在)，而本套件自己那条 `expect_red sdk-type-contract`
#    ——把 SDK 降到 0.2.141 后 tsc 必须红——**就是「类型探针是承重的」的现成证据**。
#    ⇒ 版本号只是代理指标，类型探针才是判据；代理指标该是地板，判据不动。
MIN_SDK=0.3.226
if [[ "$(printf '%s\n%s\n' "$MIN_SDK" "$SDK_VERSION" | sort -V | head -1)" == "$MIN_SDK" ]]; then
  ok "clean install resolved claude-agent-sdk $SDK_VERSION (>= $MIN_SDK)"
else
  bad "SDK $SDK_VERSION 低于最低要求 $MIN_SDK"
fi
bun test src/claude-tool-aliases.test.ts
ok "exact alias unit contract"
./node_modules/.bin/tsc --noEmit --skipLibCheck --moduleResolution bundler --module preserve --target ES2022 "$TYPE_PROBE"
ok "SDK $SDK_VERSION publishes Options.toolAliases"
bun run build >/dev/null
ok "agent-node bundle builds against SDK $SDK_VERSION"

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
bun "$TEST/harness.ts" >"$ART/sdk-0.2-runtime-observation.log" 2>&1
ok "SDK 0.2.141 runtime pass-through is observed but not a published type contract"
curl -fsS "$ANTHROPIC_BASE_URL/reset" >/dev/null
expect_red sdk-type-contract ./node_modules/.bin/tsc --noEmit --skipLibCheck --moduleResolution bundler --module preserve --target ES2022 "$TYPE_PROBE"
cp /tmp/test656-package.orig package.json
rm -f "$TYPE_PROBE"

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]

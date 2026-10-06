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
# 🔴 harness 必须从 agent-node/ 里跑，不能在 $TEST 原地跑。$TEST(/repo/tests/...)往上
#    没有任何 node_modules，裸导入 `@anthropic-ai/claude-agent-sdk` 会落到 Bun 的
#    auto-install(全局缓存/现场拉 npm)——不是 agent-node 装的那份 SDK。2026-10-06 实测：
#    镜像构建留下的缓存状态下 auto-install 报 `ENOENT while resolving package`，run.sh
#    在「bundle builds」之后 rc=1 且输出全在 /artifacts 里看不到；清空缓存则通过。
#    另外，原地跑时下面「降到 0.2.141」那步的 harness 其实用的仍是 auto-install 的最新版，
#    观察的根本不是 0.2.141。拷进 agent-node/ 后两处都解析到 node_modules 里那一份。
HARNESS=.test656-harness.ts
cp "$TEST/harness.ts" "$HARNESS"
HARNESS_SDK=$(bun -e 'console.log(Bun.resolveSync("@anthropic-ai/claude-agent-sdk", process.cwd() + "/'"$HARNESS"'"))')
case "$HARNESS_SDK" in
  "$ROOT/agent-node/node_modules/@anthropic-ai/claude-agent-sdk/"*) ok "harness resolves SDK from agent-node/node_modules" ;;
  *) bad "harness SDK resolves outside agent-node/node_modules: $HARNESS_SDK" ;;
esac
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
bun "$HARNESS" >"$ART/runtime-green.log" 2>&1
ok "real SDK query resolves short alias and executes CommHub send_task"

cp src/claude-tool-aliases.ts /tmp/test656-aliases.orig
sed -i 's/return hasInProcessCommhubServer ? { \.\.\.CLAUDE_COMMHUB_TOOL_ALIASES } : undefined;/return undefined;/' src/claude-tool-aliases.ts
curl -fsS "$ANTHROPIC_BASE_URL/reset" >/dev/null
expect_red alias-injection bun "$HARNESS"
cp /tmp/test656-aliases.orig src/claude-tool-aliases.ts

cp package.json /tmp/test656-package.orig
bun add --no-save @anthropic-ai/claude-agent-sdk@0.2.141 >/dev/null
OLD_VERSION=$(bun -e 'console.log((await Bun.file("node_modules/@anthropic-ai/claude-agent-sdk/package.json").json()).version)')
[[ "$OLD_VERSION" == 0.2.141 ]] || bad "downgrade mutation did not install 0.2.141"
curl -fsS "$ANTHROPIC_BASE_URL/reset" >/dev/null
# 原先这里是 ok「0.2.141 运行时也能透传 alias」——那是 harness 走 auto-install 跑了最新 SDK
# 得出的假观察。真用 0.2.141 时 alias 不生效(mcpCalls=0)，所以这是一条见证红。
expect_red sdk-0.2-runtime bun "$HARNESS"
curl -fsS "$ANTHROPIC_BASE_URL/reset" >/dev/null
expect_red sdk-type-contract ./node_modules/.bin/tsc --noEmit --skipLibCheck --moduleResolution bundler --module preserve --target ES2022 "$TYPE_PROBE"
cp /tmp/test656-package.orig package.json
rm -f "$TYPE_PROBE" "$HARNESS"

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]

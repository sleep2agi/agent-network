#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/repo
ART=/artifacts
PASS=0
FAIL=0
mkdir -p "$ART"

ok(){ PASS=$((PASS+1)); printf 'PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }
expect_red(){
  local name="$1"; shift
  if "$@" >"$ART/$name.log" 2>&1; then bad "mutation $name stayed green"; else ok "mutation $name witnessed red"; fi
}

printf 'source_commit=%s\n' "${TEST657_SOURCE_COMMIT:-unknown}"
cd "$ROOT/agent-node"

bun test src/runtime/claude-native-binary.test.ts
ok "fallback unit contract"

INSTALLED=$(bun -e 'console.log((await Bun.file("node_modules/@anthropic-ai/claude-agent-sdk/package.json").json()).version)')
RESOLVED=$(bun -e 'import { resolveInstalledClaudeSdkVersion } from "./src/runtime/claude-native-binary.ts"; console.log(resolveInstalledClaudeSdkVersion())')
[[ "$INSTALLED" == "$RESOLVED" ]] && ok "resolver matches real installed SDK $INSTALLED" || bad "resolver=$RESOLVED installed=$INSTALLED"

bun run build >/dev/null
ok "agent-node bundle builds with pinned fallback"

cp src/runtime/claude-native-binary.ts /tmp/test657-native.orig
sed -i 's/return `${CLAUDE_LINUX_X64_PACKAGE}@${version}`;/return CLAUDE_LINUX_X64_PACKAGE;/' src/runtime/claude-native-binary.ts
grep -F 'return CLAUDE_LINUX_X64_PACKAGE;' src/runtime/claude-native-binary.ts >/dev/null
expect_red unpin-native-version bun test src/runtime/claude-native-binary.test.ts
cp /tmp/test657-native.orig src/runtime/claude-native-binary.ts

sed -i 's/const sdkVersion = resolveInstalledClaudeSdkVersion(deps);/const sdkVersion = "latest";/' src/runtime/claude-native-binary.ts
grep -F 'const sdkVersion = "latest";' src/runtime/claude-native-binary.ts >/dev/null
expect_red bypass-installed-version bun test src/runtime/claude-native-binary.test.ts
cp /tmp/test657-native.orig src/runtime/claude-native-binary.ts

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]

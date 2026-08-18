#!/usr/bin/env bash
set -euo pipefail
source tests/lib/safe-rm.sh

SOURCE_COMMIT=${TEST813_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: TEST813_SOURCE_COMMIT must be one full lowercase Git SHA" >&2
  exit 1
}

probe() {
  bun tests/test813-grok-mcp-readiness/probe.ts
}

expect_red() {
  local name=$1 expected=$2
  shift 2
  local log="/tmp/test813-${name}.log"
  cp agent-network/src/node-server.ts /tmp/test813-node-server.orig
  cp agent-node/src/runtime/grok-build-cli-home.ts /tmp/test813-home.orig
  "$@"
  # 🔴 变异必须真的改到东西。一条 sed 模式过期之后是**静默**的：它退出 0、
  #    什么都没改，探针照常 PASS，于是打印出来的是「mutation survived」——
  #    读起来像「产品没拦住」，实际是「根本没变异」。这两种结论指向完全不同的下一步
  #    （去改产品 vs 去改测试），所以必须分开报。
  if cmp -s agent-network/src/node-server.ts /tmp/test813-node-server.orig \
     && cmp -s agent-node/src/runtime/grok-build-cli-home.ts /tmp/test813-home.orig; then
    echo "FAIL: mutation was a no-op: $name —— 两个源文件都没被改动，" >&2
    echo "      说明 sed 模式已经和源码对不上了（不是产品没拦住）。" >&2
    exit 1
  fi
  if probe >"$log" 2>&1; then
    echo "FAIL: mutation survived: $name" >&2
    cat "$log" >&2
    exit 1
  fi
  grep -Fq "$expected" "$log" || {
    echo "FAIL: mutation $name died for the wrong reason" >&2
    cat "$log" >&2
    exit 1
  }
  cp /tmp/test813-node-server.orig agent-network/src/node-server.ts
  cp /tmp/test813-home.orig agent-node/src/runtime/grok-build-cli-home.ts
  echo "MUTATION_RED $name"
}

probe

# 🔴 2026-08-18：这条变异从写下起就是空的。原模式要求整行只有 `"commhub_upload_file",`，
#    而真实那行是 `      name: "commhub_upload_file",`（对象字面量的字段），命中 0。
#    套件当时不在任何 CI 里，所以没人见过它红 —— 接进 CI 的第一次运行就是它现形的时刻。
#    删整行会破坏对象字面量语法，所以改名而不是删行。
expect_red upload-tool-removed TOOL_SET_MISMATCH \
  sed -i 's/name: "commhub_upload_file"/name: "commhub_upload_file_MUT"/' agent-network/src/node-server.ts

expect_red stale-three-tool-doctor 'readiness failed: 3 tools discovered' \
  sed -i 's/"4 tools discovered"/"3 tools discovered"/' agent-node/src/runtime/grok-build-cli-home.ts

probe

bash tests/test813-grok-mcp-readiness/product-path.sh all

# A stack trace from minified dist/cli.js contains source string literals.
# The product gate must recognize a timestamped runtime log event, not merely
# find `TUI ready session=` anywhere in a failed stack dump.
cp tests/test813-grok-mcp-readiness/fake-grok.mjs /tmp/test813-fake-grok.orig
doctor_target='          { label: "4 tools discovered", passed: toolNames.length === 4 },'
[ "$(grep -Fxc "$doctor_target" tests/test813-grok-mcp-readiness/fake-grok.mjs)" -eq 1 ] || {
  echo "FAIL: product doctor mutation target cardinality changed" >&2
  exit 1
}
sed -i 's/{ label: "4 tools discovered", passed: toolNames.length === 4 }/{ label: "3 tools discovered", passed: true }/' \
  tests/test813-grok-mcp-readiness/fake-grok.mjs
if bash tests/test813-grok-mcp-readiness/product-path.sh recovery >/tmp/test813-product-doctor-mutation.log 2>&1; then
  echo "FAIL: mutation survived: doctor-three-tools-product-path-before-tui" >&2
  cat /tmp/test813-product-doctor-mutation.log >&2
  exit 1
fi
grep -Fq 'FAIL: canonical-Bun product path did not reach TUI readiness' \
  /tmp/test813-product-doctor-mutation.log || {
    echo "FAIL: product doctor mutation did not die at the anchored TUI readiness gate" >&2
    cat /tmp/test813-product-doctor-mutation.log >&2
    exit 1
  }
grep -Fq 'GrokCopresenceFailure: grok copresence pre-spawn audit failed: grok copresence CommHub MCP readiness failed: 4 tools discovered' \
  /tmp/test813-product-doctor-mutation.log || {
    echo "FAIL: product doctor mutation died for the wrong reason" >&2
    cat /tmp/test813-product-doctor-mutation.log >&2
    exit 1
  }
cp /tmp/test813-fake-grok.orig tests/test813-grok-mcp-readiness/fake-grok.mjs
echo "MUTATION_RED doctor-three-tools-product-path-before-tui"

cp agent-node/src/cli.ts /tmp/test813-cli.orig
target='process.env.BUN_BIN || "bun",'
[ "$(grep -Fc "$target" agent-node/src/cli.ts)" -eq 1 ] || {
  echo "FAIL: product-path mutation target cardinality changed" >&2
  exit 1
}
sed -i 's/process\.env\.BUN_BIN || "bun",/"\/usr\/local\/bin\/bun",/' agent-node/src/cli.ts
grep -Fq '"/usr/local/bin/bun",' agent-node/src/cli.ts || {
  echo "FAIL: product-path mutation did not change production source" >&2
  exit 1
}
if bash tests/test813-grok-mcp-readiness/product-path.sh negative >/tmp/test813-product-mutation.log 2>&1; then
  echo "FAIL: mutation survived: bun-resolver-bypassed" >&2
  cat /tmp/test813-product-mutation.log >&2
  exit 1
fi
grep -Fq 'NEGATIVE_RUNTIME_GATE_NOT_REACHED' /tmp/test813-product-mutation.log || {
  echo "FAIL: product-path mutation died for the wrong reason" >&2
  cat /tmp/test813-product-mutation.log >&2
  exit 1
}
cp /tmp/test813-cli.orig agent-node/src/cli.ts
echo "MUTATION_RED bun-resolver-bypassed"

bash tests/test813-grok-mcp-readiness/product-path.sh all

if [ "${RUN_VENDOR_GROK:-0}" = 1 ]; then
  real_bin=${TEST813_REAL_GROK_BIN:-/host-grok/grok-0.2.93}
  [ -x "$real_bin" ] || {
    echo "FAIL: pinned Grok binary is not executable: $real_bin" >&2
    exit 1
  }
  [[ "$("$real_bin" --version)" =~ ^grok\ 0\.2\.93\ \(f00f96316d\)(\ \[stable\])?$ ]] || {
    echo "FAIL: vendor doctor requires exact Grok 0.2.93" >&2
    exit 1
  }
  vendor_root=$(mktemp -d /tmp/test813-vendor.XXXXXX)
  chmod 700 "$vendor_root"
  printf '%s\n' \
    'COMMHUB_URL=http://127.0.0.1:9' \
    'COMMHUB_TOKEN=fixture-token' >"$vendor_root/commhub.env"
  chmod 600 "$vendor_root/commhub.env"
  printf '%s\n' \
    '[mcp_servers.commhub]' \
    'command = "/usr/local/bin/bun"' \
    'args = ["/workspace/agent-network/src/node-server.ts"]' \
    "env = { ANET_COMMHUB_ENV_FILE = \"$vendor_root/commhub.env\", ANET_COMMHUB_MODE = \"outbound-only\", COMMHUB_ALIAS = \"test813-dog\", COMMHUB_RESUME_ID = \"test813-resume\" }" \
    'enabled = true' >"$vendor_root/config.toml"
  chmod 600 "$vendor_root/config.toml"
  vendor_report="$vendor_root/doctor.json"
  if ! env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME="$vendor_root" GROK_HOME="$vendor_root" GROK_AUTH_PATH="$vendor_root/auth.json" \
    "$real_bin" mcp doctor commhub --json >"$vendor_report" 2>"$vendor_root/doctor.stderr"; then
    echo "FAIL: real Grok vendor doctor failed" >&2
    sed -n '1,80p' "$vendor_root/doctor.stderr" >&2
    exit 1
  fi
  bun tests/test813-grok-mcp-readiness/validate-vendor-doctor.ts "$vendor_report"
  safe_rm_rf "$vendor_root"
fi

echo "RESULT: PASS source_commit=$SOURCE_COMMIT"

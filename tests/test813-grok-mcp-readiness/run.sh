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

expect_red upload-tool-removed TOOL_SET_MISMATCH \
  sed -i '/^[[:space:]]*"commhub_upload_file",[[:space:]]*$/d' agent-network/src/node-server.ts

expect_red stale-three-tool-doctor 'readiness failed: 3 tools discovered' \
  sed -i 's/"4 tools discovered"/"3 tools discovered"/' agent-node/src/runtime/grok-build-cli-home.ts

probe

bash tests/test813-grok-mcp-readiness/product-path.sh all

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

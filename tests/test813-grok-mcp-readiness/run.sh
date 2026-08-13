#!/usr/bin/env bash
set -euo pipefail

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
echo "RESULT: PASS source_commit=$SOURCE_COMMIT"

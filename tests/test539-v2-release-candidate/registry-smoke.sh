#!/usr/bin/env bash
set -euo pipefail
test "$TEST_SOURCE_COMMIT" = "${EXPECTED_TEST_SOURCE_COMMIT:?}"
[[ "$TEST_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]
echo "Registry artifact install probe; harness=$TEST_SOURCE_COMMIT"
test ! -e /workspace
test ! -e /opt/node_modules
test -z "${NODE_PATH:-}"
sha256sum /registry-tarballs/*.tgz
node /test539/install-probe.mjs package
test "$(anet --version | sed -n '1p')" = 'anet v2.3.0-preview.162'
agent-node --help > /tmp/test539-runtime-help.txt
grep -q opencode-cli /tmp/test539-runtime-help.txt
grep -q codex-app-server /tmp/test539-runtime-help.txt
commhub-server --help > /tmp/test539-hub-help.txt
grep -q 'CommHub MCP Server' /tmp/test539-hub-help.txt
case_dir=$(mktemp -d /tmp/test539-registry.XXXXXX)
mkdir -m 700 "$case_dir/home"
HOME="$case_dir/home" COMMHUB_AUTH_TOKEN=test539-isolated-bootstrap \
  commhub-server --host 127.0.0.1 --port 9253 --db "$case_dir/hub.db" \
  > "$case_dir/hub.log" 2>&1 &
hub_pid=$!
trap 'kill "$hub_pid" 2>/dev/null || true; wait "$hub_pid" 2>/dev/null || true' EXIT
node /test539/install-probe.mjs health
TEST539_DB="$case_dir/hub.db" bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.TEST539_DB, { readonly: true }); if (!db.query("PRAGMA table_info(node_create_requests)").all().some(row => row.name === "launch_verified_at")) throw new Error("published Hub did not migrate launch proof column"); db.close(); console.log("PASS installed Hub really migrated launch_verified_at");'
echo 'PASS registry-installed identity, binaries, Hub health/auth refusal and migration; not native V2 E2E'

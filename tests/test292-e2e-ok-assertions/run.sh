#!/usr/bin/env bash
set -euo pipefail

ROOT=/src
source "$ROOT/tests/lib/safe-rm.sh"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }

DIRECT_TRUE='{"ok":true,"message_id":"m1"}'
DIRECT_FALSE='{"ok":false,"error":"alias_not_found"}'
SSE_TRUE='data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"ok\":true,\"message_id\":\"m2\"}"}]}}'
SSE_FALSE='data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"ok\":false,\"error\":\"permission_denied\"}"}]}}'
PLAIN_MCP_TRUE='{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"ok\":true}"}]}}'
RPC_ERROR='data: {"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"Invalid arguments"}}'

if printf '%s\n' "$SSE_FALSE" | grep -q 'ok'; then
  echo "WITNESSED_RED: legacy grep accepts an inner ok:false MCP response"
else
  fail "legacy witnessed-red fixture did not exercise the old assertion"
fi

WEAK_COUNT=$(python3 - "$ROOT/tests/docker-e2e.sh" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text()
print(sum(bool(re.search(r"grep -q ['\"]ok['\"]", line)) for line in text.splitlines()))
PY
)
echo "weak_assertions=$WEAK_COUNT"

if [[ ! -f "$ROOT/tests/lib/response-json.sh" ]]; then
  fail "structured response parser is missing"
  fail "docker-e2e still has $WEAK_COUNT weak grep-ok assertions"
  echo "RESULT: $PASS passed, $FAIL failed"
  echo "source_commit=${TEST292_SOURCE_COMMIT}"
  exit 1
fi
source "$ROOT/tests/lib/response-json.sh"

expect_ok() {
  local name=$1 payload=$2
  if response_json_ok "$payload"; then pass "$name"; else fail "$name"; fi
}

expect_not_ok() {
  local name=$1 payload=$2
  if response_json_ok "$payload"; then fail "$name"; else pass "$name"; fi
}

expect_ok "direct REST ok:true" "$DIRECT_TRUE"
expect_not_ok "direct REST ok:false" "$DIRECT_FALSE"
expect_ok "SSE-wrapped MCP inner ok:true" "$SSE_TRUE"
expect_not_ok "SSE-wrapped MCP inner ok:false" "$SSE_FALSE"
expect_ok "plain JSON-RPC MCP inner ok:true" "$PLAIN_MCP_TRUE"
expect_not_ok "JSON-RPC error is not success" "$RPC_ERROR"
expect_not_ok "malformed response fails closed" 'not-json ok'
expect_not_ok "empty response fails closed" ''

if [[ "$WEAK_COUNT" == "0" ]]; then
  pass "docker-e2e has no weak grep-ok assertions"
else
  fail "docker-e2e still has $WEAK_COUNT weak grep-ok assertions"
fi

ROBUST_CALLS=$(grep -c 'response_json_ok "\$' "$ROOT/tests/docker-e2e.sh" || true)
if [[ "$ROBUST_CALLS" == "16" ]]; then
  pass "all 16 legacy success assertions use the structured parser"
else
  fail "expected 16 structured response assertions, got $ROBUST_CALLS"
fi

MUT=$(mktemp -d /tmp/test292-mut.XXXXXX)
trap 'safe_rm_rf "$MUT"' EXIT
cp "$ROOT/tests/lib/response-json.sh" "$MUT/response-json.sh"
sed -i 's/value is True/value is not None/' "$MUT/response-json.sh"
set +e
bash -c 'source "$1"; response_json_ok "$2"' _ "$MUT/response-json.sh" "$SSE_FALSE"
MUT_RC=$?
set -e
if [[ "$MUT_RC" -ne 0 ]]; then
  pass "mutation: weakening exact true check turns red"
else
  fail "mutation: weakened parser accepted ok:false"
fi

echo "RESULT: $PASS passed, $FAIL failed"
echo "source_commit=${TEST292_SOURCE_COMMIT}"
[[ "$FAIL" -eq 0 ]]

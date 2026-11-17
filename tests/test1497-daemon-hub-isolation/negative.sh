#!/usr/bin/env bash
# Run only after the positive suite passes. image is built with RUNTIME_VERSION=.209.
set -euo pipefail
image="${1:-anet3627-npm209}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
set +e
docker run --rm --network none --init -e RFC044_CLOUD_CONFIG_CASE=different-hub --entrypoint bun "$image" tests/test-rfc044-windows-daemon/smoke.ts >"$log" 2>&1
rc=$?
set -e
cat "$log"
test "$rc" -eq 1
grep -F '[first-agent] 已注册到 CommHub' "$log"
grep -F 'AssertionError: user global config bytes must not change' "$log"
echo 'NEGATIVE_CONTROL_PASS: real published .209 registered its child, then changed user config'

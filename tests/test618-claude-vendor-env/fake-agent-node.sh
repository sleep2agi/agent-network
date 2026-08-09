#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--version" ]]; then
  echo "agent-node v2.5.0-preview.30"
  exit 0
fi
if [[ "${1:-}" == "--help" ]]; then
  echo "agent-node --config --alias --runtime"
  exit 0
fi

[[ "${ANTHROPIC_BASE_URL:-}" == "https://vendor.invalid/anthropic" ]]
[[ "${ANTHROPIC_AUTH_TOKEN:-}" == "test618-not-a-real-secret" ]]
[[ -n "${TEST618_CAPTURE:-}" ]]
printf 'vendor-env-loaded\n' > "$TEST618_CAPTURE"

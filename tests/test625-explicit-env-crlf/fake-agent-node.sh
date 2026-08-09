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
exit 0

#!/usr/bin/env bash
set -euo pipefail

if [[ ! "${SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FAIL: SOURCE_COMMIT must bind the image to an exact git revision" >&2
  exit 1
fi
echo "SOURCE_COMMIT=$SOURCE_COMMIT"

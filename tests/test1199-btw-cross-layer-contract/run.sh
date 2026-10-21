#!/usr/bin/env bash
set -euo pipefail

[[ "${SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
echo "source_commit=$SOURCE_COMMIT"

cd /app
sha256sum -c tests/test1199-btw-cross-layer-contract/app-fixtures.sha256
cd server
bun test ../tests/test1199-btw-cross-layer-contract/journey.test.ts

echo "PASS test1199 BTW cross-layer contract, isolation, recovery, attachments, bring-back and fixture drift"

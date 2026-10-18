#!/usr/bin/env bash
set -euo pipefail

cd /app
sha256sum -c tests/test1199-btw-cross-layer-contract/app-fixtures.sha256
cd server
bun test ../tests/test1199-btw-cross-layer-contract/journey.test.ts

echo "PASS test1199 BTW cross-layer contract, isolation, recovery, attachments, bring-back and fixture drift"

#!/usr/bin/env bash
set -euo pipefail

cd /app/server
COMMHUB_DB="/tmp/desktop-user-push-$$.db" \
  bun test src/observer-push.test.ts src/desktop-message.test.ts src/observer-avatar-http.test.ts

cd /app/prototype/anet-client-app
npm run build

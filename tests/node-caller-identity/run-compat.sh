#!/usr/bin/env bash
set -euo pipefail
test -f /.dockerenv
if [[ "${PORT:-}" == "9200" ]]; then
  echo "refusing port 9200" >&2
  exit 1
fi
unset DATABASE_URL COMMHUB_TEST_PG_URL COMMHUB_TOKEN COMMHUB_AUTH_TOKEN
export PORT=9391
export HOST=127.0.0.1
export HOME=/tmp/compat679-root
export COMMHUB_DB=/tmp/compat679/hub.db
export COMMHUB_UPLOADS_DIR=/tmp/compat679/uploads
mkdir -p "$HOME" /tmp/compat679/uploads
cd /work/server
exec bun /work/tests/node-caller-identity/compat.ts
